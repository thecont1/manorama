# Two-quadrant admin header — test coverage report

Date: 2026-10-11 · Surface: macOS app (`desktop/`, Tauri) · Specs: `desktop-admin.playwright.ts`, `theme-persistence.playwright.ts`

## How coverage was measured, and what would not work

Three measurements, because a UI header is not covered by one number:

1. **Requirement coverage** — every requirement of the two-quadrant header mapped to the
   assertion that proves it. This is the meaningful one.
2. **Surface coverage** — of the classes the surface actually renders, how many the specs
   address, and by what mechanism.
3. **Unit coverage** — Bun's line/function coverage over the desktop modules.

**Byte-level V8 coverage was measured and discarded.** In Vite dev mode every loaded module
reports ~100% covered, because a module's top level runs when it is imported, so the metric
degenerates into "did this file load". Stylesheet coverage returns nothing at all: in dev,
Vite injects CSS from JavaScript, so the stylesheets have no URL for the collector to
attribute ranges to. Neither number would have told the truth about this change, so the
report does not present them.

## 1. Requirement coverage

| Requirement | Assertion |
|---|---|
| Two quadrants: welcome left, action right, split at the physical centre | `welcomeBox.x + width < width/2` and `importBox.x > width/2`, tops aligned within 2px, at 1024 / 1280 / 2560 |
| Stacked below the breakpoint | At 760×520: `importBox.y >= welcomeBox.y + welcomeBox.height` |
| Gallery list spans below both quadrants | `headingBox.y >= max(welcome bottom, importer bottom)` |
| The welcome quadrant's own copy, from the session | `toContainText('Welcome to manorama.xyz.')`, `'You are a Pro User.'`, `'2 galleries on this Mac.'` |
| The importer quadrant's copy and primary action | `toContainText('2 galleries on this Mac')`, button `Choose a folder or card` visible |
| The wordmark fits inside its quadrant | `logoBox.x + width <= welcomeBox.x + welcomeBox.width` |
| Account pane closed on load, never in the URL | `dialog` hidden, `aria-expanded="false"`, `new URL(page.url()).search === ''` |
| Edge tab geometry | 44px wide, `x <= 1`, vertically centred within 2px of the viewport centre |
| Pane opens with focus inside | close button `toBeFocused()` |
| Focus is trapped | `Sign out` + `Tab` wraps to the close button |
| Pane leaves the page intact | `panelBox.x ≈ 0`, logo inside the panel, no horizontal scroll in the panel or the page |
| Three ways out | Esc, the close button, and a backdrop click — each closes and returns focus to the tab |
| Both themes legible | 5 text samples per theme (`admin-intro`, `admin-greeting`, `admin-drawer-action`, `site-footer-link`, `site-footer-copy`) ≥ 4.5 contrast, measured against the pane's own computed background, after the 180ms footer crossfade settles |
| Theme applies | `html` has/lacks `light` for both themes, at every viewport |
| Theme persists | `localStorage['manorama:theme'] === 'light'` then survives a reload |
| The catalogue is unchanged by the redesign | 2 rows, `Bangkok Rain`, `(25 photos)`, `/Volumes/NO NAME/DCIM` visible |
| The sync seam still fires | `.desktop-sync-state` reads `Catalogue synced.` and the (locally intercepted) API call count is > 0 |
| Nothing threw | `pageerror` listener asserts `[]` |
| Reduced motion honoured | The full matrix runs twice, `reduce` and `no-preference` |
| The shared surface was not broken | The web spec `admin-appearance.playwright.ts` still passes against the same markup |

Run: **13 passed** — 9 in `desktop-admin.playwright.ts` (4 viewports × 2 motion
preferences, plus the resize test), 4 in `theme-persistence.playwright.ts`.

## 2. Surface coverage

The signed-in surface renders **51 distinct classes, 50 of them in the header/pane
namespace**. The specs address them by two mechanisms:

**By role and accessible name (structure and behaviour).** `button "Account menu"`,
`dialog "Account"`, `region "Welcome to manorama"`, `region "Add a gallery"`,
`heading "Your galleries"`, `button "Close account menu"`, `button "Switch to light mode"`,
`button "Sign out"`. These are the assertions that would catch a broken header, and they do
not depend on class names.

**By class selector (9):** `admin-brand-logo`, `admin-drawer-action`, `admin-greeting`,
`admin-greeting-url`, `admin-intro`, `desktop-gallery`, `desktop-sync-state`,
`site-footer-copy`, `site-footer-link` — the pieces with no semantic role to address, plus
the contrast samples.

