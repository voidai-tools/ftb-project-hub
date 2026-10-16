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

## Shop board and lobby TV

The **Shop** tab tracks orders through Queued, In progress, Build, Ready for paint, Completed and Out the door.

- When a part comes off the machine, click **Send to build** if it needs assembly, **Ready for paint** if it needs finishing, or **Completed** if it's done. The next shop clicks **Start build** or **Start paint** to take it over (CNC, then build, then paint, skipping what a part doesn't need).
- On a completed order, tap where it goes next: **Pickup**, **Wrap for truck**, **FOH table** or **Ship**. A completed order with no tag for more than 4 hours turns amber.
- Click **Out the door** once it's gone.

For the lobby screen, open `https://ftbshop.fun/#tv` on the TV's browser, sign in once, and leave it. It shows CNC, Build and Paint side by side with how long each job has been there, plus a narrow Completed column showing where each finished piece goes. Queued orders stay off the TV. It refreshes every 30 seconds; double-click exits.
