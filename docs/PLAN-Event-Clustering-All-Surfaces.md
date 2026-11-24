# Plan: Event Clustering on All Surfaces

Status: **slices 1–6 verified locally; owner/device release gates remain** · Branch: `chore/event-clustering-hardening` · Normative contract: `docs/event-clustering-bridge-contract.md`

This plan takes camera-roll event clustering from "macOS complete, iOS plugin dormant" to every Manorama surface: iPhone, iPad, Windows, Linux and Android. The standing non-negotiables of `PLAN-Event-Clustering-Camera-Roll.md` apply throughout: 100% on-device (no EXIF, GPS, thumbnails or paths leave the device), no ML frameworks or bundle bloat, no semantic labels, one raw-dump source per device, no full-bitmap decode during indexing, safe handling of cloud placeholders, private files written 0600 / complete file protection, and `--config`/`--store` isolation.

The original slice briefs below are retained as design history. The owner's later Library direction controls presentation: Settings owns one folder action, a Camera Roll pill replaces only the gallery-list rail, and the ordinary Library never scans or shows event contents. The slice checkpoints record what actually shipped.

## Locked decisions

| # | Decision | Consequence in this plan |
|---|---|---|
| D1 | One Rust core shared by Tauri and Android; Capacitor stays on mobile with a Kotlin plugin as the Android bridge | New crate `crates/event-clustering`; Android calls it through JNI from Kotlin. Swift core remains for Apple surfaces. Golden fixtures bind Swift and Rust. |
| D2 | iCloud-only photos: placeholder first, then opt-in download | Fifth method gains an explicit `allowNetwork` path, off by default (section 2). |
| D3 | Java 21 for Android builds | Temurin 21 installed via Homebrew; `JAVA_HOME` pinned in scripts and CI. |
| D4 | Branch slicing delegated | Six slices, below. |

**D1 confirmed.** Mobile stays on Capacitor. Event cards render in the shared `native/dist` web UI on both iOS and Android. On Android, a custom Capacitor plugin written in Kotlin bridges permissions (including the partial-access picker), MediaStore access, `ContentObserver`, thumbnails and the JNI calls into the Rust engine; it holds no clustering logic and no Compose screens. A Tauri Mobile migration is out of scope.

## 0. Where we stand

| Surface | Engine | Shell commands | Pixels for an event | UI visible | Tests |
|---|---|---|---|---|---|
| macOS | Swift core | Done | Done (opaque verified leases) | Done | Slice 1 engine, boundary and Bun suites |
| iOS / iPadOS | Swift core | Done, registered | Done (native leases) | Done | Slice 2 unit, boundary and simulator checks |
| Windows / Linux (Tauri) | Rust core | Done (6 commands) | Done (opaque leases) | Done | Slice 4 Rust, Tauri and Linux Docker checks; Windows CI prepared |
| Android | Rust core via JNI | Done (11 commands) | Done (local and explicit cloud reveal) | Done | 5 JVM + 11 instrumentation + 63 Rust + Bun; API 36 emulator verified |

## 1. Make the feature visible on iPhone and iPad

The native side already answers the four contract commands; the `native/` bundle side is missing.

- **Bridge wrapper.** `native/lib/event-clustering.ts`, modelled on `native/lib/local-gallery.ts`: `registerPlugin('EventClustering')` exposing `pickRawDumpRoot`, `getRawDumpStatus`, `scanRawDumpEvents`, `clearRawDumpRoot`, `getEventAssetImage`, `cancelEventAssetImage`, `releaseEventAssetImages`, `setEventCloudDownload`, `presentLimitedLibraryPicker`, `openEventPhotosSettings` and `openEventAssetInPhotos`. Every reply goes through the validators in `packages/core/event-clustering.ts`. `isEventClusteringAvailable()` is a capability probe (`getRawDumpStatus` resolves), not a platform check, so Android lights up without bundle changes.
- **Shared presentation.** Lift span formatting and sub-day grouping out of `desktop/islands/EventClusters.tsx` into `packages/core`, with one test file used by both bundles.
- **Settings row.** In `native/islands/Settings.tsx`: declare, change or clear the source; show authorisation state, event count and last indexed time. Cloud download preference remains native-protected and defaults off; the Viewer carries the explicit one-photo download action rather than adding a Settings toggle.
- **Event section.** New `native/islands/EventSection.tsx` imported by `GalleryList.tsx` (2,895 lines; nothing added inline).
- **iPad.** Multi-column grid at regular width, Split View and Stage Manager resizing, pointer hover, keyboard focus order.
- **Photos access.** Handle `.notDetermined`, `.denied` (link to Settings) and `.limited` ("Showing N selected photos", `presentLimitedLibraryPicker`, rescan on `PHPhotoLibraryChangeObserver`). Review the `NSPhotoLibraryUsageDescription` wording against the on-device promise.

**Acceptance.** On the iPhone 17 Pro Max and iPad Pro 13 (M5) simulators with seeded media: declaring shows events; clearing removes them and deletes `Application Support/EventClustering/events-index.json` and the thumbnail cache; limited access shows only selected frames; the event flow performs no provider or media-network request for indexing, thumbnails or the default viewer. Existing app API/account traffic is outside that event-media assertion.

