# Slice 6 — final-delta independent review verdict

Reviewer: Qoder Desktop independent-reviewer session (dispatched separately from the implementer).
Reviewed artifact: the CURRENT uncommitted working tree of
`/Users/home/DEV/tools/manorama/.worktrees/event-clustering-hardening`, branch
`chore/event-clustering-hardening`, base HEAD
`5bfdf41acb46ccac44d75c9559236b763d41491d` with 40 modified and 4 untracked paths
(`git status --porcelain` = 44 lines on arrival and 45 at the end of this review — the extra entry is
this verdict file itself; no implementation, test or document path changed, and no stash was created
or popped).
This file supersedes nothing: `outputs/slice6-review-verdict.md` (rounds 1–2) stays untouched, byte for byte.
Scope per instruction: review only — no implementation, test or document was edited; nothing was
delegated; no remote, install, deploy, migration, push, commit or destructive cleanup was run; the long
iPhone/iPad/Android device lanes were not duplicated. Synthetic fixtures only; no real photograph or
secret was read, copied or reported.

## 1. Checks I actually ran (my own measurements, not quoted from the implementer)

| Lane | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0, no diagnostics |
| Unit suite | `bun run test:unit` (mirrored root, unfiltered) | 2757 pass / 0 fail, 34949 expects, 218 files |
| Rust core | `cargo test --locked -p event-clustering` + `--features fs-scan`, `android`, `fs-scan,android` | exit 0 all four feature combinations |
| Rust lint | `cargo clippy --locked -p event-clustering --all-targets --features fs-scan,android -- -D warnings` | exit 0 |
| Tauri shell | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets`; same under `-D warnings` clippy | 48 pass / 0 fail; clippy exit 0 |
| Swift engine | `bash scripts/test-event-clustering.sh` | 78 tests, 0 failures |
| macOS boundary | `bash scripts/test-macos-boundary.sh` | exit 0, two `ALL PASS` sections; 263 `PASS` lines across `BoundaryTests` (146) + `ManoramaMacTests` (117), 0 `FAIL`; separate 50k invocation 11 `PASS` (274 `PASS` in total) |
| 50k performance | same optimized binary, `--event-index-performance-50k` | initial scan 3.092 s; unchanged rescan 0.830 s; peak RSS 194.58 MB (194494464 → 194576384 bytes); `initial headers=50000; rescan headers=0; events=2500; members=50000`; all inside the <10 s / <1 s / <300 MB budgets |
| Desktop acceptance | focused `specs/desktop-events.playwright.ts` | 10 passed / 0 failed (26.5 s) |
| Runner safety | read `scripts/test-all-surfaces.sh` end to end | fail-closed: `record FAIL` on any non-zero lane, final `[[ "$FAIL_COUNT" -eq 0 ]]` gate; skips require an explicit `MANORAMA_SKIP_*` or a missing prerequisite, never a silent pass |

Device lanes were read from the implementer's logs, not re-run:
`/tmp/manorama-slice6-all-surfaces.log` ends `17 passed, 1 failed, 1 skipped`, the single FAIL being
`iOS seeded simulator tests … exit 65` at `EventAssetImagesTests.swift:533/535/536`
(`("[]") is not equal to ("[2, 2, 3]")`, `("0") is not equal to ("7")`);
`/tmp/manorama-slice6-ios-rerun.log` then shows `Executed 28 tests, with 0 failures` and the lane
`1 passed, 0 failed, 15 skipped`. So the defect was real, was disclosed, and the rerun is a real
repair — not a re-label of the same red run.

## 2. Post-delta items from the brief, verified against current source

- Single `main` landmark: prop declared `app/components/GalleryShell.tsx:16`, defaulted and applied at
  `:69-70` (`const Shell = landmark ? 'main' : 'div'`); embedded viewers opt out at
  `desktop/islands/EventViewer.tsx:182` and `native/islands/EventViewer.tsx:200`; the regression is
  asserted both ways at `app/components/GalleryShell.test.tsx:47-51` (default starts
  `<main class="gallery-shell"`, `landmark: false` starts `<div` and contains no `<main`).
- Desktop day targets and label wrap: `desktop/styles.css:789` uses
  `min-block-size/min-inline-size: var(--m-touch)` with `.75rem` label type, `:791` adds
  `overflow-wrap: anywhere` to `.event-card-open`, `:777` gives the pill the same 44 px floor;
  `--m-touch: 44px` is inherited from `app/styles.css:101` via `desktop/styles.css:1`. Native mirrors it:
  `native/styles/event-clustering.css:18` (wrap) and `:19` (`min-block-size: 2.75rem`).
- Dynamic Type: `desktop/index.html:6` and `native/index.html:6` both ship
  `<meta name="text-scale" content="scale" />`, asserted at `specs/desktop-events.playwright.ts:333`.
- Spec growth to 10 tests: `specs/desktop-events.playwright.ts` declares exactly 10 `test(` blocks;
  axe runs four analyses across three scopes — rail `:334` and `:348` on `[data-camera-roll-mode]`, viewer
  `:356` on `[role="dialog"]`, settings `:364` — each `violations).toEqual([])`; 200 % text plus reflow,
  per-day ≥44 px, and `naturalWidth === 640` intrinsic checks at `:221`, `:355`, `:387`;
  Settings is waited out through `element.getAnimations()` at `:200`, so entrance animation cannot
  mask the panel; captures are element-scoped and the fixture path is asserted absent at `:308`
  (`not.toContainText('/synthetic/')`).
- Fixture prefix reachability: `scripts/test-all-surfaces.sh:211` and
  `.github/workflows/ios-verify.yml:58` both `mkdir -p "$app_data/Documents"` before writing the marker,
  which is what makes the install-time handoff work when exports are not inherited by the
  `xcodebuild` test process; the test reads marker → env → `event-demo-` fallback at
  `ios/App/EventAssetImagesTests/EventAssetImagesTests.swift:503-509`.
- Seeded iOS grouping is now isolation-correct without going soft: seven fixture assets are still
  demanded (`:519`), clusters that touch the current batch are selected (`:530-533`), per-cluster
  intersection counts must equal `[2, 2, 3]` (`:534-537`), and current membership must be covered
  exactly (`:538-541`). `rootPath` must stay absent from the pick reply (`:525`).
- Plan/contract wording: `docs/PLAN-Event-Clustering-All-Surfaces.md:3` says "slices 1–6 verified
  locally; owner/device release gates remain" — no release claim; §7's results table and the
  iPad fixture-isolation narrative match the logs above; `:101`, `:102`, `:104`, `:140` keep the
  unrun cross-checks, packaging and physical-device work stated as not done.

## 3. Owner rules and invariants across the whole Slice 6 delta

Re-checked against source, not against the description of it:

- Ordinary Library never scans or shows event contents: `git diff HEAD --name-only` touches no
  `app/routes/`, `app/islands/` or `app/lib/` file, and no event controller mounts there. The pill
  changes only the right rail (`desktop/islands/EventClusters.tsx`), Settings owns one folder action,
  and unmount tears the controller down.
- Invariant 1 (no server persistence): no migration, no D1/R2/KV/cache writer appears in the delta;
  event media stays on-device behind leases.
- Invariants 2 and 13 (never re-encode, never upscale): the delivered original is byte-identical —
  `assert_eq!(response.body(), &before)` survives at `src-tauri/src/event_clustering_tests.rs:580`
  and the range read at `:628`; the spec pins `naturalWidth === 640`, i.e. intrinsic pixels
  (`specs/desktop-events.playwright.ts:221,355,387`).
- Lease integrity and races: `bound_member` returns ancestor identities (`:701`),
  `member_chain_is_current` (`:729`) is consulted by `open_verified_file` (`:824`),
  `lease_is_current` (`:952-955`) and again after the read in `asset_response` (`:1063`), with
  `respond_event_asset` holding the EventState mutex through handoff (`:1069`);
  `clear_cannot_complete_before_an_asset_response_is_handed_off`
  (`src-tauri/src/event_clustering_tests.rs:739-791`) proves it by asserting clear could not finish
  early and that the same lease then answers 404.
- Provenance separation: `pick_raw_dump_root` holds the lock across declare + watcher install with no
  off-lock enumeration (`src-tauri/src/event_clustering.rs:516-533`), `declaring_a_picked_folder_never_
  enumerates_it` pins `item_count == 0` and no index, and
  `selecting_or_clearing_dump_never_grants_a_gallery_root` plus
  `clear_wins_late_scan_and_does_not_recreate_index` now assert
  `raw_dump_roots_path().exists() && !roots_path().exists()` — the gallery catalogue is provably
  untouched by a dump grant. `EventState::load` fails closed on a missing dump approval (`:145-152`).
- Native-issued URLs only: `packages/core/event-clustering.ts:79-90` restricts accepted file URLs to
  the `event-thumbs/<64hex>.jpg` and `event-originals/<lease>/<lease>.<ext>` shapes, and
  `parseEventAssetImages` (`:100-116`) requires a ready asset to carry a lease/file URL plus positive
  integer dimensions. `packages/core/event-clustering.test.ts:477-478` now expects `false` for
  `file:///Users/example/Photos/a.jpg` and `file:///C:/Photos/a.jpg` — a deliberate tightening
  (the removed lines were the corresponding `true` expectations), not a weakened gate.
