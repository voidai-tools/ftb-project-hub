// Comments on project items (a piece or link group on a project page). One KV key per comment so people
// posting at the same time never overwrite each other:  comment:<projectId>:<itemId>:<time>-<rand>
//
//   GET    /api/comments?project=<id>              -> { counts: { <itemId>: n } }
//   GET    /api/comments?project=<id>&item=<id>    -> { comments: [...] } oldest first
//   POST   /api/comments  { project, item, text }  -> { comment }  (signed in only)
//   DELETE /api/comments/<id>                      -> only the person who wrote it

import { currentUser } from "./auth.js";

const ID = /^[\w-]{1,120}$/;

async function listKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.HUB.list({ prefix, cursor });
    keys.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

export async function commentsRoute(request, env, url) {
  const method = request.method;

  if (url.pathname === "/api/comments" && method === "GET") {
    const project = url.searchParams.get("project") || "";
    const item = url.searchParams.get("item");
    if (!ID.test(project) || (item != null && !ID.test(item))) return Response.json({ error: "Bad project or item" }, { status: 400 });
    if (item == null) {
      const counts = {};
      for (const key of await listKeys(env, `comment:${project}:`)) {
        const it = key.split(":")[2];
        counts[it] = (counts[it] || 0) + 1;
      }
      return Response.json({ counts });
    }
    const keys = await listKeys(env, `comment:${project}:${item}:`);
    const comments = (await Promise.all(keys.map(k => env.HUB.get(k, "json")))).filter(Boolean)
      .sort((a, b) => a.at.localeCompare(b.at));
    return Response.json({ comments });
  }

  if (url.pathname === "/api/comments" && method === "POST") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in to comment" }, { status: 401 });
    const { project, item, text } = await request.json();
    const body = String(text || "").trim().slice(0, 2000);
    if (!ID.test(project || "") || !ID.test(item || "") || !body) return Response.json({ error: "project, item and text required" }, { status: 400 });
    const at = new Date().toISOString();
    const id = `${project}:${item}:${at}-${Math.random().toString(36).slice(2, 8)}`;
    const comment = { id, project, item, text: body, at, email: user.email, name: user.name };
    await env.HUB.put(`comment:${id}`, JSON.stringify(comment));
    return Response.json({ comment });
  }

  const m = url.pathname.match(/^\/api\/comments\/(.+)$/);
  if (m && method === "DELETE") {
    const user = await currentUser(request, env);
    if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
    const key = `comment:${decodeURIComponent(m[1])}`;
    const comment = await env.HUB.get(key, "json");
    if (!comment) return Response.json({ ok: true });
    if (comment.email !== user.email) return Response.json({ error: "You can only delete your own comments" }, { status: 403 });
    await env.HUB.delete(key);
    return Response.json({ ok: true });
  }
  return null;
}
