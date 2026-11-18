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
| L1 | The Library itself, in its four appearances | Its own band, between Unify and How it works | `lib-dark`, `lib-quiet-dark`, `lib-quiet-light`, `lib-light` |

The page carries one still slot — H1, the hero's fallback when the live demo is
off — and the Library loop. The Unify, Features and How-it-works bands are text
only: the still captures that used to sit beside them (H2–H5) were retired when
the bands were rebuilt, and their files and manifest entries went with them.

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
| L1 | `demo-captures/library/01-dark-mode.png` … `04-light-mode.png` | 3456×2168 | 3456, never resized | WebP, lossless | interim |

The files were produced from those captures by `scripts/home-images.mjs`:

```sh
node scripts/home-images.mjs        # node only: sharp's native binding hangs under bun
```

It writes `public/home/<id>.{avif,webp,jpg}`. The served file is never enlarged:
`withoutEnlargement` is on, and each `<picture>` carries the intrinsic
`width`/`height` so the box is reserved and the image is never stretched
(invariant 13).

The four Library captures are published by their own script, because they are four
frames of one loop rather than four separate slots:

```sh
node scripts/home-library-images.mjs
```

**It never resizes them.** It writes `public/home/lib-*.webp` at the capture's own
3456×2168, and the size is checked on the way out rather than assumed: a file that
came back a pixel short would fail the script. The captures are 3456×2168 — a
1728×1084 window at 2× — and the band's canvas is held well under that width, so
every screen downsamples the same file and the picture is never stretched past its
own pixels.

The format is WebP, **lossless**. The four files are 18.6 MB rather than the 34 MB
the captures weigh, and the pixels that arrive are the pixels that were captured —
measured, not one of the 7,492,608 pixels in any of the four differs from the
capture by a single level. The profile, the EXIF and the XMP ride along inside the
file.

Two things worth knowing, both measured rather than assumed:

- The captures carry an sRGB profile *and* a cICP chunk declaring BT.2020 primaries
  at the same time. A **lossless PNG re-encode of them is not lossless in practice**:
  88% of the pixels moved, by as much as 163 levels. WebP's lossless path does not
  have that problem, which is the reason for the format.
- Writing the file back out through sharp re-encodes it, and sharp's defaults are
  lossy — a lossless WebP written that way comes out at a fifth of the size and
  visibly wrong. The bytes go down verbatim instead.

The acceptance spec holds both ends of this: the served file must be the capture's
own 3456×2168, and the browser's rendering of it must match the browser's
rendering of the capture *exactly* — the same pixels, not approximately.

Because the files are large enough to notice, the page asks for one at a time. Only
the first is in the markup, and it is lazy, so the band costs nothing until a
visitor comes to it; the loop fetches each capture as it reaches it and holds the
state on screen until the next one has arrived and been decoded.

The frame is steel and does not turn with the theme: the band is one object on the
page, not a piece of the page's chrome, so it reads the same in dark and in light.

### The Library band (L1)

The band is a loop: the four captures dissolve into one another on a clock, and the
frame's bottom rule — far thicker than the other three — holds the caption that names
the state on show. It is the only part of the page that moves on its own.

Two things about it are the owner's to decide:

- **The captures carry the Library's placeholder ad plate** in the left column — the
  house poster that stands in for sponsored photographs. It is not a third-party
  advertisement, and the owner has ruled that it may stay for this demo. The rule
  above rejected a Library capture for showing an ad plate at all, so the ruling
  does not extend to launch without a second look.
- **The owner's Library is in the frame**, with its own galleries, its own counts and
  its own device names. The names in it are place-city names rather than private
  titles, and the account line is the product's own copy — but the page is public,
  so the captures need the owner's eye before launch.

### Why this stand-in, and what is wrong with it

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
| L1 | The desktop Library in its four appearances — dark, quiet and dark, quiet and light, light — one Library captured four times so the dissolve reads as the words going out | 16:10, captured at 3456×2168 (a 1728×1084 window at 2×), served at 3456 as lossless WebP, never resized | Library chrome, in a steel frame that does not turn with the theme | The placeholder ad plate in the left column, which the owner has allowed to stay for this demo; the owner's own gallery titles, counts and device names | The owner's approval of the captures before launch |

**Capture process.** Reuse `specs/capture-harness.playwright.ts` for H1. Device
captures follow the visual-evidence rules in `AGENTS.md`: freshly built bundles,
authorised source photographs, no editing of their pixels.

---

## 4. Platform facts the page states

The tiles in **Get Manorama** carry facts that were verified against the code rather
than assumed. Each one that is not yet true on the public page is a launch blocker.

| Surface | What the page says | Verified from | State |
|---|---|---|---|
| Web | "Open in your browser", links to the sign-in | Always published | Live |
| iPhone & iPad | "Encrypted offline copies on the device" | iOS deployment target 15.0 (`ios/App/App.xcodeproj`) | **No store URL** |
| Mac | "Local folders, opened in place" | `macos/ManoramaMac` (SwiftUI shell) | Direct download: `downloads.manorama.xyz/mac` (arm64 DMG, no store listing) |
| Windows | "Local folders, opened in place" | `src-tauri/tauri.conf.json`, `minimumSystemVersion` 13.0 for the Tauri bundle | Direct download: `downloads.manorama.xyz/windows` |

Arch: the desktop release workflow (`.github/workflows/desktop-release.yml`) builds
macOS as **arm64 and x86_64 Tauri legs**, but those legs are deprecated — the shipped
macOS asset is the arm64-only SwiftUI DMG served from `downloads.manorama.xyz`. Windows
ships as both an `.msi` and an `.exe`. There is no single universal Mac binary, so the
tile must not claim one.

A surface with no published URL is **hidden in production** and shown in development
with a dashed tile reading "URL missing". There are no dead links on the page.

---

## 5. Launch blockers that belong to this page

1. **Owner approval for H1 and L1.** Every capture on the page is interim. The page
   should not launch on unapproved photography. L1 is the one that most needs it: it
   is the owner's own Library, on a band that moves. The ad plate in it is settled
   for the demo; the captures themselves are not yet approved.
2. **App Store URL** for iPhone & iPad — the only surface still hidden in production.
   Mac and Windows publish through `downloads.manorama.xyz`.
3. **A product-true OG card.** The page still shares `/og-image.png`.
4. **Approved Apple and Google badge assets** for the sign-in buttons, if the official
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
5. If the picture's proportions changed, check the caption under it and the band it
   sits in: a taller capture in the hero makes the first fold taller.

The alt text is not decoration. It is read aloud by a screen reader and it is what the
image search sees. Write it as a description of what is in the frame, not a caption of
what the product does.
