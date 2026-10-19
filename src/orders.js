// Shop orders. Each order has its own KV key (order:<id>) so people editing at once never overwrite each other.
// Reading them all that way costs a list plus one read per order, and the TV and open tabs poll constantly,
// so we also keep one combined copy (orders:all) that a refresh can read in a single operation.
// Every write patches the combined copy; it's rebuilt from the per-order keys when older than REBUILD_MS,
// which also repairs it if two edits ever land at the same moment.

const ALL = "orders:all";
const REBUILD_MS = 15 * 60 * 1000;
const OUT_TTL = 60 * 60 * 24 * 30; // orders that have left the shop clear themselves out after 30 days
const OUT_MS = OUT_TTL * 1000;

async function rebuild(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.HUB.list({ prefix: "order:", cursor });
    keys.push(...page.keys.map(k => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const orders = (await Promise.all(keys.map(k => env.HUB.get(k, "json")))).filter(Boolean);
  const snap = { at: Date.now(), orders };
  await env.HUB.put(ALL, JSON.stringify(snap));
  return snap;
}

async function snapshot(env) {
  const snap = await env.HUB.get(ALL, "json");
  if (snap && Date.now() - snap.at < REBUILD_MS) return snap;
  return rebuild(env);
}

// The combined copy has no expiry of its own, so drop "out the door" orders past their 30 days here too.
const live = orders => orders.filter(o => o.status !== "out" || Date.now() - new Date(o.statusAt).getTime() < OUT_MS);

export async function listOrders(env) {
  return live((await snapshot(env)).orders);
}

export async function putOrders(env, changed) {
  if (!changed.length) return;
  await Promise.all(changed.map(o =>
    env.HUB.put(`order:${o.id}`, JSON.stringify(o), o.status === "out" ? { expirationTtl: OUT_TTL } : {})));
  const snap = await snapshot(env);
  const byId = new Map(snap.orders.map(o => [o.id, o]));
  for (const o of changed) byId.set(o.id, o);
  await env.HUB.put(ALL, JSON.stringify({ at: snap.at, orders: live([...byId.values()]) }));
}

export const putOrder = (env, order) => putOrders(env, [order]);

export async function deleteOrder(env, id) {
  await env.HUB.delete(`order:${id}`);
  const snap = await snapshot(env);
  await env.HUB.put(ALL, JSON.stringify({ at: snap.at, orders: snap.orders.filter(o => o.id !== id) }));
}
