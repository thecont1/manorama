# Desktop admin parity — two quadrants, one theme, one surface

Date: 2026-10-11 · Surface: macOS app (`desktop/`, Tauri) · Status: implemented and verified

## What was asked

Implement, for the macOS application, the same admin experience already shipped on the
web dashboard and iOS: the **two-quadrant admin header**, the **dark/light toggle**, and
**unified desktop/web admin parity** — matching the features and UX verified on the other
two surfaces.

## What shipped

The signed-in desktop catalogue no longer has its own two-column layout. It now renders
the web dashboard's admin surface — the same markup, the same classes, the same rules from
`app/styles.css`, which the desktop bundle already imports:

| Piece | Web dashboard | macOS app (now) |
|---|---|---|
| Page | `.admin-page.admin-page--selector` | identical |
| Top workbench | `.admin-overview` — welcome left, action right, split at the physical centre ≥820px, stacked below | identical |
| Account | `.admin-edge-tab` → `.admin-drawer` → `.admin-drawer-panel` (`role="dialog"`, `aria-modal`) | identical |
| Theme | `html.light` + `localStorage['manorama:theme']` | identical |
| Actions | `.admin-drawer-action` buttons at the pane's foot | theme toggle + Sign out |
| Gallery list | `.admin-galleries-heading` over `.admin-gallery-list` | `.admin-galleries-heading` over the local rows, restyled to the card type |

**Left quadrant — the welcome.** The brand wordmark (`admin-welcome-brand` +
`brand-tld`), the `adj.` intro, and the account greeting. The greeting states only what
this surface can verify: the account name and plan from the session, and the count of
galleries this Mac holds.

**Right quadrant — Add a gallery.** `gallery-selector-heading` ("Add a gallery"),
`admin-retention-policy` (the local count and the in-place reference promise), the
primary action (`admin-button--solid`, "Choose a folder or card"), "Sync now", the
privacy note, and the quiet sync-state line. Errors and notices land here, next to the
actions that produce them, instead of inside a pane the user has to open to see.

**The account pane.** Closed by default on every load, never encoded in a URL. It opens
from the 44px edge tab, locks page scroll, takes focus, traps Tab, closes on Esc or a
backdrop click, and returns focus to the tab. That is the web pane's contract, so the
same assertions hold on both surfaces.

## The theme toggle

- `desktop/lib/theme.ts` holds the vocabulary: `THEME_KEY = 'manorama:theme'`,
  `DEFAULT_THEME = 'dark'`, `parseTheme`, `readStoredTheme`, `storeTheme`, `applyTheme`,
  `oppositeTheme`, `themeControlLabel`.
- One key and one class are **shared with the web dashboard**, not re-declared per
  platform. A unit test reads `app/islands/Admin.tsx` and fails the day the two drift.
- The label names the action ("Switch to light mode" / "Switch to dark mode") exactly as
  the web pane does.
- Light mode is not a second design: `html.light` flips `--ink` and the admin surface in
  `app/styles.css`; `desktop/styles.css` adds only what is desktop-specific — the page
  behind the pane, and the two photo mounts (the gallery thumbnail and the inline grid),
  which follow the web rail's `#dcd7cb` instead of staying near-black on a light page.
- The preference persists and survives a reload, verified in the browser spec.

## The account plan

The Mac app's account surface now states the plan the way the web dashboard and iOS do.
`POST /api/auth/desktop/exchange` returns `tier` alongside `token` and `ownerSlug` — the
account's own record, never a client claim — and `DesktopSession.tier` is optional so a
session persisted before the field existed stays valid and simply omits the sentence
rather than guessing "Free".

## Deliberate local-first differences

These are platform-appropriate, not parity gaps:

- **The count is local.** The web dashboard counts cloud galleries against a plan limit;
  a local-first catalogue has no such limit, so it counts what this Mac holds.
- **The publish seam is named honestly.** "Publishing is a separate, explicit step: the
  originals upload to your own cloud account, byte for byte, and never to Manorama."
- **The rows keep their local affordances.** Thumbnail, inline photo grid, View photos,
  Rescan, Share…, Remove — the things a Mac owner does with a folder. Their typography is
  now the web card's (brand-face 32px title, quiet count, mono address).

## Files

- `desktop/islands/Catalogue.tsx` — signed-in surface rebuilt on the shared admin markup;
  theme state, pane state, focus contract.
- `desktop/lib/theme.ts`, `desktop/lib/theme.test.ts` — new.
- `desktop/lib/session.ts`, `desktop/lib/session.test.ts` — the optional plan.
- `desktop/styles.css` — the admin surface in a Mac window, row typography, light mounts;
  the orphaned two-column catalogue rules removed.
- `app/api.ts` — the desktop exchange returns the plan.
- `app/lib/desktop-auth.test.ts` — asserts the plan comes from the account record.
- `desktop-admin.playwright.ts`, `desktop-admin-fixture.ts` — new acceptance spec and the
  bridge/fixture it shares with the theme spec.
- `theme-persistence.playwright.ts` — new spec: theme persistence on both bundles and the
  cross-origin relationship between them.
- `demo-captures/desktop-admin/` — browser evidence (see the naming note below).
- `demo-captures/macos/05-account-admin.png` — the native capture, retaken.

## Verification