**The other 41 are styling hooks with no direct assertion:** `admin-page`,
`admin-page--selector`, `admin-overview`, `admin-content`, `admin-welcome`,
`admin-welcome-brand`, `admin-topbar-logo`, `brand-mark-wrap`, `brand-tld`,
`admin-welcome-note`, `gallery-import`, `gallery-selector-heading`, `admin-retention-policy`,
`admin-limit-count`, `desktop-import-actions`, `admin-privacy-note`, `gallery-list`,
`admin-galleries-heading`, `desktop-galleries`, `desktop-titlebar`, `site-footer`,
`admin-header`, `admin-left`, `admin-brand-title`, `admin-drawer`, `admin-drawer-panel`,
`admin-drawer-scrim`, `admin-drawer-close`, `admin-drawer-actions`, `admin-edge-tab`,
`admin-button`, `admin-button--solid`, `desktop-gallery-row`, `desktop-gallery-thumb`,
`desktop-gallery-copy`, `desktop-gallery-heading`, `desktop-gallery-subtitle`,
`desktop-gallery-link`, `desktop-gallery-actions`, and the two thumb-position variants.

That is the intended shape, not an accident: their correctness is *geometry and contrast*,
which the specs assert through roles and measured boxes. A class-name assertion on
`admin-overview` would prove less than the box measurement that already proves the split.

**Attributes:** asserted — `data-admin-ready`, `aria-expanded`. Present but unasserted —
`aria-controls`, `aria-hidden`, `aria-label`, `aria-labelledby`, `aria-live`, `aria-modal`,
`data-account-drawer`, `data-tauri-drag-region`. The ARIA wiring is real and is what the
role-based locators above resolve through, so a break would surface as a failing role query
rather than as a missing attribute.

## 3. Unit coverage (Bun)

`bun run test:unit -- --coverage ./desktop` — **90 tests, 0 fail**:

| File | % Funcs | % Lines |
|---|---|---|
| `desktop/lib/theme.ts` | 100 | 100 |
| `desktop/lib/catalogue.ts` | 100 | 100 |
| `desktop/lib/sync.ts` | 100 | 100 |
| `desktop/lib/local-scan.ts` | 100 | 100 |
| `desktop/lib/welcome.ts` | 100 | 100 |
| `desktop/lib/share.ts` | 92.86 | 100 |
| `desktop/lib/session.ts` | 62.50 | 64.33 |
| `desktop/lib/providers/oauth.ts` | 52.94 | 53.33 |
| **All files** | **72.07** | **79.84** |

`theme.ts` is the module this change introduced, and it is fully covered. `session.ts`'s
uncovered lines (131–171, 233–265) are the OAuth and deep-link completion paths, exercised
by the auth suites rather than by the catalogue tests.

## 4. Gaps, named

| Not asserted | Why it stands |
|---|---|
| `Rescan`, `Share…`, `Remove` row actions | Pre-existing gallery-row behaviour, outside this change's lane; the row *renders* is asserted |
| `Sync now` disabled while a sync is in flight | Pre-existing seam; only its result is asserted |
| Light-theme page background behind the pane | The pane's own contrast is measured; the page behind it is presentational |
| `brand-tld`, `admin-topbar-logo` asset loading | Presentational; the logo's box is measured, its file is not |
| `aria-modal` / `aria-hidden` values | Reachable only through the role queries that already pass |

## 5. Reproducing

```sh
bunx vite --config vite.config.desktop.ts --port 5175 --host 127.0.0.1   # shell
bun --env-file=.env.local vite --host 127.0.0.1 --port 5173             # dashboard
DESKTOP_URL=http://127.0.0.1:5175 GALLERY_URL=http://127.0.0.1:5173 \
  bunx playwright test desktop-admin.playwright.ts theme-persistence.playwright.ts
node .work/macos-capture/admin-dom-coverage.mjs   # surface inventory
```

The dashboard's first paint on the dev server is slow (its spec test took 29.5s against a
30s default), which is why both specs raise their timeout to 75s.

## 6. One anomaly, recorded

The full unit suite was run three times while this work was in flight. One run reported
**1055 tests with 1 failure**; two immediate reruns reported **1074 pass / 0 fail**. The
short run was 19 tests light, which points at a truncated mirror in
`bun run test:unit`'s scratch root — it mirrors the working tree, and the acceptance specs
were writing screenshots into that same tree around then — rather than at a real failure.
It is noted rather than quietly dropped, because a 1055-test run that "passed" would be the
wrong number to trust.

Also worth knowing before a commit: running `admin-appearance.playwright.ts` **regenerates
the committed dashboard screenshots** in `demo-captures/web/admin-appearance/` (12 files).
They are evidence artefacts of the current dev data, not of this change, and they are
currently modified in the working tree — reverting them is a decision for the owner.