## 2. Spec: the fifth method, a photograph from an event

PhotoKit assets have no file URL, so `convertFileSrc` cannot reach them today. The contract (new §3 method, §7 table) is updated before code.

**Signature.** `getEventAssetImage({ ids, purpose: 'thumbnail' | 'viewer', maxPixelSize?, allowNetwork?: boolean })` → `{ items: [{ id, url | null, width, height, state }] }` with `state` one of `ready`, `cloudOnly`, `downloading`, `failed`, `missing`. Batch cap 64. Ids are opaque per-source ids from `scanRawDumpEvents`: PHAsset `localIdentifier` on iOS, MediaStore id on Android, relative path on desktop.

**Thumbnails.** `PHCachingImageManager.requestImage` with `.opportunistic`, `resizeMode .fast`, target `min(maxPixelSize, 512) × scale`, never above the asset size (no upscale, invariant 13). Encoded once as JPEG into `Caches/event-thumbs/<sha256(id|modDate|size)>.jpg` with complete file protection, LRU eviction at 200 MB, purged by `clearRawDumpRoot`.

**Viewer.** No re-encode of originals (invariant 2): `PHAssetResourceManager.writeData` of the original resource into a private temp file served via `convertFileSrc`, removed when the viewer closes and swept on launch.

**iCloud-only photos (D2).**
1. Default: `allowNetwork` is false everywhere and the reply is `cloudOnly`. The UI shows a placeholder card ("In iCloud") and an "Open in Photos" action.
2. Opt-in: the persisted native preference defaults to false. A one-off "Download this photo" action on the placeholder is always available and enables network access only for that viewer request; there is no Settings toggle.
3. When allowed, the request sets `isNetworkAccessAllowed = true` for that asset only and reports progress through a `eventAssetProgress` plugin event (`{ id, fraction }`); the card shows progress and supports cancel (`PHImageManager.cancelImageRequest`).
4. Downloads are performed by the OS from the user's own iCloud account into the device's Photos library. Manorama sends nothing anywhere; the on-device invariant holds. The copy says this plainly.
5. Thumbnails never trigger downloads, even with the toggle on: only an explicit open does. Indexing never downloads.
6. Respect Low Data Mode and cellular: when `ProcessInfo`/`NWPathMonitor` reports a constrained or expensive path, ask before each download.
7. Android equivalent: a MediaStore row without a verified readable local `_data` file returns `cloudOnly`; thumbnails never invoke a provider. Only an explicit single-item viewer request with `downloadCloudOnOpen` enabled may stream through `ContentResolver`, after native metered-data/power confirmation when required. The original is copied byte-for-byte into a private lease. Desktop equivalent: cloud placeholders (OneDrive, iCloud Drive, Dropbox) stay `cloudOnly` with an "Open in Finder/Explorer" action; no opt-in download in this plan.

**Tests.** Simulator XCTest with `simctl addmedia` fixtures: size bound and no upscale; cache key changes with the asset; eviction bound; clear purges cache; unknown id is `missing`; `allowNetwork: false` never sets network access (asserted through an injected image-manager protocol, since simulators cannot fake iCloud-only assets); cancel stops progress events. Bun tests for the wrapper covering every state and the progress event.

## 3. Root-only scanning: a documented exception

`b4a91f29` made Cloud and Local gallery ingestion scan folder roots only. The camera-roll dump is a different concept: one user-declared source that is meant to be recursed and re-presented as events.

- `docs/manorama-operations.md` line 35: "Exception: the user-declared camera-roll dump (event clustering) is indexed recursively, because it is a single dump rather than a curated gallery. It never becomes a gallery source and its subfolders are never published."
- Contract: the same rule as an invariant, and a folder cannot be both a gallery root and the dump. Declaring one when the other exists is rejected with a clear error.
- Tests: a boundary test running `LocalGallery` and `FolderDumpScanner` over the same nested tree, asserting root-only for the first and recursion for the second. The Rust crate and the Tauri shell get the same test.

## 4. Rust core and Tauri for Windows and Linux

**Crate `crates/event-clustering`.** A workspace member with no Tauri or Android dependency. It ports `Models`, `EventClusterer`, `EventIndex`, `DumpMetadataParser`, `GeoMath` and `SHA256Digest` from Swift, keeping the same pass order: hygiene, home base, sessionize, trip merge. The `VisualBoundaryProbe` is not ported because it relies on Apple's Vision framework, and the probe is optional by design.

The crate has two layers:
- A pure `cluster(items, config) -> Vec<Event>` and an index codec. These are shared by both consumers.
- A filesystem scanner (`walkdir` + EXIF header read), compiled only under the `fs-scan` feature. Android does not use it, because MediaStore supplies its metadata.

**Dependencies, justified per AGENTS.md:**
- `sha2`: event ids must match Swift byte for byte.
- `kamadak-exif`: pure Rust and reads headers only, with no decode.
- `walkdir`: recursive walk of the dump folder.
- `notify`: change watching, matching `RawDumpWatcher`.
- `jni`: only behind the `android` feature.

