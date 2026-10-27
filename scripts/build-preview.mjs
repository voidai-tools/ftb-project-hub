// Builds dist/preview.html: the hub as a single static page with the seed data embedded,
// for viewing without the backend (no uploads; edits stay in the browser).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const seedDoc = JSON.parse(readFileSync(new URL("../data/seed.json", import.meta.url), "utf8"));
// Include projects added from chat, as the live Worker does.
const { projects: added } = JSON.parse(readFileSync(new URL("../data/additions.json", import.meta.url), "utf8"));
for (const p of added) if (!seedDoc.projects.some(x => x.id === p.id)) seedDoc.projects.push(p);
const seed = JSON.stringify(seedDoc);
const part = name => html.split(`<!--BUILD:${name}-->`)[1].split(`<!--/BUILD:${name}-->`)[0].trim();

const out = [part("HEAD"), part("BODY")].join("\n")
  .replace('<script type="application/json" id="seed">null</script>',
    `<script type="application/json" id="seed">${JSON.stringify(JSON.parse(seed)).replace(/</g, "\\u003c")}</script>`);

mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/preview.html", import.meta.url), out);
console.log("wrote dist/preview.html");
