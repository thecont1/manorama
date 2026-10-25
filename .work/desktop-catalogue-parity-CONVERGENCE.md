# Converging the two macOS catalogue takes (2026-10-11)

## State of each side

**Mine** — branch `feat/desktop-catalogue-parity`, commit `7fbc9c6`, worktree
`.worktrees/desktop-catalogue-parity` (base 8bcc510). Files: `desktop/islands/Catalogue.tsx`,
`desktop/islands/Catalogue.workbench.test.tsx`, `desktop/lib/theme.ts` + test,
`desktop/styles.css`, `desktop/index.html`, `desktop-catalogue.playwright.ts`,
`outputs/desktop-catalogue-parity/` (18 captures + README).

**Sibling** — task `HJXe1HMRVbRXgEpG0mI77x` is **stopped** (13:29), so its work is frozen.
It is **uncommitted** in the main checkout on `fix/native-capture-admin-parity` (8bcc510):
- modified: `app/api.ts`, `app/lib/desktop-auth.test.ts`, `desktop/islands/Catalogue.tsx`,
  `desktop/lib/session.ts`, `desktop/lib/session.test.ts`, `desktop/styles.css`,
  `demo-captures/macos/05-account-admin.png`, 12 web `admin-appearance` captures
- new: `desktop-admin-fixture.ts`, `desktop-admin.playwright.ts` (195),
  `theme-persistence.playwright.ts` (162), `desktop/lib/theme.ts` (62) + `theme.test.ts`,
  `demo-captures/desktop-admin/` (16 png), `outputs/desktop-admin-parity/` (2 md),
  `.work/macos-capture/`

Divergence measured (`diff` mine vs theirs): `desktop/styles.css` 191 lines,
`desktop/islands/Catalogue.tsx` 409 lines, `desktop/lib/theme.ts` 51 lines.

## Desktop CSS — key differences

Sibling (`desktop/styles.css`, 210 lines) keeps the **old desktop catalogue** rules and adds
the shared shell on top:
- Still styles a bespoke row list: `.desktop-galleries`, `.desktop-gallery`,
  `.desktop-gallery-row` (thumb left/right variants), `.desktop-gallery-copy`,
  `.desktop-gallery-heading`, `.desktop-gallery-link`, `.desktop-gallery-thumb`
  (`height: 16dvh`, `max-width: min(42%, 320px)`, `object-fit: contain`),
  `.desktop-gallery-actions`, `.desktop-badge-unavailable`.
- Still styles the **inline photo grid** the island expands in place: `.desktop-grid`
  (`repeat(auto-fill, minmax(140px, 1fr))`) and `.desktop-thumb` with
  `aspect-ratio: 1; object-fit: contain` — square, letterboxed thumbnails, not a rail.
- Light mode only reaches those old mounts: `html.light .desktop-gallery-thumb,
  html.light .desktop-thumb img { background: #dcd7cb }` plus `.desktop-paste`/`.desktop-share`.
- Page ground handled with `:has()`: `body.manorama-desktop:has(.admin-page) { background:
  #111312; overflow: clip auto }`, `html.light body…:has(.admin-page) { background: #e9e5dc }`,
  and `.admin-page--selector { padding-top: calc(safe-top + clamp(28px,5vw,64px)) }`.
- `.desktop-sync-state` at `rgba(ink, .48)`; `.desktop-paste-hint` at `.48`;
  `.desktop-share-provider-note` at `.52` — all under AA for their size in light mode.
- The stage-arrows/control-logo block is **duplicated**: lines 165–173 and again 206–210,
  the second pair overriding with `var(--desktop-chrome-height)`. A leftover from an edit
  collision; mine has it once.

Mine (`desktop/styles.css`) drops the old row/grid rules entirely and adds the workbench
layer:
- `.desktop-catalogue`, `.desktop-source-actions`, `.desktop-source-note`,
  `.desktop-device-line`, `.desktop-badge-unavailable`, `.desktop-empty`.
