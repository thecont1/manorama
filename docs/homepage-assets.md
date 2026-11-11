# Homepage assets

The marketing homepage (`/`) is the one page the world may find. Its pictures are
the only images it ships, and every one of them is a **capture of the product**, not
an illustration, a mock-up or a stock photograph.

This file is the checklist. It says what each slot wants, what is standing in for it
today, and what has to happen before the page can launch.

**Nothing here is persisted server-side.** The files live in `public/home/` as static
assets and are served straight from the edge. No provider media is proxied for this
page, and no capture is re-encoded at request time (AGENTS invariant 1).

---

## 1. The slots

| ID | What the slot is for | Where it sits on the page | Manifest id |
|---|---|---|---|
| H1 | The viewer, one photograph fitted | Hero, beside the words | `h1-viewer` |
| H2 | The Library: many photographs hanging together | Unify band, right column | `h2-matrix` |
| H3 | One photograph, fitted, chrome hidden | Features band, left of the pair | `h3-iphone` |
| H4 | The gallery opening, title set large | Features band, beside H3 | `h4-macos-curtain` |
| H5 | The same gallery on a larger screen | How it works, right column | `h5-ipad` |

The manifest is `app/components/home/home-manifest.ts`. Each asset carries a `status`:

- `approved` — cleared by the owner for the public page.
- `interim` — a real capture exists in the repository, but the owner has not cleared
  it for the public page yet. It ships as the stand-in and is listed below as a
  launch blocker.
- `placeholder` — no capture exists. The box holds the slot's exact ratio and reads
  as a surface, so nothing on the page shifts.

**Every asset on the page is `interim` today.**

---

## 2. What is standing in for each slot

| ID | Source capture | Source size | Served at | Formats | Status |
|---|---|---|---|---|---|
| H1 | `demo-captures/macos/03-first-image-hover.png` | 1440×900 | 1440 | AVIF, WebP, JPEG | interim |
| H2 | `demo-captures/ios/06-global-view.png` | 1284×2778 | 642, 1284 | AVIF, WebP, JPEG | interim |
| H3 | `demo-captures/ios/03-first-image-hover.png` | 1284×2778 | 642, 1284 | AVIF, WebP, JPEG | interim |
| H4 | `demo-captures/macos/02-gallery-curtain.png` | 1440×900 | 1440 | AVIF, WebP, JPEG | interim |
| H5 | `demo-captures/ipad/03-first-image-hover.png` | 2752×2064 | 1376, 2752 | AVIF, WebP, JPEG | interim |

The files were produced from those captures by `scripts/home-images.mjs`:

```sh
node scripts/home-images.mjs        # node only: sharp's native binding hangs under bun
```

It writes `public/home/<id>.{avif,webp,jpg}`, plus a `-sm` half-size variant for the
three tall captures (H2, H3, H5) so a phone does not download a 1284-pixel file for a
260-pixel column. The served file is never enlarged: `withoutEnlargement` is on, and
each `<picture>` carries the intrinsic `width`/`height` so the box is reserved and the
image is never stretched (invariant 13).

### Why these stand-ins, and what is wrong with them

- **All five come from one cleared gallery.** The "italia, amore mio" gallery is the
  only set of photographs the owner has cleared for public linking, so H1, H3, H4 and
  H5 all show the *same* frame. The page therefore reads as one photograph repeated
  rather than as a gallery. This is the single biggest thing wrong with the page's
  imagery, and it is fixed by the owner approving more captures, not by code.
- **H2 is not the Library the slot asks for.** The plan wants the desktop Library with
  pinned strips and compact cards. The interim capture is the iPhone Global View, which
  shows the same idea (photographs hanging together) at phone scale.
- **H4 is the gallery curtain, not a Local gallery in the Library.** The plan asks for
  the current SwiftUI macOS shell (`macos/ManoramaMac`) with the sidebar. The interim
  capture is the curtain from an earlier shell build.
- **H1 shows the hover state of the macOS viewer**, not the web Strip mode at
  `/thecontrarian/italy` the plan asks for. The web gallery in production serves only
  256-pixel renditions, so a full-width strip capture of the real web viewer cannot be
  taken with the rig in this repository (`specs/capture-harness.playwright.ts` needs a
  `CAPTURE_URL` for a deployed build).

### Captures that were considered and rejected