No image crates are needed, and `serde`/`serde_json` are already in the tree.

**Tauri shell — slice 4 Rust implementation.** `src-tauri/src/event_clustering.rs` registers the four dump commands plus `get_event_asset_image` and `reveal_event_asset` in `generate_handler!`, using the verified `manorama_events` path dependency with `fs-scan`. The shell resolves the actual OS IANA timezone (including historical DST). Index dates remain seconds; bridge event/sub-day/status dates are milliseconds. The picker/drop provenance file is not a catalogue declaration: picker, gallery drop batches and catalogue writes reject the active dump's canonical root, including aliases, before durable gallery commits.

Rust-only `raw-dump.json` retains an install-private UUID and an optional source declaration; `events-index.json` is source-fingerprint/schema/config checked. `--config <absolute directory>` isolates app-private files, declaration and index; `--store <absolute directory>` separately isolates `roots.json`. Both defaults remain the old app config directory. Clearing preserves the UUID and grants, removes the source and index, and stops its watcher. Mutex/generation/scan-sequence gates prevent late scans from rewriting cleared or changed-source caches. Scans run on blocking workers; status reads only root availability and the memoized summary. The `notify` watcher emits debounced `manorama://raw-dump-changed` with `{}`, never paths, GPS or dates.

Writes are atomic 0600 on Unix; Windows parents receive a protected current-user-only DACL before temporary file creation, and replacement uses `MoveFileExW`. Native declaration/index/provenance names remain outside the renderer allowlist. Existing filesystem capabilities stay read-only and unchanged. The asset command accepts at most 64 source-relative ids plus `purpose: 'thumbnail' | 'viewer'`, optional `maxPixelSize`, and `allowNetwork: false`. Handle-relative no-follow reads and bounded JPEG/PNG/WebP/HEIF/AVIF headers yield orientation-aware dimensions. Local originals are returned only as opaque `manorama-event` leases backed by a pinned directory handle and expected device/inode identity; the asynchronous protocol reopens the leaf without following links and serves unchanged bytes with GET/HEAD/range support. Cloud placeholders remain indexed as metadata-only rows, but the asset reply is `cloudOnly` with a null URL; missing/failed assets also have null URLs. No bitmap/ML decoder, re-encoding or download is introduced. Reveal consumes a verified member and revalidates immediately before the public OS pathname handoff. Renderer work and GUI evidence are tracked independently.

**Bundle.** `desktop/lib/event-clustering.ts` owns the validated Tauri `invoke` transport. `desktop/islands/EventClusters.tsx` provides the pill, one Settings folder action and event cards; `EventViewer.tsx` opens members asynchronously through the shared Viewer. `Catalogue.tsx` mounts the controller only in Camera Roll mode and swaps only the right-hand gallery list. No renderer path is joined into a media URL.

**Verification.**
- `cargo test -p event-clustering` against the golden fixtures.
- `CARGO_TARGET_DIR=/tmp/manorama-events-tauri-target cargo test --locked --manifest-path src-tauri/Cargo.toml --all-targets` (45 shell tests passed) and all-target Clippy with warnings denied.
- `bunx tsc --noEmit` and `bun run test:unit` (2,715 tests passed).
- `scripts/test-macos-boundary.sh` compiles both tracked Swift suites in isolated scratch binaries: 262 PASS / 0 FAIL. The event-asset suite is included, and a real headless `WKWebView` using the production configuration served an unchanged original through `manorama-event`.
- A fresh signed, unsandboxed evidence-only macOS bundle ran the synthetic 3/2/2 Camera Roll flow without foreground stealing. Full-pixel 3456×2168 frames cover the event rail, Viewer, picker and Library Settings folder controls. Production entitlements were unchanged; a complete packaged sandboxed six-state matrix remains a release gate.
- `cargo check -p event-clustering --features fs-scan --target x86_64-pc-windows-msvc --lib --tests` and the equivalent `x86_64-unknown-linux-gnu` check pass. Full Tauri cross-checks stopped in host dependencies: this Mac lacks MSVC C headers/linker and a configured Linux pkg-config sysroot. Linux Docker and Windows CI paths are prepared, not run.
- Independent round-3 reviewer `qfmodel` returned **“Verdict: APPROVED as a local checkpoint.”** with 0 P0/P1/P2 findings and three non-blocking P3 observations: large-response handoff latency, gallery-confined Tauri drag-drop scope, and inert filesystem-scope drift from pre-release Slice 4 developer declarations. P1 persists the originally selected root's device/inode identity, rejects whole-root replacement, removes pathname-based event asset scope, delivers opaque descriptor-backed leases and revalidates reveal at the OS handoff. The documented Rust FIFO-256/no-TTL versus Swift capacity-128/30-minute-TTL registry difference is non-blocking.
- The broad Playwright run finished **61 failed / 386 passed / 8 skipped**. The clean-base comparison reproduced 60 exact failures; the one Slice-4-only observation and two base-only observations passed an isolated warm base rerun. No Slice 4-specific regression is demonstrated, but the matrix is not green. Packaged Windows/Linux behavior and complete native release evidence remain separate gates.

