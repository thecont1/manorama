# PR draft — macOS Catalogue parity

**Branch:** `feat/desktop-catalogue-parity` · **Commit:** one commit,
`feat(desktop): rebuild the macOS catalogue on the shared admin workbench`

**Title:** `feat(desktop): rebuild the macOS catalogue on the shared admin workbench`

---

## Base — stacked, and currently conflicting

**Base branch:** `fix/native-capture-admin-parity`, which has since been **committed and
pushed** (tip `974934c`; six commits: the shell's theme, the catalogue parity, the
admin-surface spec, refreshed captures, docs). Those commits carry a *parallel*
implementation of this same surface — their catalogue still expands a gallery in place
(`openGalleryId`, `.desktop-gallery` rows, an inline square grid), and their pane carries
the slug URL editor (`.admin-greeting-url`).

That is why GitHub reports this PR as **CONFLICTING** (`mergeStateStatus: DIRTY`): the two
branches rewrite the same files — `desktop/islands/Catalogue.tsx`, `desktop/styles.css`,
`desktop/lib/theme.ts` and its test, `desktop-admin-fixture.ts`, `desktop/index.html`.
Nothing here is broken; the branch simply has to be reconciled before it can merge, and a
force-push is not available to us, so the reconciliation lands as a merge commit.

Two coherent resolutions, in order of preference:

1. **Layer (preferred).** Re-express this branch as a *delta* on the base's catalogue: keep
   their island and pane — including the slug URL editor this branch lacks — and add only
   what this take contributes: the rail of clickable originals opening the shared viewer,
   the AA contrast fixes on the muted small text, and the single stage-arrows block. Least
   destructive: their spec and captures stay valid with small edits, and the stack reads
   as base → improvements.
2. **Supersede.** Merge the base in and keep this branch's catalogue wholesale, then adapt
   `desktop-admin.playwright.ts` to the rail and regenerate `demo-captures/desktop-admin/`
   from this UI. Faster, but it replaces their evidence rather than extending it.

Either way `desktop/lib/theme.ts` resolves to the base's module (the mirror of this
branch's argument order) and this branch drops its duplicate, and the earlier comparison
of the two takes stands: `outputs/desktop-catalogue-parity/branch-comparison-2026-10-11.md`.

---

## What this changes

The macOS shell had grown a catalogue of its own: nested cards that expanded in place,
square thumbnails, a one-column account panel, and no theme at all. The web dashboard and
the iOS admin had already converged on one workbench, so the desktop now renders that
surface — the galleries on a full-width photographic rail, the account behind a single
left-edge tab that slides a pane in from the edge, and the dark/light switch inside that
pane, sharing `manorama:theme` and `html.light` with the web dashboard rather than growing
a second preference.

Clicking a thumbnail opens the shared viewer at that photograph. The inline-expanding card
is gone, and with it the second, parallel navigation it implied for one local gallery.

The pane states the plan the way the web dashboard and iOS do — "Welcome to
manorama.xyz." and "You are a Pro User." — with the Mac's own local fact after it. The
exchange now answers `tier` alongside the token, and a session stored before the field
existed still loads, simply without the sentence.

The stage is held dark while a photograph is open, even in light mode: it is a neutral
near-black by contract, and a light `--ink` over that ground would leave the curtain copy
unreadable. The choice returns on the way back.

## Files

| Area | Files |
|---|---|
| Island | `desktop/islands/Catalogue.tsx`, `desktop/islands/Catalogue.workbench.test.tsx` |
| Styles | `desktop/styles.css` |
| Theme | `desktop/lib/theme.ts`, `desktop/lib/theme.test.ts`, `desktop/index.html` |
| Session | `desktop/lib/session.ts`, `desktop/lib/session.test.ts`, `app/api.ts`, `app/lib/desktop-auth.test.ts` |
| Acceptance | `desktop-catalogue.playwright.ts`, `theme-persistence.playwright.ts`, `desktop-admin-fixture.ts` |
| Evidence | `outputs/desktop-catalogue-parity/` (18 captures + README) |

## Test plan

```sh
bunx tsc --noEmit                                    # clean
bun run test:unit                                    # 1081 pass / 0 fail
bun run build:desktop                                # green

bunx vite --config vite.config.desktop.ts --port 5176 --strictPort --host 127.0.0.1
DESKTOP_URL=http://127.0.0.1:5176 bunx playwright test desktop-catalogue.playwright.ts
# 6/6 — WebKit and Chromium at 1280x840, 1440x900, 760x620, both themes

bun run dev                                          # 5173, needs .env.local
GALLERY_URL=http://127.0.0.1:5173 DESKTOP_URL=http://127.0.0.1:5176 \
  bunx playwright test theme-persistence.playwright.ts
# 4/4 — both engines, against the live web dashboard
```

New tests: the mounted-island workbench test (layout, pane lifecycle, focus loop, theme,
rail structure), the theme unit test (with a drift guard that reads `Admin.tsx`), the
session `tier` cases, and the cross-bundle theme spec.

## Notes for review

- `desktop-admin-fixture.ts` is deliberately **not** `*.playwright.ts`: Playwright's
  `testMatch` would collect it as a spec.
- `theme-persistence.playwright.ts` needs the web dev server as well as the desktop shell;
  the README in `outputs/desktop-catalogue-parity/` says so.
- The captures in `outputs/` are **browser** captures at the app's window sizes, not native
  screenshots, and are kept out of `demo-captures/macos/` for that reason. The native
  six-state matrix still needs a freshly built bundle.
- No image bytes are persisted server-side; the fixture serves the owner's originals
  read-only through a route interception, untouched.
