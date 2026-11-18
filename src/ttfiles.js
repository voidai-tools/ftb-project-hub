// Copies the files attached to old TickTick tasks into the hub (R2 bucket ftb-files), next to the jobs imported from
// the TickTick backup. The backup CSV only names each file and its TickTick attachment id ("tt" on the job's file),
// so this signs in to TickTick's own web API, the one ticktick.com uses, which is unofficial and may change.
//
// Ben signs in through a box on the Shop tab. His password goes straight to TickTick and is never stored; the session
// token TickTick hands back is kept in KV for 6 hours (or until "Forget") and never sent back to the browser.
//
//   GET  /api/tasks/ttfiles          -> { connected, counts: { pending, copied, failed, missing } }
//   POST /api/tasks/ttfiles/connect  { username, password } or { cookie } -> signs in, then finds every attachment
//   POST /api/tasks/ttfiles/copy     -> copies the next few files; the page calls it until nothing is left
//   POST /api/tasks/ttfiles/forget   -> throws the TickTick sign-in away
//   POST /api/tasks/ttfiles/retry    -> marks failed files to be tried again

import { setup, getTask, upsertStmt } from "./tasks.js";

let TT = "https://api.ticktick.com";   // TICKTICK_TEST_API (local testing only) points this at a stand-in
const TOKEN_KEY = "ttfiles:token";
const TOKEN_TTL = 6 * 3600;
const MAX_FILE = 95 * 1024 * 1024;
const DEVICE = JSON.stringify({ platform: "web", os: "Windows 10", device: "Chrome 120.0.0.0", name: "", version: 6070,
  id: "66f1a2b3c4d5e6f708192a3b", channel: "website", campaign: "", websocket: "" });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const SCHEMA = `CREATE TABLE IF NOT EXISTS tt_files (att_id TEXT PRIMARY KEY, tt_project TEXT, tt_task TEXT, our_task TEXT,
  name TEXT, size INTEGER, status TEXT NOT NULL, error TEXT, updated_at TEXT)`;
let ready = false;
async function ensure(env) {
  await setup(env);
  if (!ready) {
    await env.DB.prepare(SCHEMA).run();
    // attempts: how many copy runs have started on a file, so one that keeps crashing a run gets skipped.
    try { await env.DB.prepare("ALTER TABLE tt_files ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0").run(); } catch {}
    ready = true;
  }
}

const fail = (status, error, extra = {}) => Response.json({ error, ...extra }, { status });

const headers = token => ({ Cookie: `t=${token}`, "x-device": DEVICE, "User-Agent": UA, Origin: "https://ticktick.com", Referer: "https://ticktick.com/" });