- Renderer path joins: `allow_root` (`src-tauri/src/lib.rs:18`) grants fs scope only; the removed
  `assert!(fixture.paths.roots_path().exists())` in the iOS/Tauri provenance tests is replaced by the
  stricter pair above; `desktop/islands/EventClusters.test.tsx:402` and the fixture keep synthetic
  identifiers, and the spec forbids the path from reaching the surface (`:308`).
- Android: `submitSettled` guarantees exactly-once settlement including
  `RejectedExecutionException`; the scan reply carries `rootPath` NULL; `assetGeneration` is captured
  before handoff; `crates/event-clustering/src/calendar.rs:91-97` defaults to `FixedOffset::east_opt(0)`
  with `use chrono::Offset` gated off Android, so the golden parity is not perturbed.
- Cloud metadata-only: `cloudOnly` answers a null URL and the explicit one-photo reveal is the only
  path that ever names an OS path; no automatic download is introduced.
- Invariant 8 (platform-free core): `packages/core/event-clustering.ts` carries no `window`, no
  `document`, no Node built-in and no Capacitor import — the only match for that grep is its own
  invariant comment at `:11`.
- No provider mutation and no invented procedure: the delta contains no provider write path, and every
  gate quoted in the docs corresponds to a script I read or ran.
- Test-integrity sweep: of the 9 removed assertion lines in the delta, every one is either a spacing
  update with an equivalent-or-tighter replacement
  (`native/islands/CameraRoll.test.tsx:194` → `'12 – 13 Mar 2026'`;
  `native/islands/EventSection.test.tsx` → `/12\s*–\s*13 Mar 2026/`;
  `packages/core/event-clustering.test.ts:252` → `'12 – 16 Mar 2026'`), an allowlist tightening (above),
  or a signature/coverage upgrade (the 3-argument `asset_item` chain assertion, the two
  `roots_path`/`raw_dump_roots_path` pairs). Nothing was skipped, deleted or relaxed to make a run green.

