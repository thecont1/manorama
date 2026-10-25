# macOS Catalogue parity — working notes

## Task
Implement macOS Catalogue parity with the approved web/iOS admin layout: dark/light
toggle, proper header styling, slide-out account pane. (User request 2026-10-11.)

## Conflict handled first (important)
A sibling Manus task, `HJXe1HMRVbRXgEpG0mI77x` ("Implement macOS Admin Header, Theme
Toggle, and Web Parity", running, ~40s older) was editing the SAME checkout
(`/Users/home/DEV/tools/manorama`, branch `fix/native-capture-admin-parity`) at the
same time — it created `desktop/lib/theme.ts`, added `tier` to `desktop/lib/session.ts`
and `app/api.ts`, and rewrote `desktop/islands/Catalogue.tsx` at 12:05:49, which is why
my first write was rejected. The user chose **isolate and continue**.

So this work lives in its own worktree, and the sibling's checkout is untouched:

    /Users/home/DEV/tools/manorama/.worktrees/desktop-catalogue-parity
    branch feat/desktop-catalogue-parity   (based on 8bcc510)

Nothing from the sibling's uncommitted work is reused; this branch is self-contained.
`bun install` here needs `TMPDIR=/tmp/mano-bun-tmp` (the default TMPDIR is not writable
for bun in this environment).

## What the parity means (sources studied)
- Approved web admin: `app/islands/Admin.tsx` + `app/styles.css` (`.admin-page--selector`,
  `.admin-overview`, `.admin-edge-tab`, `.admin-drawer*`, `.admin-gallery-card`,
  `.admin-gallery-strip-frame`, `.admin-icon-action`, `html.light` overrides).
- Approved iOS admin: `native/islands/GalleryList.tsx`; capture
  `demo-captures/ios/05-account-admin.png`.
- Evidence captures: `demo-captures/web/admin-appearance/*.png`,
  `demo-captures/web/chromium-desktop-05-account-*.png`, `demo-captures/macos/05-account-admin.png`.
- Plan: `outputs/duo-and-macos-plan-2026-10-11.md` § "macOS: restore the existing native
  product" step 4 — "Bring the desktop catalogue's account controls into the same visual
  family: theme-aware material, fitted branding, and the optional left-edge pane."

## Changes in this branch
- `desktop/islands/Catalogue.tsx` — rebuilt on the shared workbench: `admin-page
  admin-page--selector desktop-catalogue`; left-edge Account tab → slide-out pane with
  brand/intro/greeting/footer + theme action + Sign out; header quadrants (welcome left,
  local-source picker right); `Your galleries` list of `admin-gallery-card`s, each with one
  gapless aspect-true row of clickable originals (first frame pink, `is-active`); icon
  actions View / Rescan / Share… / Remove. `openGalleryId` (inline grid expansion) is gone:
  a thumbnail click opens the shared Viewer at that index.
- `desktop/lib/theme.ts` (+ test) — one storage key (`manorama:theme`), one `<html>` class,
  one control label, shared with the web dashboard.
- `desktop/styles.css` — desktop layer only: strip items as buttons, pink active frame,
  source actions, status lines, share host, light-mode corrections for the surfaces the
  shell paints itself. Dead two-column catalogue rules removed.
- `desktop/index.html` — pre-paint theme boot so a returning light-mode owner sees no flash.

## Deliberate choices
- The `light` class is held OFF while the viewer is open: the stage is a neutral near-black
  by contract, and light `--ink` over it would make the curtain copy unreadable.
- The pink first frame mirrors `native-gallery-thumb.is-active` ("the first frame is the
  gallery's face") and the AGENTS picker rule (fixed height, aspect-true width, zero gaps).
- No copying/re-encoding anywhere: thumbnails are `convertFileSrc` URLs to originals.

## Verification plan
1. `bunx tsc --noEmit` — clean (done).
2. `bun run test:unit` with `TMPDIR=/tmp/mano-bun-tmp MANORAMA_TEST_ROOT=/tmp/manorama-test-root`.
3. `desktop-catalogue.playwright.ts` against `bun run dev:desktop` (port 5175) with a
   `__TAURI_INTERNALS__` stub seeding a session + catalogue, and a read-only static server
   for the owner's originals at `/Users/home/Library/CloudStorage/Dropbox/italy` — WebKit
   (the Tauri renderer on macOS) and Chromium, dark+light, pane closed/open, at the app's
   1280×840 window and 1440×900. Screenshots are browser captures, never labelled native.
4. Rebuild desktop frontend (`bun run build:desktop`).