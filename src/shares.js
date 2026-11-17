// Public view-only links for uploaded models, so people outside the team can look at one model without logging in.
// A link is a long random token; KV holds  share:<token> -> { urn, label, project, email, at }  and
// shareFor:<urn> -> <token>  (one link per model, reused until someone turns it off). Links don't expire.
//
// Team routes (behind Cloudflare Access like the rest of /api):
//   GET    /api/shares?urn=<urn>                -> { token, url } or {}
//   POST   /api/shares  { urn, label, project } -> { token, url }
//   DELETE /api/shares/<token>                   -> turns the link off
// Public routes (Cloudflare Access must Bypass the path /share for these):
//   GET /share/<token>          -> a bare page with the Autodesk viewer and that one model
//   GET /share/<token>/token    -> short-lived viewables:read token, only while the link is on
//   GET /share/logo.png         -> the FTB logo (the rest of the site's files stay behind the login)

import { currentUser } from "./auth.js";

const URN = /^[\w-]{1,300}$/;
const TOKEN = /^[A-Za-z0-9]{24}$/;

function newToken() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(24))].map(b => abc[b % abc.length]).join("");
}
const shareUrl = (url, token) => `${url.origin}/share/${token}`;

export async function sharesRoute(request, env, url) {
  const method = request.method;
  if (url.pathname === "/api/shares" && method === "GET") {
    const urn = url.searchParams.get("urn") || "";
    if (!URN.test(urn)) return Response.json({ error: "Bad model" }, { status: 400 });
    const token = await env.HUB.get(`shareFor:${urn}`);
    return Response.json(token ? { token, url: shareUrl(url, token) } : {});
  }
  if (url.pathname === "/api/shares" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in to share models" }, { status: 401 });
    const { urn, label, project } = await request.json();
    if (!URN.test(urn || "")) return Response.json({ error: "Bad model" }, { status: 400 });
    let token = await env.HUB.get(`shareFor:${urn}`);
    if (!token) {
      token = newToken();
      await env.HUB.put(`share:${token}`, JSON.stringify({ urn, label: String(label || "").slice(0, 120), project: String(project || "").slice(0, 120),
        email: user.email, at: new Date().toISOString() }));
      await env.HUB.put(`shareFor:${urn}`, token);
    }
    return Response.json({ token, url: shareUrl(url, token) });
  }
  const del = url.pathname.match(/^\/api\/shares\/([A-Za-z0-9]{24})$/);
  if (del && method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    const share = await env.HUB.get(`share:${del[1]}`, "json");
    if (share) await env.HUB.delete(`shareFor:${share.urn}`);
    await env.HUB.delete(`share:${del[1]}`);
    return Response.json({ ok: true });
  }
  return null;
}

// /share/... is public. getToken(scope) is the Worker's APS token helper.
export async function sharePage(request, env, url, getToken) {
  if (url.pathname === "/share/logo.png") return env.ASSETS.fetch(new Request(new URL("/ftb-logo.png", url), request));
  const m = url.pathname.match(/^\/share\/([^/]+)(\/token)?$/);
  const share = m && TOKEN.test(m[1]) ? await env.HUB.get(`share:${m[1]}`, "json") : null;
  if (!share) return new Response(page("Link not found", "<p class='msg'>This link was turned off or never existed. Ask FTB Design for a new one.</p>"),
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (m[2]) {
    const { access_token, expires_in } = await getToken("viewables:read");
    return Response.json({ access_token, expires_in }, { headers: { "Cache-Control": "no-store" } });
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const title = share.label || "3D model";
  const headers = { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
  // Vault links (src/vault.js) can point at a Sketchfab model instead of an uploaded one.
  if (share.sketchfab && /^[0-9a-f]{32}$/.test(share.sketchfab)) return new Response(page(title, `
  <iframe id="v" src="https://sketchfab.com/models/${share.sketchfab}/embed?autostart=1&ui_theme=dark&ui_infos=0&ui_watermark_link=0&dnt=1" title="${esc(title)}"
    allow="autoplay; fullscreen; xr-spatial-tracking" allowfullscreen style="border:0;width:100%;height:calc(100% - 52px)"></iframe>`, esc(title), share.dark), { headers });
  const stage = share.dark
    ? `viewer.setBackgroundColor(70, 72, 78, 18, 19, 22); viewer.setGroundShadow(true); viewer.setQualityLevel(true, true); viewer.setTheme("dark-theme");`
    : "";
  return new Response(page(title, `
  <div id="v"></div>
  <script src="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js"></script>
  <script>
    const urn = ${JSON.stringify(share.urn)}, tokenUrl = location.pathname.replace(/\\/$/, "") + "/token";
    Autodesk.Viewing.Initializer({ env: "AutodeskProduction2", api: "streamingV2",
      getAccessToken: async cb => { const t = await (await fetch(tokenUrl)).json(); cb(t.access_token, t.expires_in); } }, () => {
      const viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById("v"));
      viewer.start();
      viewer.addEventListener(Autodesk.Viewing.GEOMETRY_LOADED_EVENT, () => { ${stage} });
      Autodesk.Viewing.Document.load("urn:" + urn, doc => viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()),
        () => { document.getElementById("v").innerHTML = "<p class='msg'>This model couldn't be loaded. It may still be processing; try again in a few minutes.</p>"; });
    });
  </script>`, esc(title), share.dark), { headers });
}

function page(title, body, safeTitle = title, dark = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${safeTitle} · FTB Design</title>
<link rel="stylesheet" href="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css">
<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#eef0f3;color:#1b1f24}
header{position:fixed;top:0;left:0;right:0;height:52px;display:flex;align-items:center;gap:12px;padding:0 14px;background:#fff;border-bottom:1px solid #d9dde3;z-index:10}
header img{height:30px}header b{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#v{position:fixed;top:52px;left:0;right:0;bottom:0}.msg{padding:80px 20px;text-align:center;color:#5b6470}</style></head>
${dark ? `<style>body{background:#16181c;color:#e8eaed}header{background:#1d1f24;border-color:#2c2f36}.msg{color:#9aa1ab}</style>` : ""}
<body><header><img src="/share/logo.png" alt="FTB Design"><b>${safeTitle}</b></header>${body}</body></html>`;
}