## 5. Android in sync (Rust core via JNI, thin Kotlin layer)

Android now has `MainActivity.java` plus the Kotlin bridge under `android/app/src/main/java/in/thecontrarian/manorama/events/`; this was the largest slice.

**Native library.** `crates/event-clustering` is built with `cargo-ndk` for `arm64-v8a` and `x86_64`. The output `libmanorama_events.so` goes into `android/app/src/main/jniLibs/`. Gradle runs the Rust build through `preBuild`, and CI caches the target directory. `armeabi-v7a` is added only if Play device stats require it.

The JNI surface is deliberately narrow: `cluster(itemsJson: String, configJson: String): String` and `decodeIndex` / `encodeIndex`. JSON is the boundary, so the Kotlin side stays thin and the wire matches the contract. Android uses bionic `localtime_r` and the device timezone database rather than embedding `chrono-tz` in each ABI. Fixed GMT offsets are applied directly; IANA wall times choose the earliest occurrence during an overlap and move forward by the gap during a DST transition.

The packaged debug APK contains 785,592-byte (`arm64-v8a`) and 863,672-byte (`x86_64`) libraries, both below the 1.5 MiB per-ABI budget. Both ABIs export all three JNI symbols.

**Kotlin layer.**
- `EventClusteringPlugin.kt` (`@CapacitorPlugin(name = "EventClustering")`), registered in `MainActivity`, implements the 11 commands listed in section 1. A state worker owns source declarations, MediaStore, status and index work; a separate asset worker owns image requests and cloud confirmation so a dialog cannot block a scan or clear operation.
- `MediaStoreSource.kt` queries `MediaStore.Images` for `DATE_TAKEN`, dimensions, bucket, pending/trashed state and file metadata. It never decodes bitmaps. The source is either all photos or one MediaStore bucket, chosen in a native folder picker; there is one source per device. API 36 rejects aggregate `COUNT(_id)` projections, so bucket/library counts query ordinary `_ID` rows and count the cursor in Kotlin.
- GPS comes from MediaStore latitude/longitude columns first, then `ExifInterface` only on a verified local file. Denied location permission opens no EXIF/provider stream and forces a fresh time-only index; regranting location rereads metadata.
- `RustBridge.kt`: `System.loadLibrary` plus the external functions above.
- `MediaObserver.kt`: a `ContentObserver` with debounce, replacing `RawDumpWatcher`.
- `EventSourceState.kt`, `EventPrivateFiles.kt`: state and index live under `filesDir/EventClustering/`, with atomic private writes. Backup and device-to-device transfer exclude that directory.
- `EventAssetService.kt`: thumbnails decode verified local files with `BitmapFactory`, apply EXIF orientation and bounded downsampling, and never upscale. They are cached under `cacheDir/event-thumbs` with a 200 MiB LRU. `ContentResolver.loadThumbnail` is deliberately not used because a local `_data` path does not prove provider-side thumbnail loading cannot delegate to the network. Viewer originals are copied byte-for-byte into read-only private leases under `cacheDir/event-originals/` and released by the shared viewer window.

**Permissions and manifest.**
- `READ_MEDIA_IMAGES` (API 33+).
- `READ_MEDIA_VISUAL_USER_SELECTED` (API 34+): partial access maps to `authorization: "limited"`; the event rail reports the selected-photo count and offers the system picker again.
- `READ_EXTERNAL_STORAGE` with `maxSdkVersion="32"`.
- `ACCESS_MEDIA_LOCATION`. Denial permits time-only clustering and skips trip merge; permission changes clear issued assets and invalidate cached coordinates.
- minSdk stays at 24; `targetSdk 36` behaviour is verified on the API 36 emulator.

**Bundle.** No changes beyond section 1, because the capability probe lights it up. The Camera Roll pill performs only that cheap probe; the event controller mounts only while Camera Roll mode is active. Settings selection writes declaration/count metadata only and does not scan or load previews.

**Verification.**
- `./gradlew :app:testDebugUnitTest`: 5 JVM tests, with Rust loaded on the host through a desktop build of the crate.
- `./gradlew :app:connectedDebugAndroidTest` on `manorama_api36`: 11 instrumentation tests passed, including bucket scoping, API 36-safe counts, no-upscale thumbnails, byte-for-byte viewer leases, cloud-only/missing behaviour, unknown location state, deterministic clear/cancel races, failure settlement, vanished buckets, GMT offsets and a 50,000-item JNI run in 0.264 seconds off the main thread. Superseded requests cannot delete a newer request's partial files or leave a stale viewer lease issued.
- The Android-target Rust calendar test also passed on the emulator for fixed GMT offsets, DST gaps and earliest ambiguous occurrences. The host feature-gated Android suite does not compile those target-specific branches.
- `cargo test --locked -p event-clustering --features android`: 63 passed.
- Full-app synthetic emulator flow: limited access scanned only selected fixtures; full access scanned all rows; denied photo access reported unavailable; location revocation produced zero cached coordinates and regrant restored fixture coordinates. A fresh post-review run declared All photos without scanning, then Camera Roll grouped six synthetic rows as 2/2/1/1 events, loaded four native covers at 80×40 intrinsic pixels without upscaling, opened a byte-identical viewer lease, returned to the active event rail and left the ordinary Library unchanged.
- A physical Pixel partial-access check remains an owner/device gate; no physical-device result is claimed.

