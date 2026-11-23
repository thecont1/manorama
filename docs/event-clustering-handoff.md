# Handoff: Event Clustering on All Surfaces

Audience: the coding agent taking over this feature. Read this first, then `docs/PLAN-Event-Clustering-All-Surfaces.md` (the roadmap with locked decisions) and `docs/event-clustering-bridge-contract.md` (the normative 4-command contract).

## State at handoff (2026-11-23)

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
- iOS build: `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' -derivedDataPath /tmp/mano-dd -clonedSourcePackagesDirPath /tmp/mano-spm build` — never pass `DEVELOPMENT_TEAM`; team `373K7W3LKU` is set in the pbxproj.
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
