# Two takes on the macOS catalogue — comparison and convergence (2026-10-11)

Two tasks were asked to implement the same thing: `XwHWGfnXgjpZjsO6uHttzx` ("Implement
macOS Catalogue web/iOS admin layout and UX parity") and `HJXe1HMRVbRXgEpG0mI77x`
("Implement macOS Admin Header, Theme Toggle, and Web Parity"). Both ran against the same
checkout at `8bcc510`. This note records what differed, and what the single branch now
carries.

## Where each side stood

| | This branch (`feat/desktop-catalogue-parity`) | Sibling (`HJXe1HMRVbRXgEpG0mI77x`, stopped) |
|---|---|---|
| State | one commit, pushed to its own branch | **uncommitted** in the main checkout, on `fix/native-capture-admin-parity` |
| Island | `desktop/islands/Catalogue.tsx` — workbench + rail | same file — workbench + its own row list |
| Divergence | `desktop/styles.css` 191 lines, `Catalogue.tsx` 409 lines, `lib/theme.ts` 51 lines | |
| Evidence | `outputs/desktop-catalogue-parity/` (18 captures) | `demo-captures/desktop-admin/` (16), `outputs/desktop-admin-parity/` (2 docs) |
| Captures also touched | — | `demo-captures/macos/05-account-admin.png`, 12 web `admin-appearance` captures |

## Desktop CSS — the substantive difference

**The sibling kept the old desktop catalogue rules and added the shared shell on top.**
Its `desktop/styles.css` still styles a bespoke row list — `.desktop-galleries`,
`.desktop-gallery`, `.desktop-gallery-row` (thumb-left/thumb-right variants),
`.desktop-gallery-copy`, `.desktop-gallery-heading`, `.desktop-gallery-link`,
`.desktop-gallery-thumb` (`height: 16dvh`, `max-width: min(42%, 320px)`,
`object-fit: contain`), `.desktop-gallery-actions` — and the **inline photo grid** the
island expands in place: `.desktop-grid` (`repeat(auto-fill, minmax(140px, 1fr))`) with
`.desktop-thumb { aspect-ratio: 1; object-fit: contain }`, i.e. square, letterboxed
thumbnails rather than a rail. Light mode reaches only those old mounts
(`html.light .desktop-gallery-thumb, html.light .desktop-thumb img { background: #dcd7cb }`).
Its page ground is handled with `:has()`: `body.manorama-desktop:has(.admin-page)`.

Two smaller things in that file: `.desktop-sync-state` sits at `rgba(ink, .48)` and
`.desktop-share-provider-note` at `.52` — under AA for their size in light mode — and the
stage-arrows/control-logo block appears **twice** (lines 165–173 and again 206–210), the
second overriding with `var(--desktop-chrome-height)`, a leftover from an edit collision.

**This branch drops the old row and grid rules entirely** and adds the workbench layer:
`.desktop-catalogue`, `.desktop-source-actions`, `.desktop-source-note`,
`.desktop-device-line`, and `.desktop-catalogue .admin-gallery-strip-item` as a *button*
carrying the shocking-pink `is-active` frame — the web dashboard's rail, made clickable.
Light mode corrects the surfaces this shell paints itself; muted small text was raised to
clear AA after the suite measured 4.32:1; the stage-arrows block appears once.

**The island follows the CSS.** The sibling keeps `openGalleryId` (line 111) — the card
that expands in place, with its inline grid — so its catalogue is a hybrid: web shell,
desktop's own gallery list. This branch removes `openGalleryId`: the list is the web
dashboard's `.admin-gallery-card` plus `.admin-gallery-strip`, and a thumbnail opens the
shared viewer at that photograph. That is the parity the request names, and it matches the
documented dashboard rule (one non-wrapping row per gallery, fixed viewport-relative
height, aspect-true widths, zero gaps, pink active).

## Playwright tests — coverage each side had

**The sibling shipped two specs plus a fixture.**

- `desktop-admin-fixture.ts` — the shared bridge: a 1×1 GIF as the `convertFileSrc`
  stand-in, two galleries (folder **and** memory card), a `tier: 'pro'` session,
  `installBridge(payload)` and `blockProductionApi(page)` with a call counter.
- `desktop-admin.playwright.ts` (195) — four window sizes × a reduced-motion variant,
  capturing to `demo-captures/desktop-admin/`. Asserts `[data-admin-ready="true"]`, the
  tab's geometry and `aria-expanded`, the quadrant arrangement, the **copy** ("Welcome to
  manorama.xyz.", "You are a Pro User.", "2 galleries on this Mac."), the sync state, that
  the account seam was really called, and pane contrast — but locates the gallery rows by
  its own markup.
- `theme-persistence.playwright.ts` (162) — the cross-bundle guarantee: the web dashboard
  and the Mac shell each persist their own choice through a reload, answer to the
  **identical key, class and label**, and do not leak a theme from one origin to the other.
  It drives the live web dev server (`.dev-seed/login`) as well as the desktop shell, and
  is written against shared markup only.

**This branch shipped one spec** — `desktop-catalogue.playwright.ts` (320) — with its own
inline bridge, WebKit **and** Chromium at three window sizes, and assertions the sibling
did not have: the rail's measured geometry (equal heights, source-true widths within 2%,
zero gaps, pink first frame, real horizontal travel, no page overflow), the focus trap and
Escape/backdrop return, and the theme returning after the stage. It had no cross-bundle
theme coverage and no shared fixture.

