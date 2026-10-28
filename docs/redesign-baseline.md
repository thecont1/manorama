# Redesign P0 baseline — 28 Oct 2026

Recorded on branch `feat/redesign-contracts-baseline`, worktree at commit
`70554cc` (docs reconciliation; application code identical to integration-base
`69e334a` on `feat/iphone-redesign`). Commands run per megaplan §8.1.

## Check results

| Check | Result | Notes |
|---|---|---|
| `bunx tsc --noEmit` | PASS | clean, exit 0 |
| `bun run test:unit` | PASS | **1178 pass / 0 fail**, 95 files, ~20s |
| `bun run build` | PASS | client + worker bundles built |
| `bun run build:native` | PASS | Vite-only SPA build — safe for CI |
| `bun run build:desktop` | PASS | Vite-only SPA build — safe for CI |
| `bun run vendo:check` | PASS | `git diff --exit-code` clean; **no tracked-file churn to revert** |
| `.env.local` `MANORAMA_DEV_SOURCE_*` | present | all four (ICLOUD, MEGA, DROPBOX, GDRIVE) defined — presence only, values never printed |

## Playwright (default suite)

Command: `GALLERY_URL=http://localhost:5173 GALLERY_VIDEO_SLUG=mixed-album NATIVE_GALLERY_URL=http://127.0.0.1:5174 DESKTOP_URL=http://127.0.0.1:5175 bunx playwright test`

Second (stable-server) run, JSON reporter: **208 passed / 3 failed / 9 skipped (~5.5 min)**.

| Spec file | pass | fail | skip | Notes |
|---|---|---|---|---|
| admin-fold.playwright.ts | 1 | 1 | 0 | native variant needs `CAPTURE_URL`; **passes 2/2 with capture server on 4182** |
| desktop-auth-local.playwright.ts | 2 | 0 | 0 | |
| doodle-background.playwright.ts | 10 | 0 | 0 | |
| fold.playwright.ts | 12 | 0 | 0 | |
| native/ads.playwright.ts | 14 | 0 | 0 | |
| native/global-view.playwright.ts | 4 | 0 | 0 | |
| qa.playwright.ts | 143 | 2 | 8 | 1 real failure + 1 transient; skips are touch-only tests on non-touch viewports |
| theme-persistence.playwright.ts | 4 | 0 | 0 | |
| vendo-slot.playwright.ts | 2 | 0 | 0 | |
| vendo-surface.playwright.ts | 3 | 0 | 1 | authenticated Ask-Manu spec skipped by design (`SKIP_ACCESS_FIXTURE_TESTS` unset / fixture absent) |
| video-playback.playwright.ts | 5 | 0 | 0 | |
| video-size-cap.playwright.ts | 6 | 0 | 0 | |
| viewer-preferences.playwright.ts | 2 | 0 | 0 | |

Specs excluded by `playwright.config.ts` `testIgnore` (need `PW_EVIDENCE=1`, they rewrite
committed captures): capture-harness, admin-appearance, desktop-admin,
desktop-catalogue, native-vault-controls. **Not run** — running them would dirty
the tree by design.

### Failure classification

**Real (deterministic) failure — 1:**

- `qa.playwright.ts:2360` *privacy policy page › renders three persona cards and
  the shared sections semantically* — stale assertion, not a product bug. The
  spec expects region **"Pro or Forever"**; `app/routes/privacy.tsx` now renders
  **"Pro"** (personas: Just looking / Making galleries / Pro). The code drifted
  from the test. Reproduced twice on a stable server. The redesign renames
  user-facing Pro copy to Visionary anyway (P9) — fix the persona name in the
  same change.

**Environment / fixture (resolved by rerunning with fixtures up):**

- `admin-fold.playwright.ts` *native: …vertical hinge…* — `ECONNREFUSED
  ::1:4182`: needs the capture harness server
  (`CAPTURE_PORT=4182 bun .work/capture-server.ts`). Passed once started.
- 6 tests in run 1 failed `ECONNREFUSED ::1:5173` / `socket hang up` on
  `/.dev-seed/reset` — the vite dev server restarted several times mid-run while
  files were being written in the repo. All passed on the stable rerun. Lesson:
  don't write into the checkout during a suite run.

**Flaky (timing-sensitive, passes in isolation):**

- `qa.playwright.ts:843` *phone › repeated touch drags cross image boundaries* —
  "the finger teleported −79px/−532px to a different frame" under load; passed
  3/3 runs in isolation. Watch during P4.
- `qa.playwright.ts:2295` *slug edits inline* — one 90s timeout mid-suite;
  1.4s and green in isolation.

### Servers used