## 6. Run every suite on simulators and emulators

| Suite | Command | Notes |
|---|---|---|
| Swift engine | `scripts/test-event-clustering.sh` | 78 tests, including 37 golden timelines |
| macOS boundary | `scripts/test-macos-boundary.sh` | both scratch-isolated Swift suites, including event asset tests |
| Bun / TS | `bunx tsc --noEmit && bun run test:unit` | desktop, packages, native; the mirror avoids nested worktree `node_modules` |
| iOS | `xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.1' -derivedDataPath /tmp/mano-dd -clonedSourcePackagesDirPath /tmp/mano-spm test` | Repeat for iPad Pro 13-inch (M5), iPhone 17e, iPad mini (A17 Pro). Seed media with `xcrun simctl addmedia`, grant with `xcrun simctl privacy <udid> grant photos <bundle id>`. Never pass `DEVELOPMENT_TEAM`. |
| Rust | `cargo test --workspace`; Docker for Linux | Windows in CI |
| Android unit | `JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" ./gradlew :app:testDebugUnitTest` in `android/` | Install `openjdk@21` first (D3) |
| Android device | `emulator -avd manorama_api36 -no-window &` then `./gradlew :app:connectedDebugAndroidTest` | needs `cargo-ndk` and the NDK; app-scoped avoids unrelated library instrumentation tasks |
| Playwright | existing e2e config | desktop bundle with event fixtures |

`scripts/test-all-surfaces.sh` runs them in order and prints a summary. Each step either passes, fails or reports `SKIPPED: <reason>`; none passes silently.

Known environment needs:
- DerivedData and SwiftPM caches redirected to `/tmp`.
- Escalation for `swiftc` with macros, git writes, Homebrew installs (`openjdk@21`, `cargo-ndk`), Android NDK installation through `sdkmanager`, and emulator launch.

## 7. Other learnings folded in

1. **Golden fixtures.** 37 synthetic timelines are exported to `fixtures/event-clustering/*.json` (inputs in epoch seconds, Gregorian calendar/timezone, configuration, expected ids, spans, covers and sub-days). They include the four original scenarios plus thresholds, ties, bursts, time-only grouping, DST, negative epochs and index schema-version cases. Swift verifies the same files Rust will consume; any missing or stale fixture fails verification. Export explicitly with `MANORAMA_EXPORT_EVENT_FIXTURES=1 scripts/test-event-clustering.sh`; normal tests never regenerate expectations.
2. **CI.**
   - `verify.yml`: Swift engine and boundary suite on a macOS runner; `cargo test` on Linux.
   - `ios.yml`: simulator tests.
   - New `android-verify.yml`: Java 21, NDK, `cargo-ndk`, app-scoped JVM tests, debug packaging, per-ABI size limits and all three JNI exports.
   - `desktop-windows.yml`: crate tests.
3. **Contract §6.** Replace "one page drives both" with: two bundles (`desktop/`, `native/`) share `packages/core`; each surface names its bundle and transport.
4. **Privacy declarations.**
   - iOS `PrivacyInfo.xcprivacy`: photo library use, required-reason APIs and no tracking.
   - Play data-safety form: photos are accessed but not collected or shared.
   - Store copy explaining iCloud downloads as OS-performed.
5. **Hygiene.** `scripts/build-macos.sh` uses Vite's runner config loader and supports isolated `MANORAMA_MACOS_BUILD_DIR` output from linked worktrees. CI checks tracked shell-script executable bits. Keep `.build`, `.swiftpm` and Rust `target/` ignored.
6. **Real runs, not summaries.** Every slice closes with a run of the actual app on its surface, with screenshots. Typechecks missed the unregistered iOS plugin and the reentrant `queue.sync` crash.
7. **Performance budget.** A 50,000-item synthetic dump:
   - Mac: index under 10 s, peak memory under 300 MB, incremental rescan under 1 s.
   - Android emulator: index under 20 s, and the JNI call is not on the main thread.
8. **Localisation and accessibility.** Date spans via `Intl.DateTimeFormat` with the device locale and calendar. VoiceOver and TalkBack labels such as "12 to 15 March, 214 photos". Dynamic Type and font scaling.
9. **Schema versioning.** An `events-index.json` with an unknown `schemaVersion` is discarded and rebuilt, never migrated in place. Swift and Rust share the version constant through the fixtures.
10. **Id stability.** Ids derive from `startSeconds`, so adding an earlier frame changes the id. This is documented, and UI state is keyed defensively.

## Branch slicing (D4, decided)

There are six slices, one issue, branch and PR each, per AGENTS.md. The Rust core stays separate from Tauri because two shells consume it, and reviewing the port on its own keeps the parity diff readable. Hardening ships inside each slice (tests, CI, privacy text for that surface) rather than as a trailing catch-all. Only cross-cutting items wait for slice 6.

