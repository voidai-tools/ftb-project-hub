// Job photos, stored in R2 (bucket ftb-photos, binding PHOTOS). The browser shrinks each photo before upload and
// sends two JPEGs: the full one (~2,500 px) and a thumbnail (~480 px). Who uploaded it, the piece and the caption
// ride along as object metadata, so listing a project's photos is one R2 list call with no separate index.
//
//   GET    /api/photos                         -> { photos: [...] } every project, newest first (the Gallery)
//   GET    /api/photos?project=<id>            -> { photos: [...] } one project
//   GET    /api/photos/file/<key>              -> the image (photos/... or thumbs/...)
//   POST   /api/photos  FormData{ full, thumb, project, item?, caption?, w?, h? } -> { photo }  (signed in only)
//   DELETE /api/photos/<project>/<id>          -> only the person who uploaded it
//   POST   /api/refs  FormData{ full, project } -> { url }  reference image for a piece (packet screenshot); the
//                                                  piece keeps the url in the hub document, and it stays out of the Gallery

import { currentUser } from "./auth.js";

const ID = /^[\w-]{1,120}$/;
const MAX_FULL = 15 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;

function toPhoto(obj) {
  const m = obj.customMetadata || {};
  const [, project, file] = obj.key.split("/");
  const id = file.replace(/\.jpg$/, "");
  return {
    id, project, item: m.item || "", caption: m.caption || "", email: m.email || "", name: m.name || "",
    at: m.at || obj.uploaded?.toISOString?.() || "", w: Number(m.w) || 0, h: Number(m.h) || 0, size: obj.size,
    full: `/api/photos/file/photos/${project}/${id}.jpg`, thumb: `/api/photos/file/thumbs/${project}/${id}.jpg`,
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

  const file = url.pathname.match(/^\/api\/photos\/file\/((?:photos|thumbs|refs)\/[\w-]{1,120}\/[\w-]{1,80}\.jpg)$/);
  if (file && method === "GET") {
    const obj = await env.PHOTOS.get(file[1]);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", ETag: obj.httpEtag },
    });
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
    if (full.size > MAX_FULL) return Response.json({ error: "Image too large" }, { status: 413 });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    await env.PHOTOS.put(`refs/${project}/${id}.jpg`, full,
      { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { project, email: user.email, at: new Date().toISOString() } });
    return Response.json({ url: `/api/photos/file/refs/${project}/${id}.jpg` });
  }

  const del = url.pathname.match(/^\/api\/photos\/([\w-]{1,120})\/([\w-]{1,80})$/);
  if (del && method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    const key = `photos/${del[1]}/${del[2]}.jpg`;
    const head = await env.PHOTOS.head(key);
    if (!head) return Response.json({ ok: true });
    if (head.customMetadata?.email !== user.email) return Response.json({ error: "You can only delete your own photos" }, { status: 403 });
    await env.PHOTOS.delete([key, `thumbs/${del[1]}/${del[2]}.jpg`]);
    return Response.json({ ok: true });
  }
  return null;
}
