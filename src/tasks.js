// Shop jobs ("orders") and their subtasks, notes and files. This replaces TickTick: the router's board is the
// CNC column, a job opens in a side panel (title, note, files, subtasks), and one search covers every job ever
// posted, finished ones included.
//
// Storage: D1 database (binding DB) holds one row per job or subtask; the job's fields ride in `data` as JSON and a
// lower-cased `search` column holds its title, note, file names and tags. Files go in R2 (binding FILES).
// Top-level rows are board orders (status queued | in-progress | ready-* | done | out); subtasks have status open | done.
//
//   GET    /api/orders                    -> { orders } on the board (not out the door, or out within 2 days), each with
//                                            subs: [{ id, title, status, files }] and fileCount
//   GET    /api/orders/:id                -> { order, subtasks, path } path = parents, top first
//   PUT    /api/orders/:id                -> create, or merge the fields sent into the job (files are left alone)
//   DELETE /api/orders/:id                -> the job, its subtasks and their files
//   POST   /api/orders/:id/files?name=    body = the file -> { file }
//   DELETE /api/orders/:id/files?key=     -> remove one file
//   GET    /api/files/<key>               -> download a file
//   GET    /api/tasks/search?q=           -> { results } every word must match, newest first
//   POST   /api/tasks/import              { tasks: [...] } from a TickTick backup, parsed in the browser
//
// Orders used to live in KV (order:<id> + orders:all); they're copied into D1 once, the first time it's used.

import { currentUser } from "./auth.js";

const ID = /^[\w-]{1,140}$/;
const OUT_SHOWN_MS = 2 * 24 * 3600e3;
const MAX_FILE = 100 * 1024 * 1024; // Cloudflare's request size limit

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT NOT NULL, status_at TEXT,
    updated_at TEXT, search TEXT NOT NULL DEFAULT '', data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id)`,
  `CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, status_at)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

let ready = null;
function setup(env) {
  return (ready ||= (async () => {
    await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
    const done = await env.DB.prepare("SELECT v FROM meta WHERE k = 'kv-orders-copied'").first("v");
    if (!done) await copyFromKv(env);
  })().catch(err => { ready = null; throw err; }));
}

