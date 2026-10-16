// FTB Project Hub API (Cloudflare Worker).
// Serves the static site from /public and a small JSON API:
//   GET  /api/hub                     -> hub document (projects, sections, links, viewers)
//   PUT  /api/hub                     -> replace hub document
//   GET  /api/orders                  -> shop pickup orders (one KV key each, so people updating at once don't clobber each other)
//   PUT  /api/orders/:id
//   DELETE /api/orders/:id
//   GET  /api/viewer-token            -> short-lived APS token, viewables:read only
//   POST /api/models/upload           -> { fileName } => signed S3 URL for a direct browser upload
//   POST /api/models/complete         -> { objectKey, uploadKey } => finalize upload + start translation, returns { urn }
//   GET  /api/models/:urn/status      -> translation progress
//   GET  /api/models/:urn/thumbnail   -> PNG thumbnail
//   GET  /api/models/:urn/steps       -> assembly steps JSON (written by the Rhino plugin)
//   PUT  /api/models/:urn/steps
//
// Site access is gated by Cloudflare Access in front of the Worker, so the API trusts every request it receives.

import seed from "../data/seed.json";

const APS = "https://developer.api.autodesk.com";
const HUB_KEY = "hub";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/hub" && method === "GET") {
    const hub = await env.HUB.get(HUB_KEY, "json");
    // First run: start from the projects imported from start.me.
    return json(hub || seed);
  }
  if (pathname === "/api/hub" && method === "PUT") {
    const hub = await request.json();
    if (!Array.isArray(hub?.projects)) throw httpError(400, "hub.projects must be an array");
    hub.updatedAt = new Date().toISOString();
    await env.HUB.put(HUB_KEY, JSON.stringify(hub));
    return json({ ok: true, updatedAt: hub.updatedAt });
  }

  if (pathname === "/api/orders" && method === "GET") {
    const keys = [];
    let cursor;
    do {
      const page = await env.HUB.list({ prefix: "order:", cursor });
      keys.push(...page.keys.map(k => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const orders = (await Promise.all(keys.map(k => env.HUB.get(k, "json")))).filter(Boolean);
    return json({ orders });
  }
  const om = pathname.match(/^\/api\/orders\/([\w-]+)$/);
  if (om && method === "PUT") {
    const order = await request.json();
    if (!order?.title) throw httpError(400, "order.title required");
    order.id = om[1];
    // Orders that have left the shop clear themselves out after 30 days.
    const opts = order.status === "out" ? { expirationTtl: 60 * 60 * 24 * 30 } : {};
    await env.HUB.put(`order:${om[1]}`, JSON.stringify(order), opts);
    return json({ ok: true });
  }
  if (om && method === "DELETE") {
    await env.HUB.delete(`order:${om[1]}`);
    return json({ ok: true });
  }

  if (pathname === "/api/viewer-token" && method === "GET") {
    const { access_token, expires_in } = await apsToken(env, "viewables:read");
    return json({ access_token, expires_in });
  }

  if (pathname === "/api/models/upload" && method === "POST") {
    const { fileName } = await request.json();
    if (!fileName) throw httpError(400, "fileName required");
    await ensureBucket(env);
    const objectKey = `${Date.now()}-${fileName.replace(/[^\w.\-]+/g, "_")}`;
    const res = await aps(env, `/oss/v2/buckets/${env.APS_BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=60`);
    return json({ objectKey, uploadKey: res.uploadKey, url: res.urls[0] });
  }

  if (pathname === "/api/models/complete" && method === "POST") {
    const { objectKey, uploadKey } = await request.json();
    const obj = await aps(env, `/oss/v2/buckets/${env.APS_BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, {
      method: "POST",
      body: { uploadKey },
    });
    const urn = toUrn(obj.objectId);
    await translate(env, urn);
    return json({ urn, objectKey });
  }

  const m = pathname.match(/^\/api\/models\/([\w-]+)\/(status|thumbnail|steps)$/);
  if (m) {
    const [, urn, action] = m;
    if (action === "status") {
      const manifest = await aps(env, `/modelderivative/v2/designdata/${urn}/manifest`, { allow404: true });
      if (!manifest) return json({ status: "missing", progress: "0%" });
      return json({ status: manifest.status, progress: manifest.progress });
    }
    if (action === "thumbnail") {
      const { access_token } = await apsToken(env, "viewables:read");
      const res = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }
    if (action === "steps" && method === "GET") {
      const steps = await env.HUB.get(`steps:${urn}`, "json");
      return json(steps || { steps: [] });
    }
    if (action === "steps" && method === "PUT") {
      const steps = await request.json();
      await env.HUB.put(`steps:${urn}`, JSON.stringify(steps));
      return json({ ok: true });
    }
  }

  throw httpError(404, `No route for ${method} ${pathname}`);
}

// --- APS helpers ---------------------------------------------------------

// Tokens are cached per scope for the life of the isolate.
const tokenCache = new Map();

async function apsToken(env, scope) {
  const cached = tokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${APS}/authentication/v2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!res.ok) throw httpError(502, `APS auth failed: ${res.status} ${await res.text()}`);
  const token = await res.json();
  tokenCache.set(scope, { token, expiresAt: Date.now() + token.expires_in * 1000 });
  return token;
}

const INTERNAL_SCOPE = "data:read data:write data:create bucket:read bucket:create";

async function aps(env, path, { method = "GET", body, allow404 = false, headers = {} } = {}) {
  const { access_token } = await apsToken(env, INTERNAL_SCOPE);
  const res = await fetch(APS + path, {
    method,
    headers: {
      Authorization: `Bearer ${access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw httpError(502, `APS ${method} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// The bucket is created once with the "persistent" policy: objects stay until we delete them.
let bucketReady = false;
async function ensureBucket(env) {
  if (bucketReady) return;
  const existing = await aps(env, `/oss/v2/buckets/${env.APS_BUCKET}/details`, { allow404: true });
  if (!existing) {
    await aps(env, "/oss/v2/buckets", {
      method: "POST",
      body: { bucketKey: env.APS_BUCKET, policyKey: "persistent" },
    });
  } else if (existing.policyKey !== "persistent") {
    throw httpError(500, `Bucket ${env.APS_BUCKET} has policy "${existing.policyKey}", expected "persistent"`);
  }
  bucketReady = true;
}

async function translate(env, urn) {
  return aps(env, "/modelderivative/v2/designdata/job", {
    method: "POST",
    headers: { "x-ads-force": "true" },
    body: {
      input: { urn },
      output: { formats: [{ type: "svf2", views: ["2d", "3d"] }] },
    },
  });
}

// APS URNs are the object id, base64url-encoded without padding.
function toUrn(objectId) {
  return btoa(objectId).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
