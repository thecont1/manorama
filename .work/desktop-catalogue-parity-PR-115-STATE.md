# PR #115 — state at 2026-10-11T14:16 (before compaction)

## What changed under me

`fix/native-capture-admin-parity` (the PR's base) was **committed and pushed** while I was
away. Its working tree is now clean and its tip is `974934c`. Six commits on top of
`8bcc510`:

```
974934c chore: keep the macOS capture scratch out of git
3297cce docs: record the desktop admin parity work
fbbe6ca docs(captures): refresh the admin evidence for the desktop shell
54ca4f7 test(desktop): cover the admin surface and the theme across bundles
2586739 feat(desktop): bring the catalogue to admin parity
043d9c3 feat(desktop): persist the shell's dark/light choice
```

`2586739` touches: `app/api.ts`, `app/lib/desktop-auth.test.ts`,
`desktop/islands/Catalogue.tsx` (290 lines), `desktop/lib/session.test.ts`,
`desktop/lib/session.ts`, `desktop/styles.css` (92 lines).

## What the base now contains

- The island still **expands a gallery in place**: `openGalleryId` is present (3 hits), and
  `desktop/styles.css` still styles `.desktop-gallery-row`, `.desktop-grid`, `.desktop-thumb`
  (12 hits) — the row list plus the inline square grid.
- The pane carries the **slug URL editor** (`.admin-greeting-url`), which this branch's pane
  does not have (mine has `mark.admin-greeting-name` + `.desktop-device-line`).
- `desktop/lib/theme.ts` on the base uses `applyTheme(theme, root)` and
  `storeTheme(storage, theme)` — the mirror of this branch's argument order.
- `desktop-admin.playwright.ts` (theirs, committed) is only lightly markup-bound:
  `.desktop-gallery` rows (`toHaveCount(2)`, first contains "Bangkok Rain" and
  "(25 photos)"), `getByText('/Volumes/NO NAME/DCIM')`, `.desktop-sync-state`,
  `.admin-brand-logo`, `[data-admin-ready="true"]`, and `.admin-greeting-url`
  (`toHaveText('manorama.xyz/thecontrarian')`).
- Their captures: `demo-captures/desktop-admin/` (16), refreshed
  `demo-captures/macos/05-account-admin.png` and 12 web `admin-appearance` captures,
  plus `outputs/desktop-admin-parity/` (2 docs).

## PR #115 now

`gh pr view 115` → `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, base
`fix/native-capture-admin-parity`, head `feat/desktop-catalogue-parity` (one commit
`7a0aa4a`, 32 files, +1614/−205). Only PR open in the repo; the base has no PR of its own.

## The conflict surface

Files both sides rewrote: `desktop/islands/Catalogue.tsx`, `desktop/styles.css`,
`desktop/lib/theme.ts` + `desktop/lib/theme.test.ts`, `desktop-admin-fixture.ts`,
`desktop/index.html`. Identical on both sides (taken from theirs): `app/api.ts`,
`app/lib/desktop-auth.test.ts`, `desktop/lib/session.ts` + test,
`theme-persistence.playwright.ts`.

## Two coherent resolutions

1. **Supersede** — merge the base in, keep this branch's catalogue (rail of clickable
   originals opening the shared viewer), then adapt the base's
   `desktop-admin.playwright.ts` to the rail and regenerate `demo-captures/desktop-admin/`.
   Stack lands as: base's shell + theme + session work, then this UI on top.
2. **Layer** — re-express this branch as a delta on the base's catalogue: keep their island
   and pane (including the slug URL editor), add only this take's contributions — the rail
   with clickable originals, the viewer wiring, the AA contrast fixes, the single
   stage-arrows block. Least destructive; their spec and captures stay valid with small
   edits.

Either way: `desktop/lib/theme.ts` resolves to the base's module, and this branch drops its
duplicate. A force-push is **not** available (AGENTS forbids it), so the reconciliation
must be a merge commit — which is also what keeps the PR diff readable.