`bun run dev` :5173 · native fixture `vite --config vite.config.native-fixture.ts` :5174 ·
`bun run dev:desktop` :5175 · capture harness `CAPTURE_PORT=4182 bun .work/capture-server.ts` :4182.

## Fixture inventory and gaps

Megaplan P0 needs deterministic coverage for: empty, free, paid, pipeline,
mixed video, original-byte cached, partial fill, offline, C2PA, desktop local.

| Fixture | What it is | States covered |
|---|---|---|
| Dev-seed plugin (`vite.config.ts`, :5173) | Seeds pro owner `thecontrarian` (live-scanned albums from `MANORAMA_DEV_SOURCE_*` → `mixed-album` w/ video, `dev-mega`, `dev-dropbox`, `dev-gdrive`) and free `retention-qa`. Seams: `/.dev-seed/{reset,spawn,tier,expire,login,desktop-login}`; spawn items are 1×1 data-URI PNGs with synthetic dims and a `c2pa` flag. Local-folder source enabled in dev. | **empty** (reset), **free**, **paid** (tier seam, pro owner), **pipeline/temporary** (spawn overflow + expire), **mixed video** (iCloud album, env-gated), **signed-out visitor**, local-folder galleries. |
| Native fixture server (`vite.config.native-fixture.ts`, :5174) | Serves the real native app (MPA) plus `/ads-fixture` entry; deterministic manifests for `ads-fixture` (60/36-frame ad cadence), `fold-fixture`, `global-fixture` via `?owner=fixture&slug=`; `__MANORAMA_AD_FIXTURE__` pins tier, `__MANORAMA_AD_FIXTURE_STATE__` exposes the stored manifest. | ad cadence/safety, fold geometry, picker/global view, tier variants (free/pro). |
| Global-view fixture (`.work/global-view-fixture.tsx`, `native/global-view.playwright.ts`) | 12-frame deterministic picker matrix with scroll-driven lazy thumb materialization; free tier only. | picker entry/scroll/lazy load. |
| Capture harness (`.work/capture-server.ts` + `capture-harness.playwright.ts` + `scripts/capture-*.sh`) | Serves the real `native/dist` bundle with a state driver (0–6: curtain, first image, controls, account, Global View, preview takes); seeded session answers, live visibility switch. | six-state evidence; `admin-fold` native variant via `CAPTURE_URL`. |
| Desktop fixture (`desktop-admin-fixture.ts`, :5175) | Stubs `window.__TAURI_INTERNALS__` (installBridge), `buildCatalogue` from real photos on disk (`MANORAMA_DESKTOP_SOURCE` or `~/Pictures`, ≥4 required), `servePhotos` route interception, `blockProductionApi`. | **desktop local** catalogue, both themes, workbench — evidence specs only (testIgnore'd). |
| Unit-test in-memory stores (`native/lib/offline-gallery.test.ts`, `vault*.test.ts`, `global-view.test.ts`) | Fake vault/persistence; original-byte writes, commit-last metadata v1, cap/purge, GridThumbLoader. | **cached** (original bytes), cap/purge, leases — unit level only. |

**Gaps (no deterministic fixture today):**

- **Original-byte cached / "kept" gallery in a browser**: vault coverage is
  unit-level; no seeded browser state with a fully cached gallery on the
  Library. Needed for P5/P6 (vault-first paint, per-item-ready rail swap).
- **Partial fill**: no interrupted-fill or partial-metadata state anywhere.
- **Offline**: no browser-level offline run (network-fail fallback is unit
  tested only).
- **C2PA with real signed bytes**: the `c2pa` flag is synthetic in spawns; the
  validating path depends on the seeded live album containing credentialed
  photos (`qa:2019` skips when it doesn't). No deterministic C2PA-positive or
  flagged-but-unchecked fixture.
- **500/1,000-item galleries**: spawn can mint manifests, but no rail fixture
  with hundreds of real thumbnails; nothing exercises the PATCH order >500 bound
  (P8) or bounded rail loading (P5) end-to-end.
- **Paid/pipeline/mixed/empty on the *native* fixture**: the fixture server
  tiers pin to free/pro for ads only; Library states (error, offline, temporary,
  over-cap) have no deterministic browser fixture.
- **Desktop local**: covered only inside testIgnore'd evidence specs, and
  requires owner photos on disk — not portable.

## Open items for the lead

- The privacy persona assertion is a real red check inherited from `main`-era
  drift. Recommend fixing the stale test (or the copy, if "Pro or Forever" is
  meant to return) in P9 rather than on this branch — noted, not changed.
- `scripts/prototype-capture.mjs` is a throwaway P0 tool kept alongside the
  PNGs it produced; delete or keep per repo preference.
