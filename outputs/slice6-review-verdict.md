# Slice 6 review verdict — Event Clustering hardening

Reviewer: independent qfmodel (this session)
Implementer: hmodel (session 83744dfb-059e-4e82-bf89-71ca27f9a587)
Branch: `chore/event-clustering-hardening`
Base HEAD: `5bfdf41acb46ccac44d75c9559236b763d41491d`
Working tree reviewed: uncommitted diff + surrounding reachability. No edits made to implementation.

## Scope

This verdict covers Slice 6 (hardening) against the six criteria set by the owner brief:

1. Privacy / immutable-original invariants.
2. Tauri raw-dump approval separate from curated roots, opaque leases, race handling, fail-closed legacy declarations.
3. Android permission/partial-access/cloud-only/cancellation/generation correctness and byte-exact private lease.
4. Rust/Swift/wire parity, bounded metadata reads, truthful 50k budgets.
5. Native/desktop presentation: localization, semantics, focus return, no upscaling, accessible names.
6. All-surfaces runner and seeded tests make no false claims; docs distinguish unavailable hardware gates.

The two tradeoffs (Tauri built-in drag-drop asset scope; global `EventState` mutex held through asset delivery) are assessed for reachability and for whether they breach the event-media boundary. Unrelated refactors are out of scope.

## Verification I ran (all local, none destructive, none remote)

| Check | Command | Result |
|---|---|---|
| TypeScript | `bunx tsc --noEmit` | clean (exit 0) |
| Bun unit suite | `bun run test:unit` | 2756 pass / 0 fail, 34946 expects, 218 files, 58.62 s (mirror script) |
| Rust core, all features | `cargo test --locked -p event-clustering --all-features` | pass |
| Tauri shell | `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets` | 48 pass / 0 fail |
| Desktop Playwright (event surface) | `bunx playwright test specs/desktop-events.playwright.ts --reporter=line` | 9 pass / 0 fail in 9.6 s (fresh Vite; 1440×900 desktop + 390×844 touch, six product rules and two controller races) |
| macOS boundary + real EXIF 50k gate | `bash scripts/test-macos-boundary.sh` (background task `ba1f1ruvw`) | exit 0, ALL PASS; initial scan 3.722 s, unchanged rescan 0.821 s, rescan reads=0 headers, events=2500, members=50000, peak RSS 187.51 MB (< 300 MB), all synthetic files cleaned up |

Mobile lanes (iPhone/iPad simulator, Android emulator) are running elsewhere per the brief; I did not duplicate them. Packaged/physical-device gates remain owner-device gates.

## Findings by criterion

### 1. Privacy / immutable-original

No server code touched (invariant 1 — `app/**`, D1, R2, KV untouched by this diff). No re-encode path (invariant 2):
- Android viewer path: `native/.../EventAssetService.kt` writes bytes read from `MediaStore` into `cacheDir/event-originals/<uuid>/<uuid>.<ext>` byte-for-byte and returns a `file://` URL; no re-encode or scaling of the original. Thumbnails use `ImageDecoder`/`PHImageManager` with `isOmitNormalization = true` (existing, unchanged) and are not upscaled.
- macOS: `macos/ManoramaMac/EventAssetProtocol.swift` streams the file unchanged through a custom scheme handler with `EXIF orientation` respected at the header level (BoundaryTests orientations 1–8 pass; header read capped at 4 MiB — bounded metadata read).
- Desktop: `src-tauri/src/event_clustering.rs:1000 asset_response` reads the file bytes verbatim and re-validates the ancestor chain before and after open (`open_verified_file` at :824 and post-read check at :1063). No re-encode.

Invariant 13 (no upscaling on render) is enforced in `native/islands/EventSection.tsx`, `CameraRoll.tsx`, `desktop/islands/EventClusters.tsx` via `maxInlineSize`/`maxBlockSize` min(100%, w/dpr). `specs/desktop-events.playwright.ts:218-219,342` asserts every cover and the viewer image report `naturalWidth === 640` (intrinsic, never stretched); the extreme-DPR no-upscale matrix is asserted by the Jest island tests.

No provider mutation (invariant 9): `FolderDumpScanner.enumerate` (macOS) now uses `opendir/readdir/lstat` and explicitly avoids provider-hydration resource-value queries, with `pixelsAreLocal = logicalSize <= 0 || allocatedSize > 0` to distinguish cloud placeholders — indexing never downloads. The path-based scanner and Android `MediaStore` query are read-only.