| # | Branch | Contents | Depends on |
|---|---|---|---|
| 1 | `feat/event-clustering-camera-roll` (existing) | Engine, macOS, dormant iOS plugin, contract; plus section 3 docs and test, golden-fixture export, Swift and boundary CI jobs, the `build-macos.sh` worktree fix | none |
| 2 | `feat/event-clustering-ios-visible` | Section 1, section 2 (including the iCloud opt-in), shared presentation lift, iOS privacy manifest, simulator CI | 1 |
| 3 | `feat/event-clustering-rust-core` | Crate with parity tests, `fs-scan` and `android` features, Linux CI | 1 |
| 4 | `feat/event-clustering-tauri` | Section 4 shell, bundle transport, Windows CI | 3 |
| 5 | `feat/event-clustering-android` | Section 5, Java 21, NDK and Android CI, Play data safety | 2 (bundle probe), 3 |
| 6 | `chore/event-clustering-hardening` | `test-all-surfaces.sh`, 50k performance budgets, localisation and accessibility sweep across surfaces | 2, 4, 5 |

Slices 2 and 3 run in parallel after 1; 4 and 5 run in parallel after 3.

## Risks

- **Large originals:** the temp-file viewer can be slow for large ProRAW/HEIC originals. The fallback is a scheme handler, which requires subclassing the Capacitor bridge.
- **iCloud tests:** the iCloud-only state cannot be produced on a simulator. It is covered by an injected image-manager protocol and a manual check on a real device before release.
- **JNI on Android:** JNI adds NDK, ABI and `.so` size concerns. Slice 5 enforces the 1.5 MiB per-ABI budget in `android-verify.yml`; both packaged libraries and all three exports were verified locally.
- **Android location access:** denial of `ACCESS_MEDIA_LOCATION` weakens trip merge. Time-only clustering is tested explicitly.
- **Windows cloud placeholders:** detection varies by cloud provider, so it is unit-tested with synthetic attributes.
- **Version churn:** AGP, Java 21 and Capacitor versions drift over time, so `JAVA_HOME` and the NDK version are pinned in `android/gradle.properties` and CI.

## Slice 2 checkpoint — iOS Camera Roll mode (verified locally)

Completed in `feat/event-clustering-ios-visible` at `889dfd66`, based on the
Apple/macOS slice. The ordinary Library stays gallery-only. Settings owns one
Camera Roll folder action; the capability-gated pill activates a conditional
event rail; multi-day entry and event cards open the existing shared Viewer and
return to the same rail.

The native boundary gained limited-library controls, protected source/index
preferences, encrypted on-device thumbnails and original-file streaming with
real cancellation, current ±1 original retention, launch sweeping and
source-revision invalidation. Originals are never re-encoded, thumbnails never
upscale, and cloud downloads remain explicit.

Verification: clean typecheck; **2,749 mirrored Bun tests passed**; **27 iOS
simulator XCTest checks passed**; native production Vite build passed;
`git diff --check` passed. A seeded iPhone 17 Pro Max run grouped seven
synthetic PhotoKit images into **3 / 2 / 2** events, decoded the seeded cover at
**512×341**, proved `libraryPolluted: false`, `settingsClean: true` and
`railReplaced: true`, and recorded an empty implicit-download path. Independent
review round 2 returned `APPROVED`. Evidence lives in that worktree's
`outputs/slice2-demo-report.json`, `outputs/slice2-camera-roll.png` and
`outputs/slice2-review-verdict.md`. No push, PR, deployment or remote migration
was performed.

## Slice 3 checkpoint — Rust core (verified locally and on Linux)

This section records slice 3 against `7f92538b` in the
`feat/event-clustering-rust-core` worktree. The preceding roadmap is retained in
full; its slice-1 status is historical, not a claim that the Rust work below is
still unstarted. No shell, Swift, TypeScript UI, mobile project or golden expectation
was changed. No commit, push, GUI launch or remote action was performed.

### Delivered boundary

- Root `Cargo.toml` / `Cargo.lock`: workspace member `crates/event-clustering`,
  explicitly excluding `src-tauri`. Package `event-clustering` produces
  `manorama_events` as `rlib` and `cdylib`. Root `target/` is ignored.
- Public `MediaMetadataItem`, nine-field `ClusteringConfig`, `EventCluster`,
  `EventDayGroup`, `EventClusteringResult`, `RawDumpStatus` and `RawDumpScanReport`.
  All serialized fields use Swift's camelCase spelling. Every timestamp is **f64
  epoch seconds**, including the JNI JSON; shell adapters must convert to the
  contract's epoch milliseconds before replying to a WebView.
- `cluster(items, source_id, config, calendar)` and `EventClusterer` return
  `Result`, with public `inferred_home_base` and `event_id`. `CalendarSpec` matches
  the fixtures: Gregorian plus exactly one of `secondsFromGMT` or
  `timeZoneIdentifier`. UTC is the deterministic Rust default, never a host clock
  or inferred locale; consumers should inject the chosen source calendar.
