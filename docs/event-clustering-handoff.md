# Handoff: Event Clustering on All Surfaces

Audience: the coding agent taking over this feature. Read this first, then `docs/PLAN-Event-Clustering-All-Surfaces.md` (the roadmap with locked decisions) and `docs/event-clustering-bridge-contract.md` (the normative 4-command contract).

## Slice 1 checkpoint (2026-11-23)

- Root-only gallery traversal is now consistent in Swift and TypeScript; the declared raw dump alone recurses. The operations document and bridge contract name the exception. Pickers, catalogue writes and drop commits reject simultaneous declarations of the same root, resolving symlink aliases before comparison.
- 37 synthetic golden timelines and an explicit test-target exporter bind the existing Swift implementation to the planned Rust port. Run `MANORAMA_EXPORT_EVENT_FIXTURES=1 scripts/test-event-clustering.sh` only when intentionally refreshing expectations; normal verification fails for missing or stale fixtures.
- `scripts/test-macos-boundary.sh` isolates its binary, module cache and fixtures. `verify.yml` adds the Swift/boundary job and checks tracked shell-script executable bits. The macOS build uses Vite's runner config loader so a worktree does not write config bundles through shared dependencies.
- Verified: 78 Swift tests, 145 macOS boundary checks, `bunx tsc --noEmit`, and the complete mirrored Bun suite (2,716 tests). A fresh, separately identified macOS build launched and rendered the signed-out opening screen; event operations are covered by the boundary suite, not claimed as a signed-in GUI run. The worktree-equivalent linked-dependency build preserved its own source/config/environment and left primary outputs unchanged.
- Slices 2–6 remain pending. The owner approved local checkpoint commits and the named slice branches, but no pushes, PRs, deployments or remote changes.

## Slice 3 checkpoint — verified Rust core

Worktree: `/Users/home/DEV/tools/manorama/.worktrees/event-clustering-rust-core`,
branch `feat/event-clustering-rust-core`, base `7f92538b`. Changes are deliberately
verified for the local checkpoint; no push or remote action. The full roadmap is retained in
`docs/PLAN-Event-Clustering-All-Surfaces.md`, with an appended slice-3 record that
supersedes its historical slice-1 status for this work only.

- Root Rust workspace contains only `crates/event-clustering`; `src-tauri` is
  excluded. Library `manorama_events` exports public source/calendar grouping,
  parser and schema-1 index APIs. All dates, including JNI JSON, are f64 epoch
  **seconds**; future shells must convert wire dates to milliseconds. Burst
  representatives alone populate multi-day `subDays`; main `itemIds` retain all
  frames. There is no Apple visual probe.
- `fs-scan`: pinned `cap-std` root/child directory capabilities, safe no-follow
  `cap-fs-ext` opens, bounded header-only `kamadak-exif`, file-date fallback and
  cache/modification comparison. Enumeration, metadata and headers never reopen
  ambient paths. Hidden/package/symlink exclusions remain; cloud reparse tags
  are not links. Windows offline/recall checks precede headers; placeholders get
  metadata-only rows without mod-time cache so hydration is reconsidered.
  The root-only gallery comparison uses a test equivalent, not Tauri integration.
  Unsupported or oversized headers fall back to file dates. Consumers own source
  exclusivity, safe grant access, private index writes and watchers; no `notify`
  dependency is introduced without a consumer.
- `android`: three JNI exports for
  `in.thecontrarian.manorama.events.RustBridge`; `cluster(itemsJson, configJson)`
  takes an array plus `{sourceId,calendar,config}`. Calendar matches the fixture
  schema. Both index functions accept full JSON strings. Errors throw structured
  JSON exceptions, never empty successes. Invalid/unknown index schemas request
  a rebuild. Kotlin, Gradle, NDK and Android project files are untouched.
- NFC character comparison (`unicode-normalization`, ASCII fast path) preserves
  opaque IDs/source hash bytes. Date conversion and interval/midpoint arithmetic
  match Foundation's 2001 reference epoch; config/fileModTime stay plain Doubles.
  Correctly rounded JSON Double decoding is enabled. The live unmodified Swift
  oracle matches 20 cases: `Date(-1e-8) = 0`, `Date(0.10000002) = 0.10000002384185791`.
