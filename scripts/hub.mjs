// Pull or push the live hub document, so projects can be added from the command line (or by Claude).
//   node scripts/hub.mjs pull  -> writes data/hub.json from the live site
//   node scripts/hub.mjs push  -> uploads data/hub.json to the live site
// Needs HUB_URL, plus CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (a Cloudflare Access service token).
import { readFileSync, writeFileSync } from "node:fs";

const [cmd] = process.argv.slice(2);
const { HUB_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = process.env;
if (!HUB_URL || !["pull", "push"].includes(cmd)) {
  console.error("usage: HUB_URL=https://hub.example.com node scripts/hub.mjs pull|push");
  process.exit(1);
}
const headers = {
  "Content-Type": "application/json",
  ...(CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET } : {}),
};
const file = new URL("../data/hub.json", import.meta.url);

if (cmd === "pull") {
  const res = await fetch(`${HUB_URL}/api/hub`, { headers });
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  writeFileSync(file, JSON.stringify(await res.json(), null, 2) + "\n");
  console.log("wrote data/hub.json");
} else {
  const res = await fetch(`${HUB_URL}/api/hub`, { method: "PUT", headers, body: readFileSync(file, "utf8") });
  if (!res.ok) throw new Error(`push failed: ${res.status} ${await res.text()}`);
  console.log("pushed", await res.json());
}
