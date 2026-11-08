# Plan: Bridge the macOS (Tauri) app's UI/UX to the web app

Status: draft · Owner: Mahesh · Source of truth for the "right" look: the web
Library at `manorama.xyz/thecontrarian` (screenshot captured 2026-11-06).

## 0. What's actually broken today (evidence)

### 0.1 The installed app is stale
- `/Applications/manorama.app` reports `version 0balb5e` and is `0.2.5` (tauri.conf).
- Commit `0balb5e` is **not** in this repository's history — the build predates
  the desktop work that landed on `main` in the last two commits:
  - `9ba1b5e` — draggable top bar; CSP `img-src` for cloud previews; cloud
    manifest fetched and rendered in-app.
  - `e901d75` — top bar drag region moved to the rail; build-commit tag; in-app
    cloud gallery viewing with external fallback.
- Consequence in the installed build: cloud gallery thumbnails render as empty
  frames (CSP), the window cannot be dragged from the title area, there is no
  build tag, and account galleries open in a browser tab instead of in-app.

### 0.2 Data-binding bug in the sidebar (visible in the installed screenshot)
The rail reads `This Mac · 0 galleries · 0 photographs · Catalogue syncs quietly…`
while the main list renders `italia`, `Scans`, `Madhya Pradesh` with 28/4/31
photos. The code path is `catalogue.deviceLabel · galleries.length · photoCount`
(Catalogue.tsx ~937). Either the installed build's catalogue deserialisation
returns an empty `galleries` array that the render then overwrites, or the rail
and the list are reading different catalogue snapshots. Reproduce in the rebuilt
app before assuming it's fixed — the rebuild alone may not address it.

### 0.3 Visual/UX gaps vs. the web Library (from side-by-side comparison)

| # | Web (reference) | macOS (current code) | Gap |
|---|---|---|---|
| 1 | Two sections: **"Pinned galleries"** (strips) + **"Your galleries"** (compact cards) | One flat list; every gallery is a full triptych strip | No pinned/compact split; list is long and visually heavy |
| 2 | Pinned state drives layout via `packages/core/library-layout.ts` (platform-free, already tested) | `pinnedAt` never read in `desktop/`; account galleries rendered as strips | Desktop doesn't consume the shared layout helper |
| 3 | Account galleries are compact cards (single cover) unless pinned | Account galleries rendered as full strips | Inconsistent card weight |
| 4 | Sidebar account line: "You are a manorama Visionary hosting 10 of 99 permanent galleries." | Device line only; tier lives in the slide-out drawer | Tier not surfaced where the web surfaces it |
| 5 | Sidebar house-plate ad slot (ADVERTISEMENT) | No ad slot in the rail | Missing sponsored surface (also an ads-visibility gate) |
| 6 | Rail: logo, version, "Library", "+ Add Gallery", gear (settings) | Rail: logo, version, "Library", "+ Add Gallery", "Sync now", gear | "Sync now" is desktop-only and noisy; web has no manual sync |
| 7 | Footer: "© 2026 Mahesh Shantaram. All platform rights reserved." | Same, plus version tag | OK after rebuild |
| 8 | No scrollbar affordance issues | Right panel overflows with no visible scrollbar | Scroll affordance |
| 9 | Edit/reorder/hide lives in the gallery picker's Edit mode | Details has rename/rescan/remove only; no reorder or hide | Editing parity |
| 10 | Gallery details show published URL, share, rescan, rename, remove | Same, plus local-only constraints | Mostly aligned |

### 0.4 Things already aligned (do not regress)
- Shared `Viewer` island, `GalleryShell`, `Sheet`, `TopBar`, `GalleryEditSheet`,
  `HeicImg`, theme handling, account drawer with theme switch + sign-out,
  full-screen viewing of both local and account galleries, deep-link sign-in
  with paste fallback, catalogue persistence via `private_store.rs`, sync.

## 1. Goal

Make the macOS desktop Library visually and interactionally indistinguishable
from the web Library for the surfaces both can render, while keeping the
desktop-only affordances (local folders, "Sync now", rescan, publish) honest
and non-intrusive. Concretely: a user who knows the web Library should open
the macOS app and not feel they are in a different product.

## 2. Non-goals / constraints (from AGENTS.md invariants)

- No image bytes persisted server-side; desktop catalogue syncs titles/counts only.
- No upscaling/re-encoding; strips stay aspect-true, gapless, one height.
- `packages/core` stays platform-free — `libraryLayout` is already there; reuse it.
- One issue, one branch, one PR; do not edit files owned by other open issues.
- Do not weaken existing tests; the workbench test (`Catalogue.workbench.test.tsx`)
  is the contract for the drawer/details/history flow.

## 3. Phases

### Phase 0 — Ship the already-built fixes (1 PR, no code change)
1. Rebuild: `bun run build:desktop && bunx tauri build --bundles app --target aarch64-apple-darwin`
   (verified green on 2026-11-06; artifact at
   `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/manorama.app`).