**TypeScript** — `bunx tsc --noEmit` clean.

**Unit suite** — green. Two files (`app/lib/gallery-retention.test.ts`,
`app/account-deletion-api.test.ts`) start miniflare and need a writable `~/.wrangler` plus
a loopback port; without that permission they fail with `EPERM`/`EADDRINUSE` regardless of
this change. With both granted the suite is green, including the new tests:
`desktop/lib/theme.test.ts` (6) and the two new exchange cases in
`desktop/lib/session.test.ts`.

**Browser acceptance** — `desktop-admin.playwright.ts`, 9 passed. The desktop bundle is a
client-only SPA whose IPC bridge is absent outside the Tauri webview, so the spec installs
the bridge before any page script runs and answers the commands the catalogue calls. It
asserts, at 1280×840, 1024×700, 760×520 (the window's declared minimum) and 2560×1440,
with and without reduced motion:

- the edge tab is 44px wide, flush to the left edge, centred vertically, and the pane is
  closed with `aria-expanded="false"` until asked for;
- the two quadrants split at the physical centre above 820px and stack below it, with
  "Your galleries" beneath both;
- the greeting carries the name, the plan and the local count;
- the pane opens with focus on its close button, Tab wraps inside it, Esc closes it and
  returns focus to the tab;
- both themes measure ≥4.5 contrast on the pane's intro, greeting, actions and footer;
- the pane sits at x=0 with no horizontal overflow, the page never overflows either, the
  theme persists through a reload, and the URL stays clean;
- the catalogue's sync seam still fires (intercepted locally — the spec never reaches the
  production API) and reports "Catalogue synced.";
- no page errors.

**Web regression** — `admin-appearance.playwright.ts`, 8 passed against the web dev
server: the shared surface was not disturbed.

**Theme persistence and cross-surface synchronisation** — `theme-persistence.playwright.ts`,
4 passed:

- The dashboard applies and persists `light` across a reload; so does the Mac shell.
- Both bundles answer to the identical storage key (`manorama:theme`), the identical `html`
  class (`light`), and the identical control copy ("Switch to light mode" / "Switch to dark
  mode"). Both also *write* the shared default out on first paint rather than only reading it.
- **The two origins do not share storage, and this is now asserted rather than assumed.**
  Setting light on the dashboard leaves the Mac shell on its own default, and setting it on
  the shell does not reach back. `localStorage` is origin-scoped: the dashboard is served
  from `manorama.xyz`, the shell from the Tauri origin, so "synchronisation" here means one
  shared vocabulary, not one shared value. The unit test that reads `Admin.tsx` keeps that
  vocabulary from drifting.
- If a genuinely synced choice is wanted later, the seam already exists: the desktop
  exchange returns the account record, which now carries `tier`, so a `theme` preference
  could ride the same field and be applied on load. That is a product decision, not a bug.

**Native macOS** — **captured.** The Tauri debug bundle was rebuilt from this working tree
and signed ad-hoc (only the DMG step failed, which needs AppleScript and `hdiutil`; the
`.app` itself is complete), launched through LaunchServices, and captured at its own
1280×840 window size, 2560×1680 at 2×. `demo-captures/macos/05-account-admin.png` now shows
the new surface: the wordmark, `adj.` intro and greeting in the left quadrant; "Add a
gallery" with the retention policy, both actions, the privacy note and the sync line in the
right; the edge tab on the left edge; "Your galleries" and its empty state below both.

Two things the capture shows that are worth stating plainly. The greeting reads "Hello,
thecontrarian. Welcome to manorama.xyz. 0 galleries on this Mac." with **no plan sentence**:
that session was minted before the plan field existed, and the optional field's designed
behaviour is to omit the sentence rather than guess "Free". And the catalogue is empty, so
the capture shows the empty state rather than populated rows — the rows are covered by the
browser evidence and by the iOS captures.

A native pane-open capture was attempted and abandoned: synthetic clicks posted through the
Accessibility API did not land on the tab reliably (the first attempt opened the Apple menu
instead), and the risk of driving the owner's desktop with stray events outweighs the value
of a second native frame. The pane-open state is covered by `demo-captures/desktop-admin/`
and by the spec's focus, contrast and geometry assertions.

The capture needs the local API base, so `http://localhost:5173` must be serving:

```sh
pkill -f manorama-desktop          # same bundle id — `open` would focus the old instance
open -n .work/macos-target/debug/bundle/macos/manorama.app
```

To show a populated catalogue rather than the empty state, `.work/macos-capture/seed.mjs`
seeds the app's own private store with two galleries whose folders hold symlinks to the
owner's photographs — nothing copied, nothing re-encoded. It backs the existing store files
up first. **This writes into the app's private store and needs the owner's authorisation**;
it was not run here, so the store is exactly as the app last left it.

Evidence naming: `demo-captures/desktop-admin/*` are **Chromium captures of the desktop
shell**, not native macOS screenshots. They are valid evidence of the shell's own layout
and behaviour and must not be presented as native captures.

## Follow-ups (not in this change)

- The pane carries the theme toggle and Sign out. Web-only administrative controls (slate
  navigation, Share, delete-account) are not part of the Mac app's account pane yet.
- The Mac app's gallery rows are not the web cards' strip editor; the inline photo grid
  stays until a desktop equivalent of the rail is designed.