## What the single branch now carries

1. **The parity implementation** — workbench, rail, clickable originals opening the shared
   viewer, slide-out pane, theme. (This branch's island and CSS.)
2. **The sibling's account-surface vocabulary** — the pane and the welcome quadrant now
   read "Welcome to manorama.xyz." and "You are a Pro User." with the Mac's own local fact
   after them, matching `app/islands/Admin.tsx` and `native/islands/GalleryList.tsx`. This
   branch's earlier copy invented a different sentence; theirs was closer to parity.
3. **The session `tier` work** — `app/api.ts` answers `tier` with the exchange, and
   `desktop/lib/session.ts` carries it, backwards-compatible with a session stored before
   the field existed (the plan sentence is simply omitted rather than guessed).
4. **The shared fixture** (`desktop-admin-fixture.ts`), extended with a real-photograph
   catalogue (`buildCatalogue` + `servePhotos`) so the rail's geometry is still measured
   against the owner's own files, while the synthetic two-gallery catalogue stays for the
   shell and theme specs.
5. **The cross-bundle theme spec** (`theme-persistence.playwright.ts`), taken as written —
   it is markup-agnostic, and it passes against this implementation on both engines.
6. **The theme drift guard** — the unit test now reads `app/islands/Admin.tsx` and fails
   the day the storage key or the `light` class diverges between the two bundles.
7. **`data-admin-ready="true"`** on the shell, the readiness signal both suites wait on.

Not carried over: the sibling's `desktop-admin.playwright.ts` (it asserts its own row
markup, which this implementation does not have — its non-markup assertions were folded
into `desktop-catalogue.playwright.ts` instead); its `demo-captures/` (they show the other
UI, and the native macOS capture cannot be regenerated here without a freshly built
bundle); its `theme.ts` and `theme.test.ts` (the same module under different argument
order — this branch keeps its own, with the sibling's extra cases and drift guard merged
in).

## Verification of the converged branch

`bunx tsc --noEmit` clean · `bun run test:unit` **1081 pass / 0 fail** · `bun run
build:desktop` green · `desktop-catalogue.playwright.ts` **6/6 on WebKit and Chromium** at
1280×840, 1440×900 and 760×620 in both themes · `theme-persistence.playwright.ts` **4/4 on
both engines** against the live web dashboard.