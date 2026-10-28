// FTB Project Hub API (Cloudflare Worker).
// Serves the static site from /public and a small JSON API:
//   GET  /api/hub                     -> hub document (projects, sections, links, viewers)
//   PUT  /api/hub                     -> replace hub document
//   GET  /api/orders                  -> shop orders (stored one KV key each, read from one combined copy; see orders.js)
//   PUT  /api/orders/:id
//   DELETE /api/orders/:id
//   GET  /api/ticktick/connect | /callback | /status, POST /api/ticktick/sync -> TickTick "CNC HUB" list feeds CNC orders (see ticktick.js)
//   GET/PUT /api/me                   -> who's signed in (Cloudflare Access) and their display name (see auth.js)
//   GET/POST/DELETE /api/comments     -> comments on project items (see comments.js)
//   GET/POST/DELETE /api/photos       -> job photos in R2, per project, plus the Gallery (see photos.js)
//   GET  /api/viewer-token            -> short-lived APS token, viewables:read only
//   POST /api/models/upload           -> { fileName } => signed S3 URL for a direct browser upload
//   POST /api/models/complete         -> { objectKey, uploadKey } => finalize upload + start translation, returns { urn }
//   GET  /api/models/:urn/status      -> translation progress
//   GET  /api/models/:urn/thumbnail   -> PNG thumbnail
//   GET  /api/models/:urn/steps       -> assembly steps JSON (written by the Rhino plugin)
//   PUT  /api/models/:urn/steps
//   GET  /api/models/:urn/download    -> redirect to a short-lived link for the original uploaded file
//   GET/POST/DELETE /api/models/:urn/markups -> markups drawn in the viewer (see markups.js)
//
// Site access is gated by Cloudflare Access in front of the Worker. Most routes trust every request they receive;
// comments check the signed Access token so each one is tied to a real person.

import seed from "../data/seed.json";
import additions from "../data/additions.json";
import { ticktickRoute, syncTicktick } from "./ticktick.js";
import { meRoute } from "./auth.js";
import { commentsRoute } from "./comments.js";
import { photosRoute } from "./photos.js";
import { markupsRoute } from "./markups.js";
import { listOrders, putOrder, deleteOrder } from "./orders.js";

