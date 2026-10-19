// One-way sync from a TickTick list (default "CNC HUB") into shop board orders.
// Open tasks on the list show up as CNC jobs in progress; when a task is checked off in TickTick,
// its order moves to Build. From there it goes to paint or Completed by hand on the board.
//
// Setup: register an app at developer.ticktick.com with redirect URL https://<site>/api/ticktick/callback,
// add TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET as Worker secrets, then open /api/ticktick/connect once.

import { listOrders, putOrders } from "./orders.js";

const TT_API = "https://api.ticktick.com/open/v1";
const TOKEN_KEY = "ticktick:token";

export async function ticktickRoute(request, env, url) {
  const redirect = `${url.origin}/api/ticktick/callback`;

  if (url.pathname === "/api/ticktick/connect") {
    const state = crypto.randomUUID();
    await env.HUB.put(`ticktick:state:${state}`, "1", { expirationTtl: 600 });
    const auth = new URL("https://ticktick.com/oauth/authorize");
    auth.search = new URLSearchParams({ client_id: env.TICKTICK_CLIENT_ID, scope: "tasks:read", state, redirect_uri: redirect, response_type: "code" });
    return Response.redirect(auth.toString(), 302);
  }

  if (url.pathname === "/api/ticktick/callback") {
    const state = url.searchParams.get("state");
    if (!state || !(await env.HUB.get(`ticktick:state:${state}`))) return new Response("This TickTick link expired. Open /api/ticktick/connect again.", { status: 400 });
    await env.HUB.delete(`ticktick:state:${state}`);
    const res = await fetch("https://ticktick.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.TICKTICK_CLIENT_ID}:${env.TICKTICK_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: url.searchParams.get("code") || "", grant_type: "authorization_code", scope: "tasks:read", redirect_uri: redirect }),
    });
    if (!res.ok) return new Response(`TickTick sign-in failed: ${res.status} ${await res.text()}`, { status: 502 });
    const token = await res.json();
    await env.HUB.put(TOKEN_KEY, JSON.stringify({ access_token: token.access_token, expires_at: Date.now() + (token.expires_in || 0) * 1000 }));
    const result = await syncTicktick(env);
    return Response.redirect(`${url.origin}/?ticktick=${result.ok ? "connected" : "error"}#pickup`, 302);
  }

  if (url.pathname === "/api/ticktick/sync" && request.method === "POST") {
    return Response.json(await syncTicktick(env));
  }

  if (url.pathname === "/api/ticktick/status") {
    const token = await env.HUB.get(TOKEN_KEY, "json");
    const last = await env.HUB.get("ticktick:last-sync", "json");
    return Response.json({ connected: !!token, expiresAt: token?.expires_at || null, lastSync: last });
  }

  return null;
}

async function tt(env, token, path) {
  const res = await fetch(TT_API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`TickTick ${path} failed: ${res.status}`);
  return res.json();
}

export async function syncTicktick(env) {
  const token = (await env.HUB.get(TOKEN_KEY, "json"))?.access_token;
  if (!token) return { ok: false, reason: "not connected" };
  const listName = (env.TICKTICK_LIST || "CNC HUB").toLowerCase();
  try {
    const projects = await tt(env, token, "/project");
    const list = projects.find(p => p.name.toLowerCase() === listName);
    if (!list) return { ok: false, reason: `no TickTick list named "${env.TICKTICK_LIST || "CNC HUB"}"` };
    const data = await tt(env, token, `/project/${list.id}/data`);
    // Top-level open tasks only; checklist items and subtasks stay in TickTick.
    const open = (data.tasks || []).filter(t => t.status === 0 && !t.parentId);
    const openIds = new Set(open.map(t => t.id));
    const now = new Date().toISOString();
    let added = 0, toBuild = 0;

    const byId = new Map((await listOrders(env)).map(o => [o.id, o]));
    const changed = [];
    for (const t of open) {
      const existing = byId.get(`tt-${t.id}`);
      if (!existing) {
        changed.push({
          id: `tt-${t.id}`, title: t.title, dept: "CNC", status: "in-progress", statusAt: now, createdAt: now,
          notes: t.content || "", source: "ticktick", ticktickId: t.id,
        });
        added++;
      } else if (existing.title !== t.title) {
        changed.push({ ...existing, title: t.title });
      }
    }

    // Orders from TickTick still on the CNC whose task is no longer open were checked off: send them to Build.
    for (const o of byId.values()) {
      if (o.source === "ticktick" && o.status === "in-progress" && o.dept === "CNC" && !openIds.has(o.ticktickId)) {
        changed.push({ ...o, status: "ready-build", statusAt: now });
        toBuild++;
      }
    }
    await putOrders(env, changed);

    const result = { ok: true, list: list.name, open: open.length, added, toBuild, at: now };
    await env.HUB.put("ticktick:last-sync", JSON.stringify(result));
    return result;
  } catch (err) {
    const result = { ok: false, reason: err.message, at: new Date().toISOString() };
    await env.HUB.put("ticktick:last-sync", JSON.stringify(result));
    return result;
  }
}
