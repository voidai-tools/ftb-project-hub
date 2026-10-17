// Who is signed in. Cloudflare Access handles the login (an emailed code for @ftb.design addresses) and passes
// each request a signed token; we check that token here so a name on a comment can't be faked.
// Needs ACCESS_TEAM_DOMAIN (e.g. "ftb.cloudflareaccess.com") and ACCESS_AUD (the Access app's Audience tag) in wrangler.toml.
// Without them nobody counts as signed in, and comments stay read-only.
//
//   GET /api/me  -> { setup, signedIn, email, name }
//   PUT /api/me  -> { name } sets the display name shown on comments

let certs = { keys: null, at: 0 };

async function accessKeys(team) {
  if (certs.keys && Date.now() - certs.at < 3600e3) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: ${res.status}`);
  certs = { keys: (await res.json()).keys || [], at: Date.now() };
  return certs.keys;
}

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const decodeJson = s => JSON.parse(new TextDecoder().decode(b64url(s)));

// Returns the signed-in email, or null.
export async function currentEmail(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!team || !aud || !token) return null;
  const [head, body, sig] = token.split(".");
  if (!sig) return null;
  try {
    const header = decodeJson(head);
    const jwk = (await accessKeys(team)).find(k => k.kid === header.kid);
    if (!jwk || header.alg !== "RS256") return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${head}.${body}`));
    if (!ok) return null;
    const claims = decodeJson(body);
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud) || claims.iss !== `https://${team}` || claims.exp * 1000 < Date.now()) return null;
    return (claims.email || "").toLowerCase() || null;
  } catch {
    return null;
  }
}

// First name from the email until the person picks their own: ben.smith@ftb.design -> "Ben".
const defaultName = email => {
  const first = email.split("@")[0].split(/[._-]/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
};

export async function currentUser(request, env) {
  const email = await currentEmail(request, env);
  if (!email) return null;
  const saved = await env.HUB.get(`user:${email}`, "json");
  return { email, name: saved?.name || defaultName(email) };
}

export async function meRoute(request, env) {
  const user = await currentUser(request, env);
  const setup = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  if (request.method === "GET") return Response.json({ setup, signedIn: Boolean(user), ...user });
  if (request.method === "PUT") {
    if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
    const name = String((await request.json()).name || "").trim().slice(0, 40);
    if (!name) return Response.json({ error: "Name required" }, { status: 400 });
    await env.HUB.put(`user:${user.email}`, JSON.stringify({ email: user.email, name, updatedAt: new Date().toISOString() }));
    return Response.json({ ok: true, ...user, name });
  }
  return null;
}