- `demo-captures/web/*` — the Library capture shows a **SPONSORED** ad plate.
- `demo-captures/macos/06-folder-grid.png` — shows a **"Sync failed"** state.
- The Bangkok "Foodie's Bangkok" captures — not owner-cleared.

---

## 3. The capture checklist

This is the plan's list, with what is still owed for each row.

| ID | Capture wanted | Aspect / size | Controls | Remove or check | Owed |
|---|---|---|---|---|---|
| H1 | Desktop web viewer, **Strip** mode, `/thecontrarian/italy`, mixed portrait and landscape frames abutting, black canvas, temporary chrome raised once | 16:10, captured at 2880×1800, served at 1440 and 2880 | Minimal: top bar only | Browser UI, account name, URL bar | A deployed build with full-size renditions, and the owner's pick of the gallery |
| H2 | Web or desktop Library with pinned strips, compact cards, one Local plus several cloud galleries with distinct, realistic titles | 16:10 | Library chrome | Owner email, private gallery titles, `hidden` section | A Library with more than one gallery in it |
| H3 | iPhone: one photograph fitted, `italy` | 9:19.5, 1290×2796, served at 430/860 | Chrome hidden on the main shot | Status bar time and carrier, no personal notifications | A fresh capture; the interim one shows the hover state |
| H4 | Current SwiftUI macOS shell (`macos/ManoramaMac`), **not** Tauri, showing a Local gallery in the Library with the sidebar | 16:10 | Native window chrome kept | Finder paths, usernames, local folder names | A capture of the current shell |
| H5 | iPad: one photograph fitted | 4:3 | Chrome hidden | Status bar, no notifications | Not in the plan's original list; added so the page has a tablet surface |

**The H2 rule.** If a composite is unavoidable, its caption says "Illustration".

**Capture process.** Reuse `specs/capture-harness.playwright.ts` for H1 and H2. Device
captures for H3, H4 and H5 follow the visual-evidence rules in `AGENTS.md`: freshly
built bundles, authorised source photographs, no editing of their pixels.

---

## 4. Platform facts the page states

The tiles in **Get Manorama** carry facts that were verified against the code rather
than assumed. Each one that is not yet true on the public page is a launch blocker.

| Surface | What the page says | Verified from | State |
|---|---|---|---|
| Web | "Open in your browser", links to the sign-in | Always published | Live |
| iPhone & iPad | "Encrypted offline copies on the device" | iOS deployment target 15.0 (`ios/App/App.xcodeproj`) | **No store URL** |
| Mac | "Local folders, opened in place" | `macos/ManoramaMac` (SwiftUI shell) | **No store URL**, min OS unconfirmed |
| Windows | "Local folders, opened in place" | `src-tauri/tauri.conf.json`, `minimumSystemVersion` 13.0 for the Tauri bundle | **No download URL** |

Arch: the desktop release workflow (`.github/workflows/desktop-release.yml`) builds
**macOS arm64 and x86_64 as two separate assets**, and Windows as both an `.msi` and an
`.exe`. There is no single universal Mac binary, so the tile must not claim one.

A surface with no published URL is **hidden in production** and shown in development
with a dashed tile reading "URL missing". There are no dead links on the page.

---

## 5. Launch blockers that belong to this page

1. **Owner approval for H1–H5.** Every capture on the page is interim. The page should
   not launch on unapproved photography.
2. **More than one photograph.** The interim captures all show the same frame.
3. **Store and download URLs** for iPhone & iPad, Mac and Windows, so the three tiles
   can appear in production.
4. **A product-true OG card.** The page still shares `/og-image.png`.
5. **Approved Apple and Google badge assets** for the sign-in buttons, if the official
   badges are to be used instead of the current monotone glyphs.

---

## 6. Changing an asset

1. Drop the new capture into `demo-captures/` (or wherever the rig writes).
2. Add or change the job in `scripts/home-images.mjs`, then run
   `node scripts/home-images.mjs`.
3. Update `ASSETS` in `app/components/home/home-manifest.ts`: the intrinsic
   `width`/`height` (the capture's own size), the `src` basename, the `alt` text, the
   `caption`, and the `status`.
4. `bunx tsc --noEmit`, `bun run test:unit`, and the browser matrix.
5. If the picture's proportions changed, check the caption under it and the column it
   sits in: a taller capture in the Unify band makes that column the taller one.

The alt text is not decoration. It is read aloud by a screen reader and it is what the
image search sees. Write it as a description of what is in the frame, not a caption of
what the product does.
