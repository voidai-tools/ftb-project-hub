// Markups drawn on a model in the 3D viewer (Autodesk's MarkupsCore extension). Each one is the SVG the extension
// produces plus the camera view it was drawn from, one KV key each:  markup:<urn>:<time>-<rand>
//
//   GET    /api/models/<urn>/markups                         -> { markups: [...] } oldest first
//   POST   /api/models/<urn>/markups  { title, svg, view }   -> { markup }  (signed in only)
//   DELETE /api/models/<urn>/markups/<id>                    -> only the person who drew it

import { currentUser } from "./auth.js";

const MAX_SVG = 2 * 1024 * 1024;

export async function markupsRoute(request, env, urn, id) {
  const method = request.method;
  const prefix = `markup:${urn}:`;

  if (!id && method === "GET") {
    const keys = [];
    let cursor;
    do {
      const page = await env.HUB.list({ prefix, cursor });
      keys.push(...page.keys.map(k => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const markups = (await Promise.all(keys.map(k => env.HUB.get(k, "json")))).filter(Boolean)
      .sort((a, b) => a.at.localeCompare(b.at));
    return Response.json({ markups });
  }

  const user = await currentUser(request, env);
  if (!user) return Response.json({ error: "Sign in to save markups" }, { status: 401 });

  if (!id && method === "POST") {
    const { title, svg, view } = await request.json();
    if (typeof svg !== "string" || !svg.startsWith("<svg")) return Response.json({ error: "Nothing drawn" }, { status: 400 });
    if (svg.length > MAX_SVG) return Response.json({ error: "Markup too large" }, { status: 413 });
    const at = new Date().toISOString();
    const markup = {
      id: `${at.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
      title: String(title || "").trim().slice(0, 120) || "Markup",
      email: user.email, name: user.name, at, svg, view: view && typeof view === "object" ? view : null,
    };
    await env.HUB.put(prefix + markup.id, JSON.stringify(markup));
    return Response.json({ markup });
  }

  if (id && method === "DELETE") {
    const markup = await env.HUB.get(prefix + id, "json");
    if (!markup) return Response.json({ ok: true });
    if (markup.email !== user.email) return Response.json({ error: "You can only delete your own markups" }, { status: 403 });
    await env.HUB.delete(prefix + id);
    return Response.json({ ok: true });
  }
  return null;
}