## 4. Findings

No P0, P1 or P2 findings in the current tree.

P3 (all non-blocking, listed explicitly as permitted by the brief):

1. **Stale boundary check count in the docs.** `docs/PLAN-Event-Clustering-All-Surfaces.md:100` and
   `:390`, plus `docs/event-clustering-bridge-contract.md:410` and `:436`, state 262 checks. The lane
   I ran prints 263 across `BoundaryTests` + `ManoramaMacTests` (146 + 117), with 11 further checks in
   the separate 50k invocation (274 `PASS` lines in total). It is an undercount, so no claim is
   inflated, but the number is one behind the tree.
2. **Pre-existing cross-file DOM coupling breaks filtered runs.** `desktop/islands/EventClusters.test.tsx`
   captures and restores `globalThis.SVGElement` in its `beforeEach`/`afterEach` pair (`:136`, `:148`,
   restore loop `:154-160`). hono keeps a process-level namespace context once any `<svg>` renders
   (`node_modules/hono/dist/jsx/dom/render.js:19`, `:32`, `:411-413`), so after that file runs,
   `native/islands/EventSection.test.tsx:113` and `:146` throw
   `TypeError: Right hand side of instanceof is not an object`. I proved this predates the delta:
   base `EventClusters.test.tsx:136/148` already had the `SVGElement` capture/restore, base
   `desktop/islands/EventClusters.tsx:100` already rendered `ActionGroup`/`ActionRow`, and
   `app/components/ui/ActionRow.tsx` already contained the `<svg>`; the delta adds no `<svg>` to any
   source file and no import that would. The sanctioned runner is unaffected — the full mirrored suite
   is 2757/0 — and two untouched files already document the correct convention that
   `LocalGalleryDetails.test.tsx:174-177` and `Catalogue.workbench.test.tsx:436-439` follow
   ("SVGElement and the rAF pair stay installed"). This is an outside-scope test-isolation nit against
   an existing file, not a Slice 6 defect; it is why `bun test <4 files>` reports 82 pass / 2 fail.
