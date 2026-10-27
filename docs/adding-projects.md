# Adding projects and builds

## Quickest: ask Claude in the project chat

Post something like this and Claude adds it to the hub:

```
New project: Cash App Kiosks
Client: Cash App · Status: In design
Pieces:
- Kiosk Shell ×4: notes "panels numbered clockwise from the screen side"; stock 3/4" Baltic birch, 1/2" MDF
- Signage Header ×4
Links: packet https://docs.google.com/presentation/d/…, Drive folder https://drive.google.com/…
Models: (attach .3dm files, one per piece)
```

Anything you leave out can be filled in later. Attach Rhino files and Claude uploads them into FTB's permanent storage and links each one to its piece.

Adding a build later works the same way: "Add a Kiosk Base ×4 to Cash App Kiosks, here's the .3dm and packet link."

## Yourself, in the hub

1. Turn on **Edit** (top right).
2. **+ Project** in the tabs. New projects start from the FTB template: Resources + Files (packet, fabrication models, overview), Cheat Sheets, Signage Templates.
3. **+ Add piece or link group** at the end of the board. New pieces start with one viewer slot and a Build Packet Reference Page link.
4. For a build that's like an existing one, use **⧉ Duplicate** on its card: it keeps the notes, stock and link titles, and clears the model and addresses.
5. In a piece, **Upload model** sends the file to permanent storage. The tile shows "Processing" and then "Saved in FTB storage".

## What a piece holds

| Field | Example |
|---|---|
| Name | Curved Display Table |
| Build quantity | 2 |
| Shared with client | on/off |
| Build notes | one line each: "Uprights 1-10 left to right" |
| Stock / materials | 3/4" MDF, 1/2" MDF, 3/4" Plywood |
| 3D viewers | uploaded model (permanent) or an Autodesk share link (can expire) |
| Files + links | packet page, .3dm / .skp downloads, cut files, PDFs |

**Paint notes:** each piece has a Paint notes box in its editor (colors, sheen, primer, masking). They show on the card under a red "Paint" label.

**Archiving:** when a job wraps, turn on Edit, open **Project settings** and tick **Archived**. It leaves the top bar and moves into **Project Archive** (top right, next to Gallery): a folder for each archived project, grouped by the year it was archived, with its latest photo and first few pieces on the folder. Search there covers names, notes, links and materials; click a folder to open the project as normal. An archived project's page has **Back to archive** and **Unarchive** buttons.

**Project pages** fill the screen with columns of cards, then continue to the right. Use the ← → arrows or a mouse wheel to move sideways, or click a piece's name in the bar above the cards to jump straight to it. Phones still show one long column.

## 3D Print / Trophies board

The Shop tab has two boards: **Shop** and **3D Print / Trophies** (switch at the top). The print board runs Printing → Post-processing → Assembly → Paint → Completed and works the same way as the Shop board. Its lobby view is `https://ftbshop.fun/#tv-print`.

## Shop board and lobby TV

The **Shop** tab has the same columns as the lobby TV: **CNC**, **Build**, **Paint** and **Completed**, plus a **Queued** column on the left that stays off the TV. Inside each shop column, jobs marked **Waiting** are ready for that shop and haven't been started; the rest are being worked on (Cutting, Building, Painting).

- When a shop finishes a part, click **To build**, **To paint** or **Completed** on its card. It shows up as Waiting in that column until that shop clicks **Start build** or **Start paint** (CNC, then build, then paint, skipping what a part doesn't need). A waiting card can also skip ahead.
- To put a card anywhere by hand, click ✎ and change **Where is it**.
- On a completed order, tap where it goes next: **Pickup**, **Wrap for truck**, **FOH table** or **Ship**. A completed order with no tag for more than 4 hours turns amber.
- Click **Out the door** once it's gone.

For the lobby screen, open `https://ftbshop.fun/#tv` on the TV's browser, sign in once, and leave it. It shows CNC, Build and Paint side by side with how long each job has been there, plus a narrow Completed column showing where each finished piece goes. Queued orders stay off the TV. It refreshes every 30 seconds; double-click exits.

## TickTick CNC list

The hub can follow the **CNC HUB** list in TickTick. Every open task there shows up on the Shop board as a CNC job in progress (marked "TickTick"), and checking a task off in TickTick moves it to Build. From there you move it by hand: **Start build**, **To paint**, or **Completed** (then tag it Pickup, Wrap for truck, FOH table or Ship). The sync runs every 5 minutes, or right away with **Sync TickTick** on the Shop tab. It only reads TickTick; nothing on the board changes your TickTick tasks.

One-time setup:
1. At developer.ticktick.com, sign in, open **Manage Apps**, and create an app. Set its redirect URL to `https://ftbshop.fun/api/ticktick/callback`.
2. In Cloudflare, add the app's Client ID and Client Secret to the Worker as secrets named `TICKTICK_CLIENT_ID` and `TICKTICK_CLIENT_SECRET`.
3. On the Shop tab, click **Connect TickTick** and approve.

## Sign-in and comments

Everyone signs in through Cloudflare Access with their @ftb.design email (a code is emailed to them). Their name and initials show at the top right; click it to change the name that appears on comments.

Every piece or link group on a project page has a **Comments** button at the bottom of its card. Open it to read the thread and post (Ctrl+Enter posts). You can delete your own comments.

Setup (done 2026-10-19 for ftbshop.fun):
1. In Zero Trust, go to **Access > Applications** and add a self-hosted app for `ftbshop.fun` with an Allow rule for emails ending in `@ftb.design`.
2. Copy the app's **Application Audience (AUD) Tag** (on the app's overview) and your team domain (Zero Trust **Settings > Custom Pages**, e.g. `ftb.cloudflareaccess.com`).
3. Put them in `wrangler.toml` as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` (they aren't secret) and push. Until then, comments are read-only.

## Job photos and the Gallery

Every project page has a **Photos** strip above the pieces. Tap **+ Add photos** on a phone to take a picture or pick several from the camera roll, optionally choose which piece they show and add a caption, then **Upload**. Photos are shrunk on the phone first (about 2,500 px on the long side), so they upload fast and storage stays small. Tap any photo to see it full size; swipe or use the arrow keys to move through them. You can delete photos you uploaded.

The **Gallery** button (top right) collects every photo, one album per project (archived projects included). An album shows its photos grouped by day, newest first, and can be filtered by piece. Links like `ftbshop.fun/#gallery/<project-id>` open an album directly.

Photos are stored in the Cloudflare R2 bucket `ftb-photos` (bound to the Worker as `PHOTOS` in `wrangler.toml`). Only signed-in team members can see the site, so "public" means everyone on the team sees every photo.

## Projects added from chat

When Ben posts a new project in the project chat, Claude adds it to `data/additions.json` and pushes. On the next page load the Worker adds each listed project to the live hub once (it remembers which in `hub.addedIds`), so editing or deleting it afterwards in the hub sticks. No login token is needed.

## Reference images on pieces

Each piece can carry reference images, such as a screenshot from the build packet. Turn on **Edit**, click ✎ on the piece, then paste a screenshot anywhere in the editor (Ctrl+V or ⌘V) or click **+ Image**, and Save. The image shows on the card under the 3D viewer; click it to see it full size. Reference images are stored in R2 under `refs/` and stay out of the Gallery.
