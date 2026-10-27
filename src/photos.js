// Job photos, stored in R2 (bucket ftb-photos, binding PHOTOS). The browser shrinks each photo before upload and
// sends two JPEGs: the full one (~2,500 px) and a thumbnail (~480 px). Who uploaded it, the piece and the caption
// ride along as object metadata, so listing a project's photos is one R2 list call with no separate index.
//
//   GET    /api/photos                         -> { photos: [...] } every project, newest first (the Gallery)
//   GET    /api/photos?project=<id>            -> { photos: [...] } one project
//   GET    /api/photos/file/<key>              -> the image (photos/... or thumbs/...)
//   POST   /api/photos  FormData{ full, thumb, project, item?, caption?, w?, h? } -> { photo }  (signed in only)
//   POST   /api/photos/video?project&item&caption&w&h  body = the video file as-is -> { photo }  (signed in only)
//   PUT    /api/photos/<project>/<id>/thumb   body = JPEG frame grabbed in the browser (uploader only)
//   DELETE /api/photos/<project>/<id>          -> only the person who uploaded it
// Videos sit next to photos (photos/<project>/<id>.mp4 etc.) and are served with byte ranges so phones can seek.
//   POST   /api/refs  FormData{ full, project } -> { url }  reference image for a piece (packet screenshot), or an
//                                                  assembly GIF (kept as-is so it stays animated); the piece keeps the url
//                                                  in the hub document, and these stay out of the Gallery

import { currentUser } from "./auth.js";

const ID = /^[\w-]{1,120}$/;
const MAX_FULL = 15 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;
const MAX_GIF = 30 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;   // Cloudflare's request size limit
const VIDEO_EXT = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v" };
const TYPES = { jpg: "image/jpeg", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v" };

function toPhoto(obj) {
  const m = obj.customMetadata || {};
  const [, project, file] = obj.key.split("/");
  const [id, ext] = file.split(".");
  return {
    id, project, item: m.item || "", caption: m.caption || "", email: m.email || "", name: m.name || "",
    at: m.at || obj.uploaded?.toISOString?.() || "", w: Number(m.w) || 0, h: Number(m.h) || 0, size: obj.size,
    ...(ext !== "jpg" ? { video: true } : {}),
    full: `/api/photos/file/photos/${project}/${file}`, thumb: `/api/photos/file/thumbs/${project}/${id}.jpg`,
  };
}

async function listPhotos(env, prefix) {
  const photos = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix, cursor, include: ["customMetadata"] });
    photos.push(...page.objects.map(toPhoto));
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return photos.sort((a, b) => b.at.localeCompare(a.at));
}