- JNI limits: 16 Mi UTF-16 units checked by Java `String.length()` before copying,
  32 MiB UTF-8 before parsing, 16 KiB config, 4096-byte strings, 100k collections,
  aggregate index membership and 366 sub-days. Streaming preflight and bounded
  output serialization also protect public JSON helpers. 50k records pass.
- Six default / ten total direct dependencies; cap crates exist only in fs-scan,
  absent from Android's normal graph. No bitmap, ML, server I/O or network engine.
  Stripped aarch64 macOS JNI dylib: **1,891,328 bytes / 1.804 MiB**, +182,560 bytes
  versus the prior 1,708,768-byte build. NFC's controlled increment is 115,728 bytes
  (otherwise-identical temporary non-NFC build: 1,775,600 bytes; restored afterward).
  This still exceeds 1.5 MB; Android per-ABI size is **unmeasured**, not a passed gate.
- Actual macOS Rust tests: **56 default / 63 android / 68 fs-scan / 75 combined**, each
  consuming all **37 unchanged golden fixtures** plus inventory validation.
  All-feature/all-target Clippy with warnings denied and formatting passed.
  Real host JNI smoke test: **60 checks**, Java source compiled for 21 and run
  on host JDK 26 and the installed Android Studio Java 21 runtime; not an ART test. Unchanged Swift suite: **78**.
  TS typecheck and the full mirrored Bun suite (**2,716**) were rerun and passed.
- Prepared Linux CI in `verify.yml` runs the four cargo feature combinations
  against the root locked manifest, without credentials; not run remotely.
  Commands used `CARGO_TARGET_DIR=/tmp/manorama-events-rust-slice3-target`.
  Linux all-feature verification also passed: **74 tests** in the `rust:1`
  Docker image. The extra macOS test invokes the unchanged Swift oracle.
  Final recheck found an enumeration-to-offline transition that could cache
  fallback metadata with an unchanged modtime; locality refusals now clear that
  modtime and a hydration regression proves EXIF is retried.
  Windows runtime, Android ABIs, shell wiring, private storage, watchers,
  50k budgets and UI evidence remain for later slices. No GUI was run.

To repeat the JNI smoke test after the Android-feature release build, compile
`crates/event-clustering/tests/RustBridge.java` with `javac --release 21 -d
/tmp/manorama-events-rust-slice3-target/jni-host`, then run its fully qualified
class with the absolute built library path as its only argument. On JDK 24+ add
`--enable-native-access=ALL-UNNAMED`; on Linux the library is
`libmanorama_events.so`, on macOS it is `libmanorama_events.dylib`.

## Original state at handoff (2026-11-23)

- Branch `feat/event-clustering-camera-roll`, rebased onto `main` at `b4a91f29`, 11 commits ahead. Not pushed (AGENTS.md: no push; the human pushes).
- The branch was developed in a git worktree that has since been released. Check the branch out wherever you work: `git worktree add ../<dir> feat/event-clustering-camera-roll` (or `git switch feat/event-clustering-camera-roll` in a spare checkout).
- Commits, oldest first: engine (`f4fd7315`), original plan (`8eb4ab83`), macOS layer (`8020af9b`), iOS PhotoKit plugin (`e59da6e9`), shared desktop bundle UI (`04c502c3`), contract §6 + AGENTS.md (`ec543eb1`), untrack SwiftPM `.build` (`73609c97`), Vision-probe boundary checks (`bd7d3539`), contract §7 gap table (`b37b900f`), first plan draft (`92e54f52`), decisions-locked plan (`45566a4a`).
- Verified green before release (re-run after any change): 37 engine XCTests, 126 boundary checks, iOS-simulator typecheck of core + `PhotoKitDumpScanner`, `bunx tsc --noEmit`, 583 desktop/packages bun tests + 21 `EventClusters` island tests.

## What is done and working