async function ttJson(token, path) {
  const res = await fetch(TT + path, { headers: headers(token) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("TickTick sign-in expired. Sign in again."), { status: 401 });
  if (!res.ok) throw new Error(`TickTick ${path.split("?")[0]} answered ${res.status}`);
  return res.json();
}

async function signIn(body) {
  if (body.cookie) return String(body.cookie).trim().replace(/^t=/, "").replace(/;.*$/, "");
  const res = await fetch(`${TT}/api/v2/user/signon?wc=true&remember=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device": DEVICE, "User-Agent": UA, Origin: "https://ticktick.com", Referer: "https://ticktick.com/" },
    body: JSON.stringify({ username: String(body.username || "").trim(), password: String(body.password || "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.token) return data.token;
  if (data.authId || data.errorCode === "need_verification") throw new Error("TickTick wants a second sign-in step (two-factor). Use the cookie option instead.");
  throw new Error(data.errorMessage || data.errorCode || `TickTick sign-in failed (${res.status})`);
}

// TickTick wants "yyyy-MM-dd HH:mm:ss" for the completed-task range.
const ttTime = d => d.toISOString().slice(0, 19).replace("T", " ");

// Every task in the lists we imported, finished ones included, with its attachments.
async function findAttachments(env, token) {
  const check = await ttJson(token, "/api/v2/batch/check/0");
  const projects = check.projectProfiles || [];
  const { results: listRows } = await env.DB.prepare("SELECT DISTINCT json_extract(data, '$.list') AS list FROM tasks WHERE json_extract(data, '$.list') IS NOT NULL").all();
  const wanted = new Set(listRows.map(r => String(r.list).toLowerCase()));
  const lists = projects.filter(p => wanted.has(String(p.name).toLowerCase()));
  const pick = lists.length ? lists : projects;
  const found = new Map();
  const take = t => { for (const a of t.attachments || []) if (a?.id) found.set(a.id, { att: a.id, project: t.projectId, task: t.id, name: a.fileName || a.name || "file", size: a.size || 0 }); };
  for (const t of check.syncTaskBean?.update || []) if (pick.some(p => p.id === t.projectId)) take(t);
  for (const p of pick) {
    let to = new Date(Date.now() + 86400e3);
    const seen = new Set();
    for (let page = 0; page < 200; page++) {
      const batch = await ttJson(token, `/api/v2/project/${p.id}/completed/?from=${encodeURIComponent("2010-01-01 00:00:00")}&to=${encodeURIComponent(ttTime(to))}&limit=100`);
      const fresh = (batch || []).filter(t => !seen.has(t.id));
      fresh.forEach(t => { seen.add(t.id); take(t); });
      if (!fresh.length || (batch || []).length < 100) break;
      const oldest = fresh.map(t => new Date(t.completedTime || t.modifiedTime || 0)).filter(d => !isNaN(d)).sort((a, b) => a - b)[0];
      if (!oldest || oldest >= to) break;
      to = new Date(oldest.getTime() + 1000);   // TickTick's range is to the second; ids already seen are skipped
    }
  }
  return { found, lists: pick.map(p => p.name) };
}

async function counts(env) {
  const { results } = await env.DB.prepare("SELECT status, count(*) AS n FROM tt_files GROUP BY status").all();
  const c = { pending: 0, copied: 0, failed: 0, missing: 0 };
  for (const r of results) c[r.status] = r.n;
  return c;
}

export async function ttFilesRoute(request, env, url) {
  const path = url.pathname.replace(/\/$/, "");
  if (!path.startsWith("/api/tasks/ttfiles")) return null;
  if (!env.DB || !env.FILES) return fail(503, "Task storage isn't connected");
  await ensure(env);
  TT = env.TICKTICK_TEST_API || "https://api.ticktick.com";
  const method = request.method;

  if (path === "/api/tasks/ttfiles" && method === "GET") {
    const errors = (await env.DB.prepare("SELECT name, error FROM tt_files WHERE status = 'failed' LIMIT 5").all()).results;
    return Response.json({ connected: !!(await env.HUB.get(TOKEN_KEY)), counts: await counts(env), errors });
  }

  if (path === "/api/tasks/ttfiles/forget" && method === "POST") {
    await env.HUB.delete(TOKEN_KEY);
    return Response.json({ ok: true });
  }

  if (path === "/api/tasks/ttfiles/retry" && method === "POST") {
    await env.DB.prepare("UPDATE tt_files SET status = 'pending', error = NULL WHERE status = 'failed'").run();
    return Response.json({ ok: true, counts: await counts(env) });
  }

  if (path === "/api/tasks/ttfiles/connect" && method === "POST") {
    let token;
    try { token = await signIn(await request.json()); } catch (err) { return fail(400, err.message); }
    let found, lists;
    try { ({ found, lists } = await findAttachments(env, token)); }
    catch (err) { return fail(err.status === 401 ? 401 : 502, err.status === 401 ? "TickTick didn't accept that sign-in." : err.message); }
    await env.HUB.put(TOKEN_KEY, token, { expirationTtl: TOKEN_TTL });

    // Match TickTick's attachments to the hub's imported files by attachment id.
    const ours = new Map();
    const { results } = await env.DB.prepare(`SELECT id, data FROM tasks WHERE data LIKE '%"tt":"%'`).all();
    for (const r of results) for (const f of JSON.parse(r.data).files || []) if (f.tt) ours.set(f.tt, { task: r.id, copied: !!f.key });
    const now = new Date().toISOString();
    const stmts = [];
    for (const [att, our] of ours) {
      const a = found.get(att);
      const status = our.copied ? "copied" : a ? "pending" : "missing";
      stmts.push(env.DB.prepare(`INSERT INTO tt_files (att_id, tt_project, tt_task, our_task, name, size, status, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(att_id) DO UPDATE SET tt_project = ?2, tt_task = ?3, our_task = ?4, name = ?5, size = ?6,
          status = CASE WHEN tt_files.status = 'copied' THEN 'copied' ELSE ?7 END, updated_at = ?8`)
        .bind(att, a?.project || null, a?.task || null, our.task, a?.name || "", a?.size || 0, status, now));
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return Response.json({ ok: true, lists, inTickTick: found.size, counts: await counts(env) });
  }

  if (path === "/api/tasks/ttfiles/copy" && method === "POST") {
    const token = await env.HUB.get(TOKEN_KEY);
    if (!token) return fail(401, "Sign in to TickTick first.", { needSignIn: true });
    const started = Date.now();
    // A file that has started three runs without finishing most likely crashed them (too big, or TickTick stalled).
    await env.DB.prepare("UPDATE tt_files SET status = 'failed', error = 'Kept timing out, probably too big to copy here' WHERE status = 'pending' AND attempts >= 3").run();
    // Small batches, smallest files first, so each run finishes well inside the Worker's limits.
    const { results: batch } = await env.DB.prepare("SELECT * FROM tt_files WHERE status = 'pending' ORDER BY attempts, size, att_id LIMIT 4").all();
    let copied = 0, failed = 0;
    for (const f of batch) {
      if (Date.now() - started > 12000) break;
      await env.DB.prepare("UPDATE tt_files SET attempts = attempts + 1 WHERE att_id = ?").bind(f.att_id).run();
      let error = null, file = null;
      try {
        // ticktick.com's web app downloads from this path; try the API host first, then the main site.
        let res = null;
        for (const base of [TT, "https://ticktick.com"]) {
          try {
            const r = await fetch(`${base}/api/v1/attachment/${f.tt_project}/${f.tt_task}/${f.att_id}`, { headers: headers(token) });
            if (!res || r.ok || r.status === 401 || r.status === 403) res = r;
            if (r.ok) break;
          } catch (err) { if (!res) throw err; }
        }
        if (res.status === 401 || res.status === 403) return fail(401, "TickTick sign-in expired. Sign in again.", { needSignIn: true, counts: await counts(env) });
        if (!res.ok) throw new Error(`TickTick answered ${res.status}`);
        const length = Number(res.headers.get("Content-Length") || 0);
        if (length > MAX_FILE) throw new Error("Over 95 MB");
        // Stream straight into R2 when the size is known, so big files never sit in the Worker's memory.
        const body = length ? res.body.pipeThrough(new FixedLengthStream(length)) : await readCapped(res);
        const size = length || body.byteLength;
        const task = await getTask(env, f.our_task);
        const entry = task?.files?.find(x => x.tt === f.att_id);
        if (!entry) { await res.body?.cancel?.().catch(() => {}); await env.DB.prepare("UPDATE tt_files SET status = 'missing', updated_at = ? WHERE att_id = ?").bind(new Date().toISOString(), f.att_id).run(); continue; }
        const name = (entry.name || f.name || "file").replace(/[\/\\\r\n]/g, "_").slice(0, 180);
        const type = (res.headers.get("Content-Type") || "application/octet-stream").split(";")[0];
        const key = `tasks/${task.id}/${f.att_id.slice(-8)}/${encodeURIComponent(name).replace(/%/g, "~").slice(0, 200)}`;
        await env.FILES.put(key, body, { httpMetadata: { contentType: type }, customMetadata: { name, task: task.id, by: "TickTick" } });
        // Re-read just before writing so an edit made meanwhile isn't lost.
        const latest = await getTask(env, task.id) || task;
        file = { ...entry, key, size, type, at: entry.at || task.createdAt, by: "TickTick" };
        latest.files = (latest.files || []).map(x => (x.tt === f.att_id ? file : x));
        await upsertStmt(env, latest).run();
      } catch (err) { error = err.message; }
      await env.DB.prepare("UPDATE tt_files SET status = ?, error = ?, updated_at = ? WHERE att_id = ?")
        .bind(error ? "failed" : "copied", error, new Date().toISOString(), f.att_id).run();
      if (error) failed++; else copied++;
    }
    const c = await counts(env);
    if (!c.pending) await env.HUB.delete(TOKEN_KEY);   // done: drop the TickTick sign-in right away
    return Response.json({ ok: true, copied, failed, counts: c });
  }

  return null;
}

// No Content-Length: read it in, stopping as soon as it passes the size cap.
async function readCapped(res) {
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FILE) { await reader.cancel(); throw new Error("Over 95 MB"); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