3. **iOS seeded gate tolerates same-date older batches.**
   `ios/App/EventAssetImagesTests/EventAssetImagesTests.swift:528-537` intersects current-prefix ids
   with clusters that may also contain older fixture batches, so the gate proves the current batch
   groups 2/2/3 and is fully covered (`:538-541`) without proving the events contain nothing else.
   The reason is stated in the comment and is the right trade for a reused simulator; a per-run
   library wipe would let it assert exclusivity later.

Environment note, not a code finding: this volume is at 100 % capacity (6.0 GiB free during the run).
While probing base-commit behaviour I created `/tmp/slice6-base-probe` and a partial
`/tmp/slice6-hybrid`; the second failed with `No space left on device` and both were removed. Nothing
in the reviewed tree was written by those probes — `git status` matches the arrival state recorded at
the top of this file, and base HEAD `5bfdf41` itself carries a duplicate-declaration defect in
`packages/core/event-clustering.ts` (`MAX_EVENT_ASSET_BATCH` at blob lines 60 and 120) that the current
delta removes, which is why a base-tree probe cannot load the module.

## 5. Owner and device gates that remain unclosed

Reviewer approval does not clear any of these; they are quoted from
`docs/PLAN-Event-Clustering-All-Surfaces.md` and were not available to me:

- Full packaged, sandboxed macOS six-state evidence matrix at the documented submission dimensions;
  the current lane ran an unsandboxed evidence-only bundle with synthetic frames (`:101`).
- Windows and Linux Tauri behaviour on real hosts: cross-checks stop in host dependencies here,
  Linux Docker and the Windows CI path are prepared and not run (`:102`); the runner reports Windows as
  `requires a Windows runner`.
- The broad Playwright matrix is not green — `:104` records 61 failed / 386 passed / 8 skipped with a
  60-failure clean-base reproduction and no demonstrated Slice 4/6 regression; only
  `specs/desktop-events.playwright.ts` (10/10) was in scope here.
- A physical Pixel partial-access check (`:140`) and any physical-device result; iPhone/iPad results
  above are simulator runs, not devices.
- App Store / RevenueCat / AdMob and Mac submission steps in `docs/owner-setup-runbook.md`, plus any
  public clearance of the synthetic-capture evidence in `outputs/slice6-accessibility/` — captures from
  this slice are synthetic-fixture evidence only.
- Release pointer, deploy, migration and merge decisions stay with the owner.

Verdict: APPROVED as a local checkpoint.
