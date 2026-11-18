// Service worker for the installed app. Kept deliberately small:
//  - Pages (/, /vault): network first, so everyone always gets the latest deploy; the last good copy opens if offline.
//  - Icons and logo: served from cache, refreshed in the background.
//  - /api/*, /share/*, uploads and anything on another site (Autodesk viewer, fonts, Sketchfab) are never touched.
// Cloudflare Access sign-in redirects are passed straight through and never cached.
const CACHE = "ftb-hub-v1";
const STATIC = ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/favicon-32.png", "/favicon.ico", "/ftb-logo.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const cacheable = res => res && res.ok && res.type === "basic" && !res.redirected;

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/share/") || url.pathname.startsWith("/cdn-cgi/")) return;

  if (req.mode === "navigate") {
    const key = url.pathname.startsWith("/vault") ? "/vault" : "/";
    event.respondWith(fetch(req).then(res => {
      if (cacheable(res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(async () => (await caches.match(key)) || new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Offline</title>" +
      "<body style='font:16px system-ui;padding:40px;background:#eef0f2;color:#1b1f24'><h1>You're offline</h1><p>Reconnect and reload to open the FTB hub.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })));
    return;
  }

  if (STATIC.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const fresh = fetch(req).then(res => { if (cacheable(res)) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
