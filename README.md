# manorama

Manorama is a photography-first way to share beautiful galleries with friends and family. Point it at a photo folder you already share — Dropbox, Google Drive, iCloud, Google Photos, MEGA, Ente, Proton Drive — and it becomes a calm, full-screen gallery at `manorama.xyz/{you}/{gallery}`.

Your photos stay where they are. Manorama keeps only a list of what's in the folder and streams the pictures through when someone views the gallery — nothing is copied, re-compressed, or cropped, and removing a gallery never deletes anything at the source.

And it meets you where you are: the same galleries open on the web, in the iOS app, and in the desktop app for macOS and Windows — one account, one namespace, everywhere.

## Look before you sign in

`manorama.xyz` opens on a page you can actually use. The photographs in the middle are not a video — it is the real gallery viewer, running live in a device frame, opening its curtain, travelling through the photographs, and ending on the "The End." card.

You can switch the frame between desktop, mobile, tablet and a foldable book pose, pause it, and open the same gallery full-size in a new tab. The photographs are the owner's own, published for the page with his permission.

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
| Google Photos | A public shared-album link (`photos.google.com/share/…` or `photos.app.goo.gl/…`) | Photos **and video** |
| MEGA | A folder or collection ("Sets") link | Photos, decrypted on your device |
| Ente | A public album link (`albums.ente.io/…`) | Photos, decrypted on your device |
| Proton Drive | A public share link, with the password that comes with it | Photos — the apps only; Proton will not serve a browser |

Manorama detects the provider from the link, ignores files it can't display, and lets you arrange the gallery before it's added. Quick-add galleries get a three-word name like `ember-tide-fern` so the public URL reads like a title; dashboard galleries keep the folder's own name.

The three encrypted sources — MEGA, Ente and Proton Drive — are scanned and decrypted on your own device, never on a server. MEGA and Ente work in the browser as well as in the apps, in a tab that holds the key. Proton Drive refuses to serve a browser at all, so those galleries are added from the iOS, iPad, Mac or Windows app — the web still shows them in your Library, as a card you can open in the app.

## Sharing

Every gallery lives at a clean public URL — `manorama.xyz/{you}/{gallery}` — and link previews get a cover card composed from the first photograph. Galleries are marked `noindex`, so they're for the people you send the link to, not for search engines.

## Looking at a gallery

The stage shows only your photographs — the chrome is temporary. A tap, mouse move, or `Tab` raises a top bar (Library, position) and a bottom row (Gallery Settings, Info); they hide again after three idle seconds.

- **Three ways to look**: a horizontal photostrip where images abut edge-to-edge, a vertical scroll, or one photograph at a time — all inside the Display sheet.
- **Navigate** by dragging, scrolling, arrow keys, or optional on-screen arrows (off by default on touch and in vertical scroll). The position count rides the temporary chrome — press it (or `G`) to open the photograph picker.
- **`I`** opens the information sheet — position, caption, EXIF, Content Credentials. **`⇧I`** opens the standalone C2PA viewer in a new tab.
- **`M`** on desktop summons a magnifier that follows your cursor at 3×.
- **The strip ends honestly**: a "The End." card slides in past the last photograph, with **Rewind** to run home.
- **Video** plays ambient — muted and looping — with a speaker button for sound.
- **Canvas** offers Dark or Light — both show the same fine, dense photographic texture of cameras, film and darkroom objects, repeating every 256px in charcoal or warm-paper ink. Every image carries a 10px margin, so strip neighbours sit a gutter apart over the artwork. Dark is the default; the old Blank canvas was retired by the owner.

Images always fit the stage whole — never cropped, never enlarged past their real resolution. Smaller sources float at their honest size rather than stretching.

## Your Library

`manorama.xyz/{you}` is where everything lands. It is deliberately quiet: four sections you can fold away — **Pinned**, **Cloud**, **Local** and **Hidden** — each with a chevron, and the Library opens with them all showing so you can see the shape of your collection at a glance.

The app's opening screens, Library, Settings and sheets share the approved 256px photographic texture, in stronger charcoal or warm-paper ink following the owner theme. Previously transparent controls, sponsored containers and gallery cards/strips have theme-matched translucent backings; primary buttons and selected states retain their solid fills. Reduced transparency or increased contrast makes those backings opaque. Galleries start on the Dark canvas; their own Dark/Light choices are independent of the app theme. The public marketing homepage does not use the app texture.