// One-time changes to the live hub document, applied on the next read and remembered in hub.migrations.
const MIGRATIONS = [
  { id: "resources-to-overview", run: hub => {   // 2026-10-27: Ben renamed "Resources + Files" cards to "Overview"
    for (const p of hub.projects) for (const s of p.sections || []) if (/^resources\s*(\+|&|and)\s*files$/i.test(s.title || "")) s.title = "Overview";
  } },
  { id: "leo-tabletop-model-to-overview", run: hub => {   // 2026-10-28: Ben moved the big tabletop model up to Overview
    const p = hub.projects.find(x => x.id === "leo-dioramas");
    const overview = p?.sections?.find(s => /^overview$/i.test(s.title || ""));
    const top = p?.sections?.find(s => s.id === "leo-tabletop" || /laminate tabletop/i.test(s.title || ""));
    const moving = (top?.viewers || []).filter(v => v.urn);
    if (!overview || !moving.length) return;
    overview.viewers = moving;   // replaces the viewer Overview had
    top.viewers = [...top.viewers.filter(v => !v.urn), ...(top.viewers.some(v => !v.urn) ? [] : [{ label: top.title }])];
  } },
];

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
  // Cron trigger (wrangler.toml): pull the TickTick CNC list every few minutes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncTicktick(env));
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname.startsWith("/api/ticktick/")) {
    const res = await ticktickRoute(request, env, url);
    if (res) return res;
  }

  if (pathname === "/api/me") {
    const res = await meRoute(request, env);
    if (res) return res;
  }
  if (pathname.startsWith("/api/comments")) {
    const res = await commentsRoute(request, env, url);
    if (res) return res;
  }

  if (pathname.startsWith("/api/photos") || pathname === "/api/refs") {
    const res = await photosRoute(request, env, url);
    if (res) return res;
  }

  if (pathname === "/api/hub" && method === "GET") {
    // First run: start from the projects imported from start.me.
    const hub = (await env.HUB.get(HUB_KEY, "json")) || structuredClone(seed);
    // Projects added from chat (data/additions.json) go in once each; hub.addedIds remembers which.
    const added = (hub.addedIds ||= []);
    const fresh = additions.projects.filter(p => !added.includes(p.id));
    const done = (hub.migrations ||= []);
    const todo = MIGRATIONS.filter(m => !done.includes(m.id));
    if (fresh.length || todo.length) {
      for (const p of fresh) {
        if (!hub.projects.some(x => x.id === p.id)) hub.projects.push(structuredClone(p));
        added.push(p.id);
      }
      for (const m of todo) { m.run(hub); done.push(m.id); }
      hub.updatedAt = new Date().toISOString();
      await env.HUB.put(HUB_KEY, JSON.stringify(hub));
    }
    return json(hub);
  }
  if (pathname === "/api/hub" && method === "PUT") {
    const hub = await request.json();
    if (!Array.isArray(hub?.projects)) throw httpError(400, "hub.projects must be an array");
    hub.updatedAt = new Date().toISOString();
    await env.HUB.put(HUB_KEY, JSON.stringify(hub));
    return json({ ok: true, updatedAt: hub.updatedAt });
  }

  if (pathname === "/api/orders" && method === "GET") {
    return json({ orders: await listOrders(env) });
  }
  const om = pathname.match(/^\/api\/orders\/([\w-]+)$/);
  if (om && method === "PUT") {
    const order = await request.json();
    if (!order?.title) throw httpError(400, "order.title required");
    order.id = om[1];
    await putOrder(env, order);
    return json({ ok: true });
  }
  if (om && method === "DELETE") {
    await deleteOrder(env, om[1]);
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

  const mk = pathname.match(/^\/api\/models\/([\w-]{1,300})\/markups(?:\/([\w-]{1,80}))?$/);
  if (mk) {
    const res = await markupsRoute(request, env, mk[1], mk[2]);
    if (res) return res;
  }

  const m = pathname.match(/^\/api\/models\/([\w-]+)\/(status|thumbnail|steps|download)$/);
  if (m) {
    const [, urn, action] = m;
    if (action === "status") {
      const manifest = await aps(env, `/modelderivative/v2/designdata/${urn}/manifest`, { allow404: true });
      if (!manifest) return json({ status: "missing", progress: "0%" });
      // On failure, pass Autodesk's own error text along so the hub can show why.
      const errors = [];
      const walk = n => { for (const msg of n.messages || []) if (msg.type === "error") errors.push([].concat(msg.message).join(" ")); (n.children || n.derivatives || []).forEach(walk); };
      walk(manifest);
      return json({ status: manifest.status, progress: manifest.progress, error: errors[0] || undefined });
    }
    if (action === "thumbnail") {
      // Thumbnails need data:read; a viewables:read token gets refused.
      const { access_token } = await apsToken(env, INTERNAL_SCOPE);
      const res = await fetch(`${APS}/modelderivative/v2/designdata/${urn}/thumbnail?width=400&height=400`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "Content-Type": "image/png", "Cache-Control": res.ok ? "public, max-age=86400" : "no-store" },
      });
    }
    if (action === "download") {
      // The original upload stays in our persistent bucket; hand out a signed link that expires shortly.
      const objectId = fromUrn(urn);
      const prefix = `urn:adsk.objects:os.object:${env.APS_BUCKET}/`;
      if (!objectId.startsWith(prefix)) throw httpError(404, "That model isn't in FTB storage");
      const objectKey = objectId.slice(prefix.length);
      const name = (url.searchParams.get("name") || objectKey.replace(/^\d+-/, "")).replace(/["\\\r\n]/g, "");
      const res = await aps(env, `/oss/v2/buckets/${env.APS_BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3download?minutesExpiration=10` +
        `&response-content-disposition=${encodeURIComponent(`attachment; filename="${name}"`)}`);
      if (!res.url) throw httpError(502, "Autodesk didn't return a download link");
      return Response.redirect(res.url, 302);
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

function fromUrn(urn) {
  try { return atob(urn.replace(/-/g, "+").replace(/_/g, "/")); } catch { return ""; }
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