- **macOS**: complete. `macos/ManoramaMac/{FolderDumpScanner,RawDumpEvents,NativeBridge}.swift`, UI in `desktop/islands/EventClusters.tsx` fed by `desktop/lib/event-clustering.ts`; wire types/validators in `packages/core/event-clustering.ts`.
- **iOS plugin**: `ios/App/App/EventClusteringPlugin.swift` (jsName `EventClustering`) + `PhotoKitDumpScanner.swift`; registered via `registerPluginInstance` in `SceneDelegate.viewDidLoad`. Dormant: no `native/` bundle code calls it yet.
- **Root-only exception, Rust core, Tauri, Android, mobile visibility**: planned, not started. Sections 1–5 and the six-slice branch plan are in `docs/PLAN-Event-Clustering-All-Surfaces.md`.

## Verification commands

- Engine tests: `scripts/test-event-clustering.sh`
- Boundary suite (126 checks), rebuild with:
  `xcrun swiftc -O macos/ManoramaMac/{LocalGallery,FolderStore,LocalSchemeHandler,Trace,OAuthLoopback,NativeBridge,InvokeReply,FolderDumpScanner,RawDumpEvents}.swift native/EventClustering/Sources/ManoramaEventClustering/*.swift macos/BoundaryTests/{BoundaryTests,main}.swift -framework AppKit -framework WebKit -framework Security -framework Vision -framework CoreServices -o /tmp/boundaryN`
- TS: `bunx tsc --noEmit` and `bun test` in `desktop/`, `packages/`, `native/`.
- iOS build: `xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/mano-dd -clonedSourcePackagesDirPath /tmp/mano-spm build` — never pass `DEVELOPMENT_TEAM`; team `373K7W3LKU` is set in the pbxproj.
- Android (later): set `JAVA_HOME` to JDK 21 (D3). Homebrew OpenJDK 26 on PATH is not AGP-compatible.

## Invariants and contract facts (do not break)

- Wire dates are epoch **milliseconds**; `events-index.json` stores **seconds**. Ids are `evt_` + first 20 hex chars of sha256(`sourceId|startSeconds`).
- 100% on-device: nothing (EXIF, GPS, thumbnails, paths) leaves the device. iCloud opt-in downloads (D2) are performed by iOS from the user's own account, never via a Manorama server.
- No semantic labels, no ML frameworks, no full-bitmap decode during indexing, one raw-dump source per device.
- Pass order: hygiene → home base → sessionize → trip merge; `VisualBoundaryProbe` optional.
- Private files: 0600 / complete file protection. iOS: declaration in UserDefaults key `manorama.cameraRollDumpEnabled`; index at `Application Support/events-index.json`.
- Raw dump recurses; gallery roots do not (exception documented in the plan, §3; test pending in slice 1).

## Environment gotchas (learned the hard way)

- `scripts/build-macos.sh` fails inside a worktree: `node_modules` is a symlink into the main checkout and vite hits EPERM. Fix is scheduled in slice 1; workaround is building from the main checkout.
- A reentrant `queue.sync` in `RawDumpWatcher.noteActivity()` once crashed SIGTRAP — do not reintroduce sync-on-own-queue.
- The iOS plugin must stay registered in `SceneDelegate`; a typecheck will not catch the unregistered-plugin class of bug. Run the app on a simulator with seeded media (`xcrun simctl addmedia`, `xcrun simctl privacy <udid> grant photos <bundleid>`) before declaring any iOS slice done.
- Xcode writes (DerivedData, SourcePackages) may need `/tmp` redirection if your sandbox restricts `~/Library/Developer`.
- `native/EventClustering/.build/` and `.swiftpm/` are gitignored; keep build artifacts out of commits. Check exec bits on `scripts/*.sh` before committing.
- Never weaken or skip tests; one issue/branch/PR per slice; commit style `type(scope): imperative summary` with a why-body and no agent attribution.

## Locked decisions

- **D1**: Single Rust core (`crates/event-clustering`) shared by Tauri and Android. Mobile stays on **Capacitor**: event cards live in the shared `native/dist` web UI; Kotlin is limited to native platform bridges (permissions, MediaStore, ContentObserver, thumbnails, JNI). No Tauri Mobile migration, no Compose screens.
- **D2**: iCloud-only photos: placeholder first, explicit opt-in download with progress/cancel; thumbnails and indexing never download.
- **D3**: Java 21 for Android builds.
- **D4**: Six slices per the plan; slice 1 continues on this branch (root-only exception doc+test, golden fixture export, CI jobs, `build-macos.sh` fix), then slices 2 and 3 may run in parallel.