export async function photosRoute(request, env, url) {
  const method = request.method;
  if (!env.PHOTOS) return Response.json({ error: "Photo storage isn't connected" }, { status: 503 });

  if (url.pathname === "/api/photos" && method === "GET") {
    const project = url.searchParams.get("project");
    if (project != null && !ID.test(project)) return Response.json({ error: "Bad project" }, { status: 400 });
    return Response.json({ photos: await listPhotos(env, project ? `photos/${project}/` : "photos/") });
  }

  const file = url.pathname.match(/^\/api\/photos\/file\/((?:photos|thumbs|refs)\/[\w-]{1,120}\/[\w-]{1,80}\.(jpg|gif|mp4|mov|webm|m4v))$/);
  if (file && method === "GET") {
    const headers = { "Content-Type": TYPES[file[2]], "Cache-Control": "private, max-age=31536000, immutable", "Accept-Ranges": "bytes" };
    // Videos are fetched in pieces (Safari insists), so honour a single byte range.
    const range = (request.headers.get("Range") || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      const head = await env.PHOTOS.head(file[1]);
      if (!head) return new Response("Not found", { status: 404 });
      const size = head.size;
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const obj = await env.PHOTOS.get(file[1], { range: { offset: start, length: end - start + 1 } });
      return new Response(obj.body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1), ETag: head.httpEtag } });
    }
    const obj = await env.PHOTOS.get(file[1]);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, { headers: { ...headers, "Content-Length": String(obj.size), ETag: obj.httpEtag } });
  }

  if (url.pathname === "/api/photos/video" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in to add videos" }, { status: 401 });
    const q = url.searchParams;
    const project = q.get("project") || "", item = q.get("item") || "";
    const ext = VIDEO_EXT[(request.headers.get("Content-Type") || "").split(";")[0]];
    const length = Number(request.headers.get("Content-Length"));
    if (!ID.test(project) || (item && !ID.test(item))) return Response.json({ error: "Bad project or piece" }, { status: 400 });
    if (!ext) return Response.json({ error: "Use an MP4, MOV or WebM video" }, { status: 415 });
    if (!length || length > MAX_VIDEO) return Response.json({ error: "Videos can be up to 100 MB" }, { status: 413 });
    const at = new Date().toISOString();
    const id = `${at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const meta = { project, item, caption: (q.get("caption") || "").trim().slice(0, 300), email: user.email, name: user.name, at,
      w: String(Number(q.get("w")) || 0), h: String(Number(q.get("h")) || 0) };
    const obj = await env.PHOTOS.put(`photos/${project}/${id}.${ext}`, request.body,
      { httpMetadata: { contentType: TYPES[ext] }, customMetadata: meta });
    return Response.json({ photo: toPhoto({ key: obj.key, size: obj.size, customMetadata: meta }) });
  }

  const th = url.pathname.match(/^\/api\/photos\/([\w-]{1,120})\/([\w-]{1,80})\/thumb$/);
  if (th && method === "PUT") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    const [main] = (await env.PHOTOS.list({ prefix: `photos/${th[1]}/${th[2]}.`, include: ["customMetadata"] })).objects;
    if (!main || main.customMetadata?.email !== user.email) return Response.json({ error: "Not your video" }, { status: 403 });
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_THUMB) return Response.json({ error: "Thumbnail too large" }, { status: 413 });
    await env.PHOTOS.put(`thumbs/${th[1]}/${th[2]}.jpg`, body, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: main.customMetadata });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/photos" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in to add photos" }, { status: 401 });
    const form = await request.formData();
    const full = form.get("full"), thumb = form.get("thumb");
    const project = String(form.get("project") || ""), item = String(form.get("item") || "");
    if (!ID.test(project) || (item && !ID.test(item))) return Response.json({ error: "Bad project or piece" }, { status: 400 });
    if (!(full instanceof File) || !(thumb instanceof File)) return Response.json({ error: "full and thumb images required" }, { status: 400 });
    if (full.size > MAX_FULL || thumb.size > MAX_THUMB) return Response.json({ error: "Photo too large" }, { status: 413 });
    const at = new Date().toISOString();
    const id = `${at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const meta = {
      project, item, caption: String(form.get("caption") || "").trim().slice(0, 300),
      email: user.email, name: user.name, at,
      w: String(Number(form.get("w")) || 0), h: String(Number(form.get("h")) || 0),
    };
    const opts = { httpMetadata: { contentType: "image/jpeg" }, customMetadata: meta };
    const obj = await env.PHOTOS.put(`photos/${project}/${id}.jpg`, full, opts);
    await env.PHOTOS.put(`thumbs/${project}/${id}.jpg`, thumb, opts);
    return Response.json({ photo: toPhoto({ key: obj.key, size: obj.size, customMetadata: meta }) });
  }

  if (url.pathname === "/api/refs" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in to add images" }, { status: 401 });
    const form = await request.formData();
    const full = form.get("full"), project = String(form.get("project") || "");
    if (!ID.test(project)) return Response.json({ error: "Bad project" }, { status: 400 });
    if (!(full instanceof File)) return Response.json({ error: "Image required" }, { status: 400 });
    const gif = full.type === "image/gif";
    if (full.size > (gif ? MAX_GIF : MAX_FULL)) return Response.json({ error: gif ? "GIF too large (30 MB max)" : "Image too large" }, { status: 413 });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = gif ? "gif" : "jpg";
    await env.PHOTOS.put(`refs/${project}/${id}.${ext}`, full,
      { httpMetadata: { contentType: gif ? "image/gif" : "image/jpeg" }, customMetadata: { project, email: user.email, at: new Date().toISOString() } });
    return Response.json({ url: `/api/photos/file/refs/${project}/${id}.${ext}` });
  }

  const del = url.pathname.match(/^\/api\/photos\/([\w-]{1,120})\/([\w-]{1,80})$/);
  if (del && method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    const [head] = (await env.PHOTOS.list({ prefix: `photos/${del[1]}/${del[2]}.`, include: ["customMetadata"] })).objects;
    if (!head) return Response.json({ ok: true });
    if (head.customMetadata?.email !== user.email) return Response.json({ error: "You can only delete your own photos" }, { status: 403 });
    await env.PHOTOS.delete([head.key, `thumbs/${del[1]}/${del[2]}.jpg`]);
    return Response.json({ ok: true });
  }
  return null;
}