2. Replace `/Applications/manorama.app` with the new bundle (back up first).
3. Relaunch and re-screenshot; confirm version tag now reads the current short
   SHA, cloud thumbnails render, and the window drags from the title area.
4. Re-run `desktop/islands/Catalogue.workbench.test.tsx` and `bunx tsc --noEmit`.

Deliverable: a macOS app that no longer shows empty cloud thumbnails or a
non-draggable window. Does **not** yet close the layout gaps below.

### Phase 1 — Fix the sidebar counter bug (root cause, before any visual work)
- Reproduce against the rebuilt app with a seeded catalogue.
- Add a regression test in `Catalogue.workbench.test.tsx` that mounts with a
  non-empty catalogue and asserts the rail's device line shows the real counts.
- Likely sites: `deserializeLocalCatalogue` returning a shape the rail reads
  before `setCatalogue`, or `catalogue.galleries` being reassigned during the
  availability probe. Fix the class (single source of truth for the displayed
  catalogue), not the symptom.

### Phase 2 — Adopt `libraryLayout` for account galleries (core, platform-free)
- Import `libraryLayout` from `packages/core/library-layout` into `Catalogue.tsx`.
- Partition `accountGalleries` into `strips` (pinned) and `compact` (everything
  else), using `tier` from `session`.
- Render pinned account galleries as strips (triptych, existing markup) under a
  "Pinned galleries" heading; render the rest as compact cards under
  "Your galleries".
- Compact card markup: mirror the web's compact card (cover thumbnail + title +
  metadata line + menu), but reuse existing `lib-card` styles rather than
  inventing new ones.
- Keep local galleries in their own section ("On this Mac") or fold them into
  "Your galleries" — decide in the PR; recommend a separate, clearly-labelled
  section to avoid implying local folders are cloud galleries.
- Add tests: pinned account gallery renders as a strip; unpinned renders as a
  compact card; a tier change re-partitions.

### Phase 3 — Sidebar parity
- Add the account tier line to the rail when a session exists:
  "You are a manorama {Free User|Visionary} hosting {n} of {limit} permanent
  galleries." (reuse the web's wording; `FREE_RETAINED_LIMIT`/`PAID_RETAINED_LIMIT`
  from `app/lib/gallery-policy`).
- Add the house-plate ad slot to the rail, gated on `/api/ads/visibility`
  (same fail-open rule as the web: unanswered means show). Reuse
  `houseAdFrameFor('library')`.
- Drop or demote "Sync now" to the account drawer (web has no manual sync in
  the rail). Keep the sync status line.
- Ensure the rail's version tag and footer match the web exactly.

### Phase 4 — Compact card + editing parity ✅ DONE (2026-11-07)
- Account gallery card menu gained a "Reorder photos" action that opens the
  account viewer with `initialEdit=true`.
- `Viewer` and `PickerEditor` now accept `apiBase` + `authToken` (default web
  behaviour unchanged) so the edit flow's load + PATCH work against the remote
  API with bearer auth on desktop.
- `AccountViewerState` carries `galleryId` and `edit`; the account viewer
  passes them plus `apiBase`/`authToken` to `Viewer`.
- Local galleries keep rescan/rename/remove in Details; no cloud-style editing
  was added to local records.

### Phase 5 — Scroll + polish ✅ CODE COMPLETE (2026-11-07)
- Scroll affordance: the right panel uses the system scrollbar, which is
  already visible in the rebuilt app (verified in screenshot). No CSS change
  needed; matches the web, which also relies on the default scrollbar.
- Six-state capture matrix (opening screen, gallery curtain, first image with
  controls, display-settings popover, signed-in account/admin surface, folder
  grid) at 1440×900 from a freshly built bundle remains an **owner GUI step**
  per AGENTS.md — driving the Tauri window needs an interactive desktop session.
  The rebuilt bundle is installed at /Applications/manorama.app and ready.

## 4. Files owned by this plan
- `desktop/islands/Catalogue.tsx` (layout partition, sidebar, ad slot)
- `desktop/islands/LocalGalleryDetails.tsx` (editing parity)
- `desktop/styles.css` (compact cards, scrollbar, ad slot)
- `packages/core/library-layout.ts` — read-only reuse; if a desktop-specific
  variant is needed, add a new helper rather than editing this one (it is
  shared with web/iOS and has its own tests).
- `desktop/islands/Catalogue.workbench.test.tsx` (new assertions)

## 5. Verification
- `bunx tsc --noEmit` clean.
- `bun run test:unit` green (workbench + library-layout).
- Playwright desktop specs green if any touch the catalogue.
- Six-state macOS capture matrix at 1440×900 from a freshly built bundle,
  reviewed before commit (AGENTS.md "Native/desktop visual evidence").

## 6. Open questions for the owner
- Should local folders appear in "Your galleries" compact cards or in a
  separate "On this Mac" section?
- Should the macOS rail show the house-plate ad at all, or is the ad surface
  native-only and the web's sidebar slot web-only? (Affects Phase 3.)
- Is "Sync now" worth keeping in the rail, or should it move entirely into
  the account drawer?