- Swift's current rules are preserved: screenshots excluded before inference;
  both coordinate components must exceed 0.0001 in absolute value; grid half ties
  round away from zero; home ranks distinct days, frames, earliest appearance,
  latitude, longitude; burst chains preserve all main `itemIds`; even bursts use
  `count / 2`; covers keep the first minimum on a midpoint tie; multi-day requires
  multiple grouped sessions **and** representative dates. `subDays` contains
  **representatives only**, not every burst member. No Apple visual probe is added.
- `EventIndex::{encode, decode, reusable, matches, needs_metadata_read, pruning,
  applying}` and `SCHEMA_VERSION = 1`. Index encoding sorts keys; modification
  deltas use the absolute one-second boundary. Pruning leaves events untouched
  until reclustering. `decode` rejects invalid/unknown schemas and `reusable`
  returns `None`: the consumer rebuilds instead of migrating the cache.
- Pure `parser` functions accept EXIF/TIFF/GPS dictionaries, including signed
  offsets, ISO-ish timestamps, DMS coordinates and the Swift screenshot rule.
  Fractional EXIF seconds are truncated as in Swift. Foundation's spring-gap
  normalization and first fall-overlap occurrence were checked with a CLI probe
  and covered by Rust parser tests.

### Optional consumers and dependency cost

`fs-scan` alone adds `cap-std` / `cap-fs-ext` 4.0.3 and `kamadak-exif` 0.6.2;
`walkdir` was removed. `enumerate`, `ingest`, `scan` and injectable
`ingest_with_header` recurse only the declared dump, using pinned root/child Dir
capabilities for enumeration, metadata and no-follow headers. Hidden entries,
packages and name-surrogate links (including Windows junctions) are excluded,
not ordinary/cloud reparse points. IDs remain source-relative. Windows `OFFLINE` / `RECALL_ON_DATA_ACCESS` gates
run **before** the header callback; Unix zero-allocation stubs receive the same
fallback treatment. Placeholder items retain file dates but no cached mod time,
so hydration requests a fresh header. Local timestamps fall back from EXIF to
creation then modification date; corrupt/unsupported headers never invent now.
EXIF access is capped to a 4 MiB metadata read window, with no bitmap decoder.
Headers beyond the window and formats unsupported by the EXIF library fall back
to file dates. An unchanged rescan reads zero headers. The root-only-gallery
comparison is an equivalent test enumerator, not a claim to test the unmodified
Tauri gallery shell. Deterministic ancestor replacements before/during traversal
and after enumeration cannot expose foreign names, metadata or headers; there is
no ambient-open fallback. The caller must supply a fingerprint-checked cache;
storage permissions, persistence, the selected-root grant and debounced watching remain
shell responsibilities. `notify` is deliberately not added before a consumer
needs it.

`android` alone adds `jni` 0.21.1 (no JVM invocation feature). Exports are
`Java_in_thecontrarian_manorama_events_RustBridge_{cluster,decodeIndex,encodeIndex}`.
The three methods take/return strings. `cluster` takes an item array and this
explicit options envelope as its second argument:

```json
{"sourceId":"source-id","calendar":{"identifier":"gregorian","secondsFromGMT":0},"config":{}}
```

Individual fields inside `config` default to Swift's nine thresholds; the
`config` object itself is required. Both index methods validate and normalize the complete schema-1 JSON. Invalid input throws
`IllegalArgumentException` with JSON `{code,message}`; caught internal panics
throw `RuntimeException`, never empty-success JSON. Neither Android SDK nor
MediaStore code is present. Java `String.length()` checks 16 Mi UTF-16 units
before `get_string`; UTF-8 JSON is capped at 32 MiB and config at 16 KiB. A
streaming preflight rejects strings over 4096 bytes and collections over 100k
before typed allocation. Index aggregate membership is capped at 100k, sub-days
at 366; serialization uses a bounded writer and JNI output is prechecked. All
three exports and public JSON helpers reject violations, while 50k inputs pass.
These are transport bounds, not a completed Android peak-RAM/CPU budget gate.

Six host/desktop dependencies: `serde`, `serde_json` (correctly rounded Double
parsing), `sha2`, `chrono`, `chrono-tz` and `unicode-normalization` 0.1.26. Bundled
IANA rules remain necessary for DST on those targets; Android instead uses
bionic's device timezone database through its target-only `libc` dependency.
Clock features stay disabled. NFC character
comparison with an ASCII fast path reproduces Swift String ordering without
normalizing raw IDs or source hash bytes. Dates quantize through Foundation's
2001 reference epoch; intervals/midpoints use that epoch too. Config thresholds
and fileModTime remain plain Doubles. The unmodified Swift source oracle matches
20 cases, including `Date(-1e-8) = 0` and
`Date(0.10000002) = 0.10000002384185791`.