- **Pinned galleries** get a full filmstrip in the Pinned section — the card also stays in Cloud or Local, exactly where it was. Pinning is a display choice; it never changes how long a gallery lives.
- **Cloud galleries** settle into a fluid grid where each card keeps its own photograph's proportions. Nothing is cropped to fill a box.
- **Local galleries** — the folders your Mac has shared with your account — arrive as a dense grid of small tiles with no thumbnails, on the web and on your phone. The names and counts are metadata; the paths never leave the Mac.
- **Hidden galleries** stay out of the way until you want them, and adding a gallery always reveals the section it landed in.

**Manorama notices new photographs by itself.** Open your Library and it quietly checks each gallery's source at the provider, compares it with what you already have, and refreshes the ones that moved. You don't press a button to find out that you added photos to the album. The check is cheap, runs at most once a day per gallery, and stays silent — a source check never makes the Library slower or louder. Proton Drive galleries are the exception: their source is checked only in the Manorama app, never in the browser.

**Gallery settings live in one place.** Open a gallery and press the settings pill for the things you do often — share the link, reorder photographs, read the folder again. Everything else — the name, the caption, the address, opening the source, removing the gallery — sits behind **More Settings**. The same surface is shared by the web, the desktop app and the viewer, so it behaves identically wherever you open it.

The gallery's name, caption and address are edited from that same Gallery Settings sheet — change the address and the public URL follows it. Reordering and hiding photographs happen inside the gallery itself: open the photograph picker with `G` and switch it to Edit mode.

Account settings let you change your own URL, unlink a sign-in method, or delete the account entirely.

## The iOS app

The native app is the same viewing experience, plus what a phone can do that a browser cannot:

- **Encrypted vault** — gallery thumbnails live on-device under AES-256-GCM, keys in the system keychain. Nothing is readable off-device, and nothing is uploaded.
- **True offline** — save a gallery once and view it with zero connectivity; **Global View** can index every saved frame into one grid.
- **On-device curation** — near-duplicate detection and sequence suggestions run locally; your photos never leave the phone for it.
- **Made for the hardware** — fold-aware diptych layouts, high refresh rate where the display allows it, honest HDR reporting.

## The desktop app

The desktop app (macOS and Windows) is a local-first viewer for folders and memory cards on disk — it opens folders in place and never moves, copies, or renames a file. Sharing a local gallery to a public Manorama URL is an explicit, confirmed action — nothing leaves the machine otherwise.

The Mac build is a sandboxed native app: folders are reached through a security-scoped grant that only the folder picker can create, and gallery keys live in the data-protection Keychain under a shared team access group rather than in browser storage.

## Plans

Free accounts keep up to **3 permanent galleries** plus **96 temporary galleries**. Creates beyond the permanent three still work — they become temporary galleries: public and shareable, but read-only, expiring after 30 days (the card shows the deadline and an upgrade link).

**Visionary** costs $12 for your first year, then $20 a year. It raises the permanent cap to 99 and promotes every still-live temporary gallery back to permanent, and it includes local galleries in the desktop apps. Subscribe in the app or on the web.

## Downloads

`downloads.manorama.xyz` holds every release, with its notes: what changed, and the installers it shipped. The links are stable — `/mac`, `/windows`, `/linux`, `/android` — so a page that points at the Mac build keeps working after the version number moves on. The page carries the same wordmark, nav and theme as the rest of manorama.xyz, and the colour theme you pick on one follows you to the other.

## Privacy

Originals are never persisted — media streams through Manorama at view time and nothing is uploaded, transcoded, or modified. On-device vault contents never reach the server; the desktop catalogue syncs only gallery titles and counts, never paths or filenames. Deleting a gallery removes only Manorama's reference to it, and deleting your account removes every row — nothing at any provider is touched. The full policy lives at `/privacy`.

---

`G` opens the photograph picker: a scrollable matrix of the gallery's frames. Arrow keys move the pink highlight, click or Enter jumps to it.

*For developers: architecture, media pipeline, the viewer contract, the native and desktop shells, and deployment live in [TECH-SPEC.md](TECH-SPEC.md).*
