# FTB Project Hub

FTB Design's project hub: replaces the start.me pages. Each project holds its build pieces (quantity, build notes, stock, 3D viewers, packet links) and general link groups. 3D models are uploaded to FTB's own Autodesk Platform Services (APS) bucket with the **persistent** retention policy, so viewers never expire the way share links do.

## How it fits together

- `public/index.html`: the whole front end (no build step). Project tabs, piece cards, Autodesk Viewer v7 in a modal, edit mode, start.me bookmark import.
- `src/worker.js`: Cloudflare Worker. Serves `public/`, stores the hub in KV, issues read-only viewer tokens, and handles uploads and translation through APS. The APS client secret never reaches the browser.
- `data/seed.json`: the "Stuart Fails To Save The Universe" page transcribed from start.me. Used on first run until the hub is saved.
- `scripts/build-preview.mjs`: builds `dist/preview.html`, a static single-page preview with the seed embedded.

## Setup

1. Create an APS app at https://aps.autodesk.com (server-to-server / "Traditional Web App" with client credentials). Note the client ID and secret.
2. `npm install`
3. `npx wrangler kv namespace create HUB` and paste the id into `wrangler.toml`.
4. `npx wrangler secret put APS_CLIENT_ID` and `npx wrangler secret put APS_CLIENT_SECRET`.
5. `npm run deploy`.
6. In Cloudflare Zero Trust, put an Access policy on the site so only the FTB team can open and edit it.

For local dev, put the two APS values in `.dev.vars` and run `npm run dev`.

The bucket (`APS_BUCKET`, default `ftb-design-models`) is created on the first upload with `policyKey: "persistent"`. Bucket keys are global across APS, so change it if the name is taken.

## Roadmap

1. Hub + viewer (this repo).
2. Rhino 8 plugin `FTBPublish`: upload the open model and attach it to a hub piece in one command.
3. Assembly steps: Rhino panel to author steps (parts + approach direction) saved to `/api/models/:urn/steps`; the hub plays them back by animating part transforms in the viewer.