Ten direct dependencies with both features; no cap/filesystem crate enters the
Android normal graph. No bitmap/ML, Tauri, network or Android-framework engine.
Stripped LTO `opt-level="z"` **aarch64 macOS host JNI dylib: 1,891,328 bytes
(1.804 MiB)**, +182,560 bytes from 1,708,768. An otherwise-identical temporary
non-NFC control measured 1,775,600 bytes: NFC adds 115,728 bytes; the canonical
comparator was restored and reverified afterward. That host JNI dylib is a
macOS diagnostic, not an Android shipping artifact. Slice 5 measured the stripped
Android release libraries at **777,264 bytes (`arm64-v8a`)** and **856,856 bytes
(`x86_64`)**, both below the 1.5 MiB per-ABI target; the packaged debug APK and
all three JNI exports were verified for both ABIs.

### Executed verification and remaining gates

From the worktree root, using
`CARGO_TARGET_DIR=/tmp/manorama-events-rust-slice3-target`:

- macOS `cargo test --locked -p event-clustering`: **56 passed**.
- With `--features android`: **63 passed**.
- With `--features fs-scan`: **68 passed** (includes capability and locality-transition regressions).
- With `--all-features`: **75 passed** on macOS and **74 passed** in the Linux `rust:1` Docker image. The live Swift oracle is macOS-only.
- Every combination consumes all **37 unchanged fixture files**, plus an
  inventory test; Android combinations also exercise each fixture through JNI's
  JSON helper. Additional tests cover parser, primitives, index, privacy and fs.
- `cargo fmt --all -- --check`, all-target/all-feature Clippy with warnings denied,
  and `git diff --check` passed.
- The release dylib's three JNI symbols were inspected. The added Java host
  harness in `crates/event-clustering/tests/RustBridge.java` was compiled with
  `javac --release 21` and run on host JDK 26 and Android Studio's Java 21:
  **60 checks passed** on each, including pre-copy limits and 50k input.
  Not an ART/NDK run.
- Unchanged Swift suite rerun: **78 passed**. `bunx tsc --noEmit` and the complete
  mirrored `bun run test:unit` rerun: **2,716 passed, 0 failed**.

`verify.yml` now defines a credential-free Ubuntu cargo-test matrix for default,
`fs-scan`, `android` and combined features, using the root locked manifest and an
external target directory. It has been prepared, not executed remotely. Local
Linux Docker execution passed; these were the remaining gates at Slice 3's
close. Slice 4 subsequently closed Tauri wiring and private-store integration,
Slice 5 closed Android ABI builds, size, ART instrumentation and the 50,000-item
Android budget check, and Slice 6 closed the available consolidated performance,
localization, browser-accessibility and fail-closed runner gates. No viewer
change was made in the core-only slice, so no Playwright or native screenshot
evidence is claimed for that slice.

## 7. Slice 6 hardening outcome

The consolidated runner is `scripts/test-all-surfaces.sh`; it reports every lane
as PASS, FAIL or an explicit SKIP and exits nonzero on any failure. The full run
passed 17 lanes. Its seeded iPad lane exposed a fixture-isolation defect: a reused
simulator's earlier synthetic batches share the same dates and legitimately join
the current batch's events. The assertion now checks the current prefix's exact
membership and `[2, 2, 3]` partition within mixed-library events without deleting
existing media; the isolated iOS rerun passed 28/28. Windows is explicitly skipped
because this host has no Windows runner.

| Local gate | Final result |
| :--- | :--- |
| TypeScript | `bunx tsc --noEmit` clean |
| Bun | 2,757 passed, 0 failed; 34,949 expectations; 218 files |
| Rust core | default, `fs-scan`, `android`, combined and strict Clippy all passed |
| Swift event engine | 78 passed, 0 failed |
| macOS native boundary | ALL PASS; 262 checks, including production `WKWebView` protocol delivery |
| macOS 50,000-file budget | initial 4.142 s; unchanged rescan 0.899 s; 193.50 MB peak RSS; zero rescan header reads; 2,500 events / 50,000 members |
| Tauri | desktop bundle built; 48 shell tests passed; strict Clippy passed |
| Desktop Camera Roll Playwright | 10 passed, including axe, 200% text, reflow, 44 px targets and controller-retirement races |
| Seeded iOS/iPadOS | 28 iPhone and 28 iPad XCTest checks passed; synthetic-only evidence retained |
| Android | Java 21 JVM/debug build passed; 12 emulator instrumentation tests passed; both packaged JNI ABIs export all three symbols |
| Android JNI size | `arm64-v8a` 785,592 bytes; `x86_64` 863,672 bytes; each below 1.5 MiB |
| Linux Rust core | cached `rust:1` Docker all-features run passed 74 tests |
| Whitespace / shell | `git diff --check` and shell syntax checks passed |

The synthetic-only large-text captures are under
`outputs/slice6-accessibility/`. Browser axe, reflow and target-size checks are
useful automated evidence, not a substitute for real assistive technology.

Still unclaimed owner/device or packaging gates:

* Complete six-state visual evidence from a packaged sandboxed macOS release.
* Real-device iCloud-only behavior, per-download Low Data/cellular consent and
  locked-device behavior.
* Physical Pixel partial access and real VoiceOver, Dynamic Type and TalkBack
  sweeps.
* Packaged Windows and Linux application runtime evidence; Linux verification
  here covers the Rust core, not a packaged desktop app.
* The broad pre-existing Playwright matrix remains red as documented above; the
  focused event surface is green.