// One-time copy of the board from KV. KV is left as it was, as a backup.
async function copyFromKv(env) {
  const snap = await env.HUB.get("orders:all", "json");
  let orders = snap?.orders || [];
  if (!snap) {
    const keys = [];
    let cursor;
    do {
      const page = await env.HUB.list({ prefix: "order:", cursor });
      keys.push(...page.keys.map(k => k.name));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    orders = (await Promise.all(keys.map(k => env.HUB.get(k, "json")))).filter(Boolean);
  }
  const stmts = orders.filter(o => o?.id && ID.test(o.id)).map(o => upsertStmt(env, { files: [], ...o }));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('kv-orders-copied', ?)").bind(new Date().toISOString()).run();
}

const searchText = t => [t.title, t.notes, t.project, t.for, t.location, ...(t.tags || []), ...(t.files || []).map(f => f.name)]
  .filter(Boolean).join(" \n ").toLowerCase();

function upsertStmt(env, t) {
  const now = new Date().toISOString();
  t.updatedAt ||= now;
  return env.DB.prepare(`INSERT INTO tasks (id, parent_id, status, status_at, updated_at, search, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(id) DO UPDATE SET parent_id = ?2, status = ?3, status_at = ?4, updated_at = ?5, search = ?6, data = ?7`)
    .bind(t.id, t.parentId || null, t.status || "queued", t.statusAt || t.createdAt || now, t.updatedAt, searchText(t), JSON.stringify(t));
}

async function getTask(env, id) {
  const row = await env.DB.prepare("SELECT data FROM tasks WHERE id = ?").bind(id).first("data");
  return row ? JSON.parse(row) : null;
}

const summary = t => ({ id: t.id, title: t.title, status: t.status, files: (t.files || []).length });

async function childrenOf(env, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const { results } = await env.DB.prepare("SELECT data FROM tasks WHERE parent_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
    .bind(JSON.stringify(ids)).all();
  for (const r of results) {
    const t = JSON.parse(r.data);
    if (!out.has(t.parentId)) out.set(t.parentId, []);
    out.get(t.parentId).push(t);
  }
  return out;
}

const bySort = (a, b) => (a.sort ?? 1e15) - (b.sort ?? 1e15) || String(a.createdAt).localeCompare(String(b.createdAt));

export async function tasksRoute(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (!env.DB) return Response.json({ error: "Task storage (D1) isn't connected" }, { status: 503 });
  await setup(env);

  if (pathname === "/api/orders" && method === "GET") {
    const since = new Date(Date.now() - OUT_SHOWN_MS).toISOString();
    const { results } = await env.DB.prepare("SELECT data FROM tasks WHERE parent_id IS NULL AND (status != 'out' OR status_at > ?)").bind(since).all();
    const orders = results.map(r => JSON.parse(r.data));
    const kids = await childrenOf(env, orders.map(o => o.id));
    for (const o of orders) {
      o.subs = (kids.get(o.id) || []).sort(bySort).map(summary);
      o.fileCount = (o.files || []).length;
      delete o.files;
    }
    return Response.json({ orders });
  }

  if (pathname === "/api/tasks/search" && method === "GET") {
    const words = (url.searchParams.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return Response.json({ results: [] });
    const like = w => "%" + w.replace(/[\\%_]/g, c => "\\" + c) + "%";
    const { results } = await env.DB.prepare(`SELECT t.data, p.data AS parent FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id
      WHERE ${words.map(() => "t.search LIKE ? ESCAPE '\\'").join(" AND ")} ORDER BY t.status_at DESC LIMIT 80`)
      .bind(...words.map(like)).all();
    return Response.json({ results: results.map(r => {
      const t = JSON.parse(r.data), p = r.parent ? JSON.parse(r.parent) : null;
      return { ...t, parentTitle: p?.title || "" };
    }) });
  }

  if (pathname === "/api/tasks/import" && method === "POST") {
    const { tasks } = await request.json();
    if (!Array.isArray(tasks) || tasks.length > 500) return Response.json({ error: "Send up to 500 tasks at a time" }, { status: 400 });
    const now = new Date().toISOString();
    const stmts = [];
    let merged = 0;
    for (const raw of tasks) {
      if (!raw?.id || !ID.test(raw.id) || !raw.title) continue;
      if (raw.mergeInto) {
        // An open job the old TickTick sync already put on the board: add the backup's note and files to it.
        const live = await getTask(env, raw.mergeInto);
        if (live) {
          const have = new Set((live.files || []).map(f => f.tt || f.key));
          live.files = [...(live.files || []), ...(raw.files || []).filter(f => !have.has(f.tt))];
          if (!live.notes && raw.notes) live.notes = raw.notes;
          live.updatedAt = now;
          stmts.push(upsertStmt(env, live));
          merged++;
        }
        continue;
      }
      const t = { ...raw, source: "ticktick-import", importedAt: now, updatedAt: now };
      // Re-importing a newer backup refreshes tasks nobody has touched on the hub since the last import.
      stmts.push(env.DB.prepare(`INSERT INTO tasks (id, parent_id, status, status_at, updated_at, search, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET parent_id = ?2, status = ?3, status_at = ?4, updated_at = ?5, search = ?6, data = ?7
        WHERE json_extract(tasks.data, '$.importedAt') = tasks.updated_at`)
        .bind(t.id, t.parentId || null, t.status, t.statusAt || t.createdAt || now, now, searchText(t), JSON.stringify(t)));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return Response.json({ ok: true, saved: stmts.length - merged, merged });
  }

  const fm = pathname.match(/^\/api\/files\/(tasks\/[\w-]+\/[\w-]+\/[^/]+)$/);
  if (fm && method === "GET") {
    const obj = await env.FILES.get(decodeURIComponent(fm[1]));
    if (!obj) return new Response("File not found", { status: 404 });
    const name = (obj.customMetadata?.name || "file").replace(/["\\\r\n]/g, "");
    const type = obj.httpMetadata?.contentType || "application/octet-stream";
    const inline = /^(image\/|application\/pdf)/.test(type) && url.searchParams.get("dl") == null;
    return new Response(obj.body, { headers: {
      "Content-Type": type, "Content-Length": String(obj.size), "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    } });
  }

  const m = pathname.match(/^\/api\/orders\/([\w-]{1,140})(\/files)?$/);
  if (!m) return null;
  const [, id, files] = m;

  if (files && method === "POST") {
    const task = await getTask(env, id);
    if (!task) return Response.json({ error: "No such job" }, { status: 404 });
    const name = (url.searchParams.get("name") || "file").replace(/[\/\\\r\n]/g, "_").slice(0, 180);
    const size = Number(request.headers.get("Content-Length") || 0);
    if (size > MAX_FILE) return Response.json({ error: "Files over 100 MB can't be uploaded here" }, { status: 413 });
    const user = await currentUser(request, env);
    const key = `tasks/${id}/${crypto.randomUUID().slice(0, 8)}/${encodeURIComponent(name).replace(/%/g, "~").slice(0, 200)}`;
    const type = request.headers.get("Content-Type") || "application/octet-stream";
    const obj = await env.FILES.put(key, request.body, { httpMetadata: { contentType: type }, customMetadata: { name, task: id, by: user?.email || "" } });
    const file = { key, name, size: obj.size, type, at: new Date().toISOString(), by: user?.name || "" };
    // Re-read just before writing so a note typed at the same time isn't lost.
    const latest = await getTask(env, id) || task;
    latest.files = [...(latest.files || []), file];
    latest.updatedAt = file.at;
    await upsertStmt(env, latest).run();
    return Response.json({ file });
  }
  if (files && method === "DELETE") {
    const key = url.searchParams.get("key") || "";
    const task = await getTask(env, id);
    if (!task) return Response.json({ error: "No such job" }, { status: 404 });
    const f = (task.files || []).find(x => (x.key || x.tt) === key);
    if (!f) return Response.json({ error: "No such file" }, { status: 404 });
    if (f.key) await env.FILES.delete(f.key);
    task.files = task.files.filter(x => x !== f);
    task.updatedAt = new Date().toISOString();
    await upsertStmt(env, task).run();
    return Response.json({ ok: true });
  }
  if (files) return null;

  if (method === "GET") {
    const order = await getTask(env, id);
    if (!order) return Response.json({ error: "No such job" }, { status: 404 });
    const kids = (await childrenOf(env, [id])).get(id) || [];
    const grand = await childrenOf(env, kids.map(k => k.id));
    const subtasks = kids.sort(bySort).map(k => ({ ...summary(k), subs: (grand.get(k.id) || []).map(summary), hasNote: !!k.notes }));
    const path = [];
    for (let p = order.parentId, n = 0; p && n < 5; n++) {
      const parent = await getTask(env, p);
      if (!parent) break;
      path.unshift({ id: parent.id, title: parent.title });
      p = parent.parentId;
    }
    return Response.json({ order, subtasks, path });
  }

  if (method === "PUT") {
    const body = await request.json();
    const existing = await getTask(env, id);
    if (!existing && !body?.title) return Response.json({ error: "title required" }, { status: 400 });
    const { files: _f, subs: _s, fileCount: _c, id: _i, ...fields } = body || {};
    const now = new Date().toISOString();
    const task = { ...(existing || { files: [], createdAt: now }), ...fields, id, updatedAt: now };
    if (!existing) {
      const user = await currentUser(request, env);
      if (user) task.createdBy = user.name;
      if (task.parentId && !(await getTask(env, task.parentId))) return Response.json({ error: "No such parent job" }, { status: 400 });
    }
    if (task.parentId) { task.status = task.status === "done" ? "done" : "open"; delete task.board; }
    await upsertStmt(env, task).run();
    const { files, ...rest } = task;
    return Response.json({ ok: true, order: { ...rest, fileCount: (files || []).length } });
  }

  if (method === "DELETE") {
    const { results } = await env.DB.prepare(`WITH RECURSIVE t(id) AS (SELECT ?1 UNION SELECT tasks.id FROM tasks JOIN t ON tasks.parent_id = t.id)
      SELECT tasks.id, tasks.data FROM tasks JOIN t ON tasks.id = t.id`).bind(id).all();
    const keys = results.flatMap(r => (JSON.parse(r.data).files || []).map(f => f.key).filter(Boolean));
    for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
    const ids = results.map(r => r.id);
    if (ids.length) await env.DB.prepare("DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).run();
    return Response.json({ ok: true, deleted: ids.length });
  }
  return null;
}
