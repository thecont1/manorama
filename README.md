# manorama

Manorama is a photography-first way to share beautiful galleries with friends and family. Point it at a photo folder you already share — Dropbox, Google Drive, iCloud, or MEGA — and it becomes a calm, full-screen gallery at `manorama.xyz/{you}/{gallery}`.

Your photos stay where they are. Manorama keeps only a list of what's in the folder and streams the pictures through when someone views the gallery — nothing is copied, re-compressed, or cropped, and removing a gallery never deletes anything at the source.

And it meets you where you are: the same galleries open on the web, in the iOS app, and in the macOS desktop app — one account, one namespace, everywhere.

## Getting started

Sign in at `manorama.xyz` with Apple, Google, or Dropbox — that becomes your namespace. Then either:

- **Paste a share link** on your dashboard and choose **Manorama-fy it!**, or
- **Skip the dashboard entirely**: append the share URL to the origin — `manorama.xyz/https://www.dropbox.com/scl/fo/…` or `manorama.xyz/mega.nz/collection/…#key` — and the gallery creates itself and opens. Signed-out visitors get a friendly detour through sign-in and land in the finished gallery.

What you can share:

| Provider | What to share | Notes |
| --- | --- | --- |
| Dropbox | A public shared folder with downloading enabled | Photos |
| Google Drive | A folder shared with "Anyone with the link" | Photos |
| iCloud | A Photos Shared Album link | Photos **and video** |
| MEGA | A folder or collection ("Sets") link | Photos |

Manorama detects the provider from the link, ignores files it can't display, and lets you arrange the gallery before it's added. Quick-add galleries get a three-word name like `ember-tide-fern` so the public URL reads like a title; dashboard galleries keep the folder's own name.

## Sharing

Every gallery lives at a clean public URL — `manorama.xyz/{you}/{gallery}` — and link previews get a cover card composed from the first photograph. Galleries are marked `noindex`, so they're for the people you send the link to, not for search engines.

## Looking at a gallery

The stage shows only your photographs — a small bobbing Manorama pill at the bottom edge is the only visible chrome. Press it (or wave the mouse near it) for display settings.

- **Three ways to look**: a horizontal photostrip where images abut edge-to-edge, a vertical scroll, or one photograph at a time.
- **Navigate** by dragging, scrolling, arrow keys, or optional on-screen arrows (off by default on touch and in vertical scroll). A quiet bubble at the bottom-right counts the photograph you're on — it's also a button: hover stretches it into a pill ("5 of 56 items" / "open global"), and click (or `G`) raises the selector filmstrip.
- **`I`** opens the information sheet — position, caption, EXIF, Content Credentials. **`⇧I`** opens the standalone C2PA viewer in a new tab.
- **`M`** on desktop summons a magnifier that follows your cursor at 3×.
- **The strip ends honestly**: a "The End." card slides in past the last photograph, with **Back to Start** to loop around.
- **Video** plays ambient — muted and looping — with a speaker button for sound.
- **Background** offers None (the default — photographs abut on a plain dark canvas), Dark, or Light — the latter two wake a subtle doodle field and give every image a 10px margin.

Images always fit the stage whole — never cropped, never enlarged past their real resolution. Smaller sources float at their honest size rather than stretching.

## The iOS app

The native app is the same viewing experience, plus what a phone can do that a browser cannot:

- **Encrypted vault** — gallery thumbnails live on-device under AES-256-GCM, keys in the system keychain. Nothing is readable off-device, and nothing is uploaded.
- **True offline** — save a gallery once and view it with zero connectivity; **Global View** can index every saved frame into one grid.
- **On-device curation** — near-duplicate detection and sequence suggestions run locally; your photos never leave the phone for it.
- **Made for the hardware** — fold-aware diptych layouts, high refresh rate where the display allows it, honest HDR reporting.

## The desktop app

The desktop app (macOS and Windows) is a local-first viewer for folders and memory cards on disk — it opens folders in place and never moves, copies, or renames a file. Sharing a local gallery to a public Manorama URL is an explicit, confirmed action — nothing leaves the machine otherwise.

## Your dashboard

`manorama.xyz/{you}` lists your galleries newest-first. Click a title, caption, or slug to edit it inline — the public URL follows the slug. Drag thumbnails in the media rail to reorder; every row exposes its public URL, a copy button, refresh-from-source, and delete. Account settings let you change your URL, unlink a sign-in method, or delete the account entirely.

## Plans

Free accounts keep up to **3 editable galleries**. Creates beyond that still work — they become temporary galleries: public and shareable, but read-only, expiring after 30 days (the card shows the deadline and an upgrade link). **Pro** raises the cap to 99, promotes still-live temporary galleries back to editable, and widens the iOS vault — subscribe in the app or on the web.

## Privacy

Originals are never persisted — media streams through Manorama at view time and nothing is uploaded, transcoded, or modified. On-device vault contents never reach the server; the desktop catalogue syncs only gallery titles and counts, never paths or filenames. Deleting a gallery removes only Manorama's reference to it, and deleting your account removes every row — nothing at any provider is touched. The full policy lives at `/privacy`.

---

`G` raises the selector: a filmstrip mid-screen. Drag to browse, hover or arrow keys move the pink box, click or Enter jumps to it.

*For developers: architecture, media pipeline, the viewer contract, the native and desktop shells, and deployment live in [TECH-SPEC.md](TECH-SPEC.md).*