**Result: no findings.**

### 2. Tauri raw-dump provenance, opaque leases, and clear/change races

- Raw-dump approval is stored separately from curated gallery roots: `src-tauri/src/private_store.rs` adds `DUMP_ROOTS_FILE` (`raw-dump-roots.json` in the config dir) with 0600 permissions, `raw_dump_roots_at`, and `record_raw_dump_root`. `src-tauri/src/event_clustering.rs:320 replace_source` calls `record_raw_dump_root`; `:510-514 declare_raw_dump_root` records the approval without enumeration. `allow_root` at `src-tauri/src/lib.rs:18-24` now grants only `fs_scope`; the earlier `asset_protocol` grant is gone.
- Opaque leases: the `manorama-event://localhost/<32hex>` (mac/Linux) / `http://manorama-event.localhost/<32hex>` (Windows) URL carries only a random token. The renderer never constructs media URLs from `rootPath` or item ids — asserted by `specs/desktop-events.playwright.ts:306` (assertion `not.toContainText('/synthetic/')`) and by `packages/core/event-clustering.ts:100-116 parseEventAssetImages`, which via `isEventAssetUrl` (:97) now requires every `ready` URL to be either an opaque lease (`isEventAssetLeaseUrl` :93) or a private issued mobile file URL (`isEventAssetFileUrl` :79, see #4).
- Legacy roots-only declarations fail closed: `EventState::load` at `src-tauri/src/event_clustering.rs:145-154` returns a config-only source when `raw-dump-roots.json` is missing identity or `source_id`, so an earlier build's `roots.json` entry is never restored. `unprovenanced_native_declaration_never_restores` proves it, and the Playwright spec proves it live (clear/reinstall the dump declaration and reload → notConfigured).
- Ancestor / leaf / root replacement is rejected: `bound_member` (:701) returns the ancestor chain, `member_chain_is_current` (:729) is checked before and after the open (`open_verified_file` :824) and again after the bytes are read (`asset_response` :1063). `asset_lease_rejects_ancestor_replacement` (event_clustering_tests.rs:709) asserts NOT_FOUND.
- Clear vs in-flight response: `respond_event_asset` (:1069) holds the `EventState` mutex through the asset-response handoff; `clear_cannot_complete_before_an_asset_response_is_handed_off` (event_clustering_tests.rs:740) proves the ordering. `selecting_or_clearing_dump_never_grants_a_gallery_root` (:155) proves Settings selection/clear performs no enumeration and no gallery fs-scope grant.

Tradeoff (a) — Tauri's built-in drag-drop auto-granting asset scope: the built-in handler only fires on paths physically dragged into the WebView; the raw-dump is declared via the native dialog path (`pick_folder`) and never enters the gallery roots list (`guard_gallery_roots` at `src-tauri/src/lib.rs:110-218` rejects a gallery drop that is not already approved). Event media URLs are opaque leases, not real paths, so a drag-granted asset scope on some folder does not read event originals through the event protocol and does not widen event reach. This is not a breach of the event-media boundary; residual risk is confined to gallery drops (a gallery feature), not to events. **Non-blocking.**

Tradeoff (b) — global `EventState` mutex held through asset-response construction and delivery: I traced both entry points and the delivery call site. The lock is only re-entered by the same code path; `clear_source` and `replace_source` also acquire it, which is the intended serialization. The lock is held inside `spawn_blocking` on the Tauri side so the async runtime is not stalled. The consequence is that a clear during a large asset read waits for the read to hand off — the intended behavior, proven by `clear_cannot_complete_before_an_asset_response_is_handed_off`. The only downside is latency on the tail of a large-original read, not a privacy breach. **Non-blocking; P3 latency nit.**

**Result: no P0/P1/P2 findings. Two P3 nits: latency (tradeoff b) and pre-release fs-scope drift documented below.**

P3 (informational, non-blocking): an upgraded pre-release slice-4 dev build could have recorded the dump into gallery `roots.json`, granting inert fs scope to an orphaned path. That declaration now fails closed on load, so event media never flows through fs scope. This is developer-build-only and pre-release; there is no shipped state affected.

### 3. Android permission, partial access, cloud-only, cancellation, and byte-exact lease

- Permission + partial access: `EventClusteringPlugin.kt` gates scanning on `MediaStore` READ_MEDIA_* and, on API 34+, on `PhotoPicker`-style limited selection, returning `isAvailable:false` on denial. The Android plan (`docs/PLAN-Event-Clustering-All-Surfaces.md` § Android) states this was verified on the API 36 emulator (11 instrumentation tests including bucket scoping, API 36-safe counts, no-upscale thumbnails, byte-for-byte viewer leases, cloud-only/missing, unknown location, deterministic clear/cancel races, vanished buckets, GMT offsets, 50k JNI 0.264 s). I did not duplicate that lane; it is running elsewhere.
- Cancellation + generation: `EventAssetService.kt` bumps `purgeGeneration` on clear and each in-flight path checks `purgeGeneration == requestGeneration` before delivery; a stale worker releases the lease and reports failure instead of completing. `EventClusteringPlugin.getEventAssetImage` captures `assetGeneration` (lines 225/234/251) so a generation change cancels queued responses. `clearRejectsARequestQueuedBeforeThePurge` and `workerFailuresAlwaysRejectExactlyOnce` (added/updated JVM tests) prove the exactly-once executor settlement.
- Byte-exact private lease: `EventAssetService` writes `ContentResolver.openInputStream` bytes verbatim into `cacheDir/event-originals/<uuid>/<uuid>.<ext>`; the returned `file://` URL matches the tightened `isEventAssetFileUrl` pattern (see #4). No decode or re-encode happens on this path.
- Settings selection must not scan or load previews: `EventClusteringPlugin.kt:101-107 pickRawDumpRoot` records the declaration and returns counts only; no `scan` call and no `getEventAssetImages` call — asserted by the native EventSection/CameraRoll unit tests and mirrored in `native/islands/CameraRoll.test.tsx`.

**Result: no findings from local review. Physical-device partial-access remains an owner/device gate (docs/PLAN § Android explicitly states: "A physical Pixel partial-access check remains an owner/device gate; no physical-device result is claimed.").**

### 4. Rust/Swift/wire parity, bounded metadata reads, truthful 50k

- Parity: the golden 37-timeline corpus still passes on Swift (`bash scripts/test-event-clustering.sh` — 78 tests / 37 golden). `crates/event-clustering/src/calendar.rs` keeps the Reference-epoch arithmetic identical; the only change here is `use chrono::Offset` gated to non-Android (line 97) and the fixed-offset default at line 94 (unchanged UTC parity). Wire parity is asserted by `parseEventAssetImages` and the golden fixtures; the Swift/Rust/TS decoders reject non-integer, non-finite, and out-of-range dimensions identically.
- URL validator tightened: `packages/core/event-clustering.ts:79-90 isEventAssetFileUrl` now accepts only `/Caches/event-thumbs/<64hex>.jpg`, `/cache/event-thumbs/<64hex>.jpg`, and `/event-originals/<36>/<36>.<ext>`, so a reply can no longer smuggle a bare filesystem path. Tests updated accordingly.
- Bounded metadata reads: `macos/ManoramaMac/FolderDumpScanner.swift` enumerates via `opendir/readdir/lstat` (no `URLResourceValues` calls), skips `.`, `..`, `UF_HIDDEN`, symlinks, and packages, and marks cloud placeholders via `pixelsAreLocal`. Header reads are capped at 4 MiB by `EventAssetProtocol` (macOS boundary test 30/30 pass). Android uses `MediaStore` columns and never opens the underlying cloud asset for metadata (the plan explicitly says so).
- 50k budget: the macOS gate (`scripts/test-macos-boundary.sh` with the new `--event-index-performance-50k`) now runs a fresh process and measures real `RUSAGE_SELF` peak RSS on real EXIF-varied JPEGs. My local run: 3.722 s initial, 0.821 s unchanged rescan, peak RSS 179.86 / 187.51 MB against the documented <300 MB budget, 2500 events, 50000 unique members, all fixtures cleaned up. The docs no longer claim a still-open 50k gap on macOS — I confirmed against `docs/PLAN-Event-Clustering-All-Surfaces.md`.

**Result: no findings. The Android and desktop 50k claims are backed by the mobile lane (running elsewhere) and by the local desktop-events Playwright + Rust suites (I ran both).**

### 5. Native/desktop presentation — localization, semantics, focus return, no upscaling, accessible names

- The fixed English month table is gone; `packages/core/event-clustering.ts` uses `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.PluralRules`, `Intl.RelativeTimeFormat`, `Intl.ListFormat` for date span, counts, "indexed ago", card labels, day labels, and preview-state text. `native/islands/EventSection.tsx`, `native/islands/CameraRoll.tsx`, `desktop/islands/EventClusters.tsx` all thread a `presentation` object (locale, calendar, timezone, optional messages) and use the new `formatEventCardLabel` / `formatEventDayLabel` / `formatDaysLabel` / `formatEventPreviewState` helpers. The package remains platform-free per AGENTS.md invariant 8 — no `window`/`navigator` references.
- Semantics: the event grid is `role="list"` and sub-day containers are `role="group"`; `specs/desktop-events.playwright.ts:294-306` asserts the list role, one `listitem` per event, the card open-button accessible name (`formatEventCardLabel`), the day-group accessible name (`formatDaysLabel`), per-day `data-event-day` buttons, and that the rendered text never contains `/synthetic/`.
- No nested buttons: `EventSection.test.tsx` explicitly asserts the sub-day and card-open buttons appear in natural DOM order without nesting, so focus return lands on the still-mounted rail after the shared Viewer closes. `CameraRoll.test.tsx` confirms `overlayDepth()` returns to 0 after closing the Viewer, which the Playwright spec also exercises (the Viewer returns to the still-active event list).
- Accessible names combine visible context: the Jest test `desktop/islands/EventClusters.test.tsx` ("localized event lists retain list, group and combined accessible names") mounts with a `de-DE` presentation and asserts the `role=list` grid, the `Tage in …` day-group label, the `12. März (…)` sub-day label, and the combined card label `…März 2026, 2 Fotos und Mehrtägig` (Intl.ListFormat conjunction), plus `overflow-wrap: anywhere` in `desktop/styles.css`. The Playwright spec asserts the same structure in `en-US`. The cloud-only badge routes through `formatEventPreviewState('cloudOnly', …)` (Jest: `formatEventPreviewState('cloudOnly', { messages: { cloudOnly: 'In iCloud' } })` → `In iCloud`), and `specs/desktop-events.playwright.ts:460` asserts the viewer status reads `Not downloaded` until an explicit reveal.
- Cloud reveal/download is explicit: `specs/desktop-events.playwright.ts` asserts reveal/download appears only after an explicit reveal click; the Jest tests assert the state never becomes `ready` without a native URL.

**Result: no findings.**

### 6. All-surfaces runner, seeded tests, docs honesty

- `scripts/test-all-surfaces.sh` (new) gates every lane behind an env-var (`MANORAMA_SKIP_*`), records `PASS | name` on success, `FAIL | name | exit N` on failure, and `SKIPPED: <reason> | name` when a prerequisite (cargo, bun, Xcode, Java 21, Android SDK/NDK, cargo-ndk, Docker rust:1 cache, `MANORAMA_IOS_SIMULATOR_ID`, `MANORAMA_ANDROID_SERIAL`, `MANORAMA_LINUX_DOCKER`) is missing. It exits non-zero on any FAIL and never fakes a mobile or Linux pass on a host without the prerequisites. That is exactly the honest behavior the brief requires.
- `scripts/test-android-libraries.sh` (new) enforces two ABIs, each ≤ 1.5 MiB, each exporting all three JNI symbols, by unzipping the debug APK and running `llvm-readelf`. It fails rather than reports a false pass.
- iOS CI now seeds seven event-demo JPEGs (`scripts/seed-ios-event-photos.swift`) with a per-run unique prefix and asserts the `3/2/2` grouping plus no leaked `rootPath` — matching the plan's acceptance criterion. The seeded Swift test `testSeededPhotoKitEventsGroupByCaptureDate` reads the same prefix from the marker file or `EVENT_FIXTURE_PREFIX` and fails when neither is present: the `"event-demo-"` fallback could match stale assets left by an earlier batch, so the seven-asset assertion no longer runs without a this-run prefix — a stale device cannot silently satisfy it.
- `ios/App/App/PrivacyInfo.xcprivacy` now correctly documents that the declaration and download preference live in protected app-private state (Keychain), not UserDefaults; CA92.1 covers only unrelated Preferences/vault-display settings. That is more truthful than the pre-Slice-6 wording.
- `docs/PLAN-Event-Clustering-All-Surfaces.md` § Status ("slices 1–5 verified locally; slice 6 in progress"), § Android (physical Pixel remains owner/device gate), § macOS evidence (packaged sandboxed six-state remains a release gate) all explicitly disclaim hardware/packaged gates. The five remaining gates (iPhone 17 Pro, iPad Pro 13 M5, MacBook Pro, Pixel, packaged six-state) are named as unavailable owner gates.
- `docs/event-clustering-bridge-contract.md` § 3 and the serialization paragraph match implementation: dump approval separate from gallery `roots.json`, `roots.json` renderer-writable but never event media, "Desktop serializes clear/change with the asset-response handoff."

**Result: no findings.** No false claims in the runner, docs, or seeded tests.

## Findings summary

| Severity | Count | Notes |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 0 | — |
| P3 (non-blocking) | 3 | (i) tradeoff (b) tail latency on clear during a large asset read; (ii) tradeoff (a) Tauri drag-drop asset scope exists but is confined to gallery folders; (iii) legacy slice-4 dev builds that recorded the dump into gallery `roots.json` leave an inert fs scope on an orphaned path — declaration fails closed, so event media is unaffected. |

None of the P3s are correctness or privacy issues; each is documented above with reachability.

## Owner gates that this review cannot clear

The following gates require physical hardware or packaged artifacts I cannot produce from a code review:

- Physical iPhone 17 Pro (not simulator) — owner/device.
- Physical iPad Pro 13-inch (M5) — owner/device.
- Physical Pixel partial-access (`READ_MEDIA_VISUAL_USER_SELECTED`) — owner/device.
- MacBook Pro six-state visual evidence matrix — owner/device (also requires signed packaged build for App Store posture).
- Packaged sandboxed macOS release bundle — release gate.

Per AGENTS.md § 4 the six-state visual evidence is required for any native or desktop presentation change; the presentation change here is scoped to Camera Roll surfaces, which are documented under `docs/PLAN-Event-Clustering-All-Surfaces.md` § Native presentation evidence, so the device captures remain on the owner checklist.

## Delta re-review (post-approval production change)

After the initial `APPROVED`, the implementer landed one production delta plus a test-infra
change. This section re-reviews only those deltas and their reachability; the original
six-criterion findings above still hold and nothing here weakens them.

**What changed:**
1. `src-tauri/src/event_clustering.rs` `declare_raw_dump_root(inner: &mut Inner, root)` (:510) now
   takes the locked `&mut Inner`, and `pick_raw_dump_root` (:524-529) acquires the `EventState`
   mutex exactly once (`state.0.lock()` :526) and holds that single guard across BOTH
   `declare_raw_dump_root` (:527) and `install_watcher` (:528). The previous off-lock
   `fs_scan::enumerate` metadata count is removed entirely — selection no longer enumerates at all.
2. `event_clustering_tests.rs:120 declaring_a_picked_folder_never_enumerates_it` was adapted to
   mirror production: it locks once and calls `declare_raw_dump_root(&mut inner, …)`, then asserts
   under the same held lock `reply.item_count == 0`, `inner.status().event_count == 0`, and that no
   `INDEX_FILE` exists.
3. iOS seeded-test fixture prefix is now delivered through a file: the local runner
   (`scripts/test-all-surfaces.sh:199-215`) and CI (`.github/workflows/ios-verify.yml:54-64`)
   compute a per-run prefix and write it to the installed app container's
   `Documents/event-fixture-prefix.txt` (via `simctl get_app_container … data`) before
   `test-without-building`; `EventAssetImagesTests.testSeededPhotoKitEventsGroupByCaptureDate`
   (`.swift:504-509`) reads that marker first, then falls back to the `EVENT_FIXTURE_PREFIX` env,
   and fails the test when neither is present. The earlier `"event-demo-"` default was retired:
   it could match stale assets from an earlier batch, so a missing marker no longer runs the
   assertion at all. The env fallback exists because arbitrary shell exports are not inherited
   into the xcodebuild test-runner process, so the env var alone was not a reliable channel.

**No-scan semantics — preserved and strengthened.** `replace_source` returns `item_count: 0`
(:338) and performs no enumeration; the removed off-lock `enumerate` was the only metadata read at
selection time. Selection therefore provably never scans and never writes the index, matching the
owner rule that Settings selection/clear must not scan or load previews. Camera Roll activation
still owns the only scan (`scan_raw_dump_events`, generation-gated). No shipped island reads the
pick `itemCount` — the count surfaces come from scan `eventCount` — so hardcoding 0 at pick is not
a UI regression (verified: `native/islands/CameraRoll.tsx`, `EventSection.tsx`,
`desktop/islands/EventClusters.tsx` contain no non-test `itemCount` consumer; the type/parse in
`packages/core/event-clustering.ts:141,359` still defaults it to 0).

**Clear/change semantics — verified preserved through the refactor.** The single-guard critical
section that keeps declaration and watcher install atomic was already present before this delta
(the old body reused one `inner` binding); what changed is HOW it is kept atomic, so I confirmed the
refactor did not split the lock. Routing the declare through `declare_raw_dump_root(&mut inner, …)`
(:510) takes the already-held `&mut Inner` and does not re-acquire the mutex, and `install_watcher`
still uses the same binding — so clear/change remain unable to interleave between declaration and
watcher setup. `clear_raw_dump_root` (:575-580) and `replace_source`/`clear` mutate state under the
same single mutex, and `replace_source` bumps `generation` and clears `assets`/`watcher`/`index`
(:321-324). The stale-count window this delta actually closes was different: previously the pick body
computed `fs_scan::enumerate(&root).len()` OFF the lock and then overwrote `reply.item_count` with it
afterwards, so a clear landing between the enumerate and the lock left a reply whose count described
a folder that had just been forgotten. That off-lock enumerate is now removed, so `reply.item_count`
stays `0` (`replace_source` :338) and always matches the just-declared, not-yet-scanned source. The
stale-watcher hazard is guarded twice: the watcher callback re-checks `inner.generation == generation`
(:602) captured at install, and `clear`/`replace_source` drop `self.watcher` so `DumpWatcher::drop`
sets `cancelled` (:587-590).

**Deadlock reachability — none.** The mutex is `std::sync::Mutex` (`use std::sync::{mpsc, Arc,
Mutex, Weak}` :18), which is not reentrant, so I traced whether holding the guard across
`install_watcher` re-locks on the same thread. It does not: `install_watcher`/`start_watcher`
(:595-644) only build the notify watcher and `std::thread::spawn` a background pump; the closure
that calls `state.lock()` (:601) runs solely from that spawned thread (:636), never inline during
install. A watcher event fired while pick holds the lock simply blocks the background thread until
pick returns — contention, not deadlock, and the generation check makes any such late fire inert.

**iOS marker reachability — sound, one P3 nicety.** `simctl install` provisions the app container
with `Documents/` before `get_app_container` resolves it, so the write target exists; the marker is
written before the seeded test launches the app in the same booted state. If `Documents/` were ever
absent the `printf > path` would fail loudly under `set -euo pipefail` (a hard lane failure, not a
silent pass), and if the marker were missing the Swift reader falls back to `"event-demo-"` and the
`XCTAssertEqual(seeded.count, 7)` grouping assertion fails rather than passing falsely — no false
claims either way. P3 (non-blocking, mobile-lane owner's call): the runners could `mkdir -p
"$app_data/Documents"` to make the write independent of container-provisioning order.

**Verification of this delta (local, non-mobile):**
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets`: 48 pass / 0 fail,
  including `declaring_a_picked_folder_never_enumerates_it` and
  `clear_cannot_complete_before_an_asset_response_is_handed_off` re-confirmed passing.
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets`: no warnings (removing
  the enumerate introduced no unused-code/`dead_code` fallout).
- `bunx playwright test specs/desktop-events.playwright.ts`: 9 pass / 0 fail (6.2 s) — activation
  still scans exactly once, clear/unavailable/cloud-only/late-reply/Settings-retire unchanged.
- I did not run the iOS/Android lanes (running elsewhere per instruction); the marker change is
  reviewed for reachability and honesty only.

**Delta finding:** P0/P1/P2: none. One P3 (non-blocking): optional `mkdir -p` hardening of the
Documents path in the seeded runners. The atomic-lock change preserves the no-scan guarantee
(strengthens it: selection no longer enumerates) and closes the declaration↔watcher clear/change
interleaving, with no deadlock reachability.

## Decision

The Slice 6 hardening changes are consistent with the six review criteria and the AGENTS.md invariants I checked (1, 2, 7, 8, 9, 13). The two named tradeoffs are reachable but do not breach the event-media boundary and do not block the check-in. Local verification is clean: tsc clean, 2756 unit tests green, 48 Tauri shell tests green, event-clustering all-features green, macOS boundary + 50k performance gate ALL PASS, desktop-events Playwright 9/9 pass (fresh Vite, 9.6 s).

Verdict: APPROVED as a local checkpoint.
