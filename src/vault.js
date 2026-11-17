// Ben's private 3D vault: a gallery of models that only he can open, each with an optional public view-only link.
// The page lives at /vault (no link to it anywhere in the hub). Every vault route checks the signed-in
// Cloudflare Access email against the owner:
//   - VAULT_OWNER (a Worker Secret holding the owner's email), if set;
//   - otherwise the first signed-in person to open /vault claims it (KV vault:owner).
//
// Models come in two ways:
//   - "upload": a file (.3dm, .skp, .obj, .stl, .glb, zip…) uploaded through the same Autodesk path as the hub
//     (/api/models/upload + /complete), so it lands in the persistent bucket and opens in the Autodesk viewer;
//   - "sketchfab": a link to a model already on Sketchfab, shown in Sketchfab's own embed.
// KV: vault -> { items: [...] }. One document; it's one person's gallery.
//
//   GET    /api/vault                      -> { email, items }
//   POST   /api/vault/items                -> add { kind, name, urn, file, progress, sketchfab, thumb } -> item
//   PATCH  /api/vault/items/<id>           -> change { name, notes, progress, error, thumb }
//   DELETE /api/vault/items/<id>           -> remove from the vault (turns its link off too)
//   POST   /api/vault/items/<id>/share     -> { url } a public link (reused until turned off)
//   DELETE /api/vault/items/<id>/share     -> turn the link off
// Public links use the same /share/<token> pages as the hub (src/shares.js), shown dark like the vault.

import { currentEmail } from "./auth.js";

const KEY = "vault";
const ID = /^[a-z0-9]{12}$/;
const SKETCHFAB = /^[0-9a-f]{32}$/i;
const URN = /^[\w-]{1,300}$/;

const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const newToken = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(24))].map(b => abc[b % abc.length]).join("");
};
const text = (s, n) => String(s ?? "").trim().slice(0, n);

// The owner's email, or null when this request isn't from the owner.
async function owner(request, env) {
  const email = (await currentEmail(request, env)) || (env.VAULT_DEV_EMAIL || "").toLowerCase() || null;   // VAULT_DEV_EMAIL: local dev only (.dev.vars)
  if (!email) return null;
  const fixed = (env.VAULT_OWNER || "").trim().toLowerCase();
  if (fixed) return email === fixed ? email : null;
  const claimed = await env.HUB.get("vault:owner");
  if (!claimed) { await env.HUB.put("vault:owner", email); return email; }
  return email === claimed ? email : null;
}

const privatePage = () => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16181c;color:#9aa1ab;font:15px system-ui,sans-serif}</style><p>Nothing here.</p>`,
  { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

// GET /vault: the page itself, only for the owner.
export async function vaultPage(request, env, url) {
  if (!(await owner(request, env))) return privatePage();
  const res = await env.ASSETS.fetch(new Request(new URL("/vault", url), request));
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex");
  out.headers.set("Cache-Control", "no-store");
  return out;
}

export async function vaultRoute(request, env, url) {
  const email = await owner(request, env);
  if (!email) return Response.json({ error: "Not found" }, { status: 404 });
  const method = request.method;
  const doc = (await env.HUB.get(KEY, "json")) || { items: [] };
  const save = () => env.HUB.put(KEY, JSON.stringify(doc));

  if (url.pathname === "/api/vault" && method === "GET") return Response.json({ email, items: doc.items });

  if (url.pathname === "/api/vault/items" && method === "POST") {
    const b = await request.json();
    const item = { id: newId(), name: text(b.name, 120) || "Untitled model", notes: "", createdAt: new Date().toISOString() };
    if (b.kind === "sketchfab") {
      if (!SKETCHFAB.test(b.sketchfab || "")) return Response.json({ error: "That isn't a Sketchfab model link" }, { status: 400 });
      Object.assign(item, { kind: "sketchfab", sketchfab: b.sketchfab.toLowerCase(), thumb: safeThumb(b.thumb) });
    } else {
      if (!URN.test(b.urn || "")) return Response.json({ error: "Upload didn't return a model id" }, { status: 400 });
      Object.assign(item, { kind: "upload", urn: b.urn, file: text(b.file, 200), progress: text(b.progress, 20) || "0%" });
    }
    doc.items.unshift(item);
    await save();
    return Response.json(item);
  }

  const m = url.pathname.match(/^\/api\/vault\/items\/([a-z0-9]+)(\/share)?$/);
  const item = m && ID.test(m[1]) ? doc.items.find(i => i.id === m[1]) : null;
  if (m && !item) return Response.json({ error: "That model isn't in the vault" }, { status: 404 });

  if (m && !m[2] && method === "PATCH") {
    const b = await request.json();
    if ("name" in b) item.name = text(b.name, 120) || item.name;
    if ("notes" in b) item.notes = text(b.notes, 2000);
    if ("progress" in b) item.progress = text(b.progress, 20);
    if ("error" in b) { if (b.error) item.error = text(b.error, 500); else delete item.error; }
    if ("thumb" in b) item.thumb = safeThumb(b.thumb);
    await save();
    if (item.share && "name" in b) await writeShare(env, item);   // keep the public page title in step
    return Response.json(item);
  }
  if (m && !m[2] && method === "DELETE") {
    if (item.share) await env.HUB.delete(`share:${item.share}`);
    doc.items = doc.items.filter(i => i !== item);
    await save();
    return Response.json({ ok: true });
  }
  if (m && m[2] && method === "POST") {
    if (!item.share) { item.share = newToken(); item.sharedAt = new Date().toISOString(); await save(); }
    await writeShare(env, item, email);
    return Response.json({ token: item.share, url: `${url.origin}/share/${item.share}` });
  }
  if (m && m[2] && method === "DELETE") {
    if (item.share) await env.HUB.delete(`share:${item.share}`);
    delete item.share; delete item.sharedAt;
    await save();
    return Response.json({ ok: true });
  }
  return null;
}

// The record /share/<token> reads (see shares.js). "vault" marks it as a vault link: dark page, and the hub's own
// share routes leave it alone.
function writeShare(env, item, email) {
  const rec = { vault: item.id, label: item.name, dark: true, at: item.sharedAt, email };
  if (item.kind === "sketchfab") rec.sketchfab = item.sketchfab; else rec.urn = item.urn;
  return env.HUB.put(`share:${item.share}`, JSON.stringify(rec));
}

function safeThumb(u) {
  try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)sketchfab\.com$/.test(x.hostname) ? x.href.slice(0, 500) : undefined; }
  catch { return undefined; }
}