- `.desktop-catalogue .admin-gallery-strip-item` as a **button** (reset + `cursor: zoom-in`)
  with the shocking-pink `is-active` frame (`outline: 3px solid #fc0f0f…` → `rgb(252,15,192)`)
  and a visible focus ring — the web dashboard's rail, made clickable.
- `.desktop-share-host { grid-column: 1 / -1 }`.
- Light mode corrects the surfaces this shell paints itself (`body`, `.desktop-welcome`,
  `.desktop-shell`, `.desktop-paste`, `.desktop-share`).
- Muted small text raised to clear AA after the browser suite measured 4.32:1
  (`.desktop-device-line` .72, `.desktop-sync-state` `--admin-muted`, hints .68, `.desktop-empty` .7).
- Stage-arrows/control-logo rules appear once, with the comment explaining why the
  fixed-position button cannot use `height: 100%`.

## Catalogue island

Sibling keeps `openGalleryId` (line 111) — the card that expands **in place** with the
inline grid — alongside the new shared shell (`admin-page admin-page--selector`
`data-admin-ready="true"`, `.admin-overview`, `.admin-welcome`, `.gallery-import`,
`.admin-edge-tab`, `.admin-drawer` with `desktop-account-drawer` id and the theme action).
So it is a hybrid: web shell + desktop's own gallery list.

Mine removes `openGalleryId` entirely: the gallery list is the web dashboard's
`admin-gallery-card` + `.admin-gallery-strip` (one gapless, aspect-true row of clickable
originals, first frame pink), and a thumbnail opens the shared viewer at that index.

## Their fixture (worth taking)

`desktop-admin-fixture.ts` — shared by their specs, not a spec itself:
- `PIXEL` 1×1 transparent GIF as the `convertFileSrc` stand-in, so thumbnails paint with no
  real file access.
- Two galleries (folder + memory card) and a **`tier: 'pro'`** session.
- `installBridge(payload)` — serialized init script answering `read_private_file`,
  `write/delete_private_file`, `register_saved_gallery_roots`, `pick_gallery_root`,
  `plugin:fs|exists`, `plugin:fs|read_dir`.
- `blockProductionApi(page)` — routes `https://manorama.xyz/**` to a stub and counts calls.

Mine is self-contained inside `desktop-catalogue.playwright.ts`: it serves the owner's real
photographs through a route interception (so rail geometry is measured against real files),
stubs the same commands, and runs WebKit + Chromium at three window sizes.

## Still to inspect

- `desktop-admin.playwright.ts` (195) and `theme-persistence.playwright.ts` (162).
- `desktop/lib/theme.ts` (62) — theirs vs mine.
- `app/api.ts` + `desktop/lib/session.ts` (+ their tests): the `tier` on the session and the
  plan line in the pane.
- `outputs/desktop-admin-parity/*.md` — their claims.

## Convergence plan (draft)

One branch, `feat/desktop-catalogue-parity`, containing a single coherent implementation:
1. Keep my workbench + rail + viewer wiring (that is the parity the request asks for).
2. Take their `desktop-admin-fixture.ts` and adapt my spec to it (shared fixture, one place
   for the bridge), keeping the real-photograph route interception for geometry.
3. Fold their `theme-persistence.playwright.ts` coverage into the suite (reload persistence,
   clean URL) rather than shipping a second spec with its own fixture.
4. Take the session `tier` work (`app/api.ts`, `desktop/lib/session.ts` + tests) and the plan
   line in the pane, since the web/iOS panes state the plan.
5. Reconcile `desktop/lib/theme.ts` to one module; keep whichever has the fuller surface.
6. Regenerate my captures for the merged UI; **do not** merge their `demo-captures/*` — they
   show their UI, and the native macOS capture cannot be regenerated here (no freshly built
   bundle), so it stays out and is flagged.
7. Verify: `tsc --noEmit`, `bun run test:unit`, `bun run build:desktop`, the Playwright
   matrix on both engines. Then commit, ready for PR.