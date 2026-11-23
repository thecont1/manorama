# Plan: Event Clustering on All Surfaces

Status: **revised, decisions locked, not yet executed** · Branch base: `feat/event-clustering-camera-roll` (on `b4a91f29`) · Normative contract: `docs/event-clustering-bridge-contract.md`

This plan takes camera-roll event clustering from "macOS complete, iOS plugin dormant" to every Manorama surface: iPhone, iPad, Windows, Linux and Android. The standing non-negotiables of `PLAN-Event-Clustering-Camera-Roll.md` apply throughout: 100% on-device (no EXIF, GPS, thumbnails or paths leave the device), no ML frameworks or bundle bloat, no semantic labels, one raw-dump source per device, no full-bitmap decode during indexing, safe handling of cloud placeholders, private files written 0600 / complete file protection, and `--config`/`--store` isolation.

## Locked decisions

| # | Decision | Consequence in this plan |
|---|---|---|
| D1 | One Rust core shared by Tauri and Android; Capacitor stays on mobile with a Kotlin plugin as the Android bridge | New crate `crates/event-clustering`; Android calls it through JNI from Kotlin. Swift core remains for Apple surfaces. Golden fixtures bind Swift and Rust. |
| D2 | iCloud-only photos: placeholder first, then opt-in download | Fifth method gains an explicit `allowNetwork` path, off by default (section 2). |
| D3 | Java 21 for Android builds | Temurin 21 installed via Homebrew; `JAVA_HOME` pinned in scripts and CI. |
| D4 | Branch slicing delegated | Six slices, below. |

**D1 confirmed.** Mobile stays on Capacitor. Event cards render in the shared `native/dist` web UI on both iOS and Android. On Android, a custom Capacitor plugin written in Kotlin bridges permissions (including the partial-access picker), MediaStore access, `ContentObserver`, thumbnails and the JNI calls into the Rust engine; it holds no clustering logic and no Compose screens. A Tauri Mobile migration is out of scope.

## 0. Where we stand

| Surface | Engine | Shell commands (4) | Pixels for an event | UI visible | Tests |
|---|---|---|---|---|---|
| macOS | Swift core | Done | Done (local scheme) | Done | 37 engine + 126 boundary + bun |
| iOS / iPadOS | Swift core | Done, registered | **Missing** | **Hidden** | Simulator typecheck only |
| Windows / Linux (Tauri) | **None** | **None** | Existing `read_file_range` | Gated off | None |
| Android | **None** | **None** | **None** | **None** | None |

## 1. Make the feature visible on iPhone and iPad

The native side already answers the four contract commands; the `native/` bundle side is missing.

- **Bridge wrapper.** `native/lib/event-clustering.ts`, modelled on `native/lib/local-gallery.ts`: `registerPlugin('EventClustering')` exposing `pickRawDumpRoot`, `getRawDumpStatus`, `scanRawDumpEvents`, `clearRawDumpRoot` and the fifth method. Every reply goes through the validators in `packages/core/event-clustering.ts`. `isEventClusteringAvailable()` is a capability probe (`getRawDumpStatus` resolves), not a platform check, so Android lights up without bundle changes.
- **Shared presentation.** Lift span formatting and sub-day grouping out of `desktop/islands/EventClusters.tsx` into `packages/core`, with one test file used by both bundles.
- **Settings row.** In `native/islands/Settings.tsx`: declare, change or clear the source; show authorisation state, event count and last indexed time; hold the iCloud download toggle (section 2).
- **Event section.** New `native/islands/EventSection.tsx` imported by `GalleryList.tsx` (2,895 lines; nothing added inline).
- **iPad.** Multi-column grid at regular width, Split View and Stage Manager resizing, pointer hover, keyboard focus order.
- **Photos access.** Handle `.notDetermined`, `.denied` (link to Settings) and `.limited` ("Showing N selected photos", `presentLimitedLibraryPicker`, rescan on `PHPhotoLibraryChangeObserver`). Review the `NSPhotoLibraryUsageDescription` wording against the on-device promise.

**Acceptance.** On the iPhone 17 Pro Max and iPad Pro 13 (M5) simulators with seeded media: declaring shows events; clearing removes them and deletes `events-index.json` and the thumbnail cache; limited access shows only selected frames; the Web Inspector network log is empty for the whole flow while the download toggle is off.

## 2. Spec: the fifth method, a photograph from an event

PhotoKit assets have no file URL, so `convertFileSrc` cannot reach them today. The contract (new §3 method, §7 table) is updated before code.

**Signature.** `getEventAssetImage({ ids, purpose: 'thumbnail' | 'viewer', maxPixelSize?, allowNetwork?: boolean })` → `{ items: [{ id, url | null, width, height, state }] }` with `state` one of `ready`, `cloudOnly`, `downloading`, `failed`, `missing`. Batch cap 64. Ids are opaque per-source ids from `scanRawDumpEvents`: PHAsset `localIdentifier` on iOS, MediaStore id on Android, relative path on desktop.

**Thumbnails.** `PHCachingImageManager.requestImage` with `.opportunistic`, `resizeMode .fast`, target `min(maxPixelSize, 512) × scale`, never above the asset size (no upscale, invariant 13). Encoded once as JPEG into `Caches/event-thumbs/<sha256(id|modDate|size)>.jpg` with complete file protection, LRU eviction at 200 MB, purged by `clearRawDumpRoot`.

**Viewer.** No re-encode of originals (invariant 2): `PHAssetResourceManager.writeData` of the original resource into a private temp file served via `convertFileSrc`, removed when the viewer closes and swept on launch.

**iCloud-only photos (D2).**
1. Default: `allowNetwork` is false everywhere and the reply is `cloudOnly`. The UI shows a placeholder card ("In iCloud") and an "Open in Photos" action.
2. Opt-in: a Settings toggle "Download iCloud photos when I open them", off by default. A one-off "Download this photo" action on the placeholder is available even with the toggle off.
3. When allowed, the request sets `isNetworkAccessAllowed = true` for that asset only and reports progress through a `eventAssetProgress` plugin event (`{ id, fraction }`); the card shows progress and supports cancel (`PHImageManager.cancelImageRequest`).
4. Downloads are performed by the OS from the user's own iCloud account into the device's Photos library. Manorama sends nothing anywhere; the on-device invariant holds. The copy says this plainly.
5. Thumbnails never trigger downloads, even with the toggle on: only an explicit open does. Indexing never downloads.
6. Respect Low Data Mode and cellular: when `ProcessInfo`/`NWPathMonitor` reports a constrained or expensive path, ask before each download.
7. Android equivalent: MediaStore items are local by definition; cloud-backed items from Google Photos are not in scope and are excluded by source choice. Desktop equivalent: cloud placeholders (OneDrive, iCloud Drive, Dropbox) stay `cloudOnly` with an "Open in Finder/Explorer" action; no opt-in download in this plan.

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

**Tauri shell.** `src-tauri/src/event_clustering.rs` with `pick_raw_dump_root`, `get_raw_dump_status`, `scan_raw_dump_events`, `clear_raw_dump_root` and `get_event_asset_image`, registered in `generate_handler!`. Writes go through `private_store.rs` (0600 on Unix; user-only default ACL on Windows). Paths honour `--config`/`--store`. Windows cloud placeholders with `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` or `OFFLINE` are skipped during indexing. The fs capability scope covers the declared dump root only. Thumbnails reuse `read_file_range` plus WebView decode; no Rust-side image work.

**Bundle.** Add the Tauri `invoke` transport to `desktop/lib/event-clustering.ts` so the existing island renders unchanged.

**Verification.**
- `cargo test -p event-clustering` against the golden fixtures.
- `cargo test` in `src-tauri`.
- Linux build and tests in Docker (`rust:1` image).
- Windows build and tests in `desktop-windows.yml`. Local Windows cross-tooling is not added.

## 5. Android in sync (Rust core via JNI, thin Kotlin layer)

Android today has only `MainActivity.java`, so this is the largest slice.

**Native library.** `crates/event-clustering` built with `cargo-ndk` for `arm64-v8a` and `x86_64` (emulator). `armeabi-v7a` is added only if Play device stats require it. The output `libmanorama_events.so` goes into `android/app/src/main/jniLibs/`. Gradle runs the Rust build via a `preBuild` task, and CI caches the target directory.

The JNI surface is deliberately narrow: `cluster(itemsJson: String, configJson: String): String` and `decodeIndex` / `encodeIndex`. JSON is the boundary, so the Kotlin side stays thin and the wire matches the contract.

The rebuilt `.so` must be measured against the bundle-bloat rule. The target is under 1.5 MB per ABI after `strip` and `opt-level="z"`, recorded in the PR.

**Kotlin layer.** `android/app/src/main/java/in/thecontrarian/manorama/events/`:
- `EventClusteringPlugin.kt` (`@CapacitorPlugin(name = "EventClustering")`), registered in `MainActivity`. It implements the four commands plus the fifth.
- `MediaStoreSource.kt`: queries `MediaStore.Images` (and optionally `Video`) for `DATE_TAKEN`, `WIDTH`, `HEIGHT`, `BUCKET_ID`, `IS_PENDING`. GPS comes from `ExifInterface` on `MediaStore.setRequireOriginal` URIs. It never decodes bitmaps. The source is either the whole library or the camera bucket, chosen by the user; there is one source per device.
- `RustBridge.kt`: `System.loadLibrary` plus the external functions above.
- `MediaObserver.kt`: a `ContentObserver` with debounce, replacing `RawDumpWatcher`.
- Index stored in `filesDir/events-index.json` (app-private). Thumbnails via `ContentResolver.loadThumbnail` into `cacheDir/event-thumbs` with the same 200 MB LRU, served by `convertFileSrc`. The viewer streams the original through a private temp copy.

**Permissions and manifest.**
- `READ_MEDIA_IMAGES` (API 33+).
- `READ_MEDIA_VISUAL_USER_SELECTED` (API 34+): partial access, with UX mirroring the iOS limited state.
- `READ_EXTERNAL_STORAGE` with `maxSdkVersion="32"`.
- `ACCESS_MEDIA_LOCATION`. If it is denied, clustering is time-only and trip merge is skipped. This path is tested.
- minSdk stays at 24; `targetSdk 36` behaviour is verified.

**Bundle.** No changes beyond section 1, because the capability probe lights it up.

**Verification.**
- `./gradlew test`: JVM tests, with Rust loaded on the host via a desktop build of the crate.
- `./gradlew connectedAndroidTest` on `manorama_api36`, with fixtures loaded via `adb push` and a media scan broadcast.
- A manual partial-access check on `Pixel_10a`.
- The `cargo test` fixtures also run under the `android` feature.

## 6. Run every suite on simulators and emulators

| Suite | Command | Notes |
|---|---|---|
| Swift engine | `scripts/test-event-clustering.sh` | 37 tests |
| macOS boundary | swiftc command in contract §6 → `/tmp/boundaryN` | 126+ checks; escalation for `@Observable` |
| Bun / TS | `bunx tsc --noEmit && bun test` | desktop, packages, native |
| iOS | `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.1' -derivedDataPath /tmp/mano-dd -clonedSourcePackagesDirPath /tmp/mano-spm test` | Repeat for iPad Pro 13-inch (M5), iPhone 17e, iPad mini (A17 Pro). Seed media with `xcrun simctl addmedia`, grant with `xcrun simctl privacy <udid> grant photos <bundle id>`. Never pass `DEVELOPMENT_TEAM`. |
| Rust | `cargo test --workspace`; Docker for Linux | Windows in CI |
| Android unit | `JAVA_HOME=$(brew --prefix)/opt/openjdk@21 ./gradlew test` in `android/` | Install `openjdk@21` first (D3) |
| Android device | `emulator -avd manorama_api36 -no-window &` then `./gradlew connectedAndroidTest` | needs `cargo-ndk` and the NDK |
| Playwright | existing e2e config | desktop bundle with event fixtures |

`scripts/test-all-surfaces.sh` runs them in order and prints a summary. Each step either passes, fails or reports `SKIPPED: <reason>`; none passes silently.

Known environment needs:
- DerivedData and SwiftPM caches redirected to `/tmp`.
- Escalation for `swiftc` with macros, git writes, Homebrew installs (`openjdk@21`, `cargo-ndk`), Android NDK installation through `sdkmanager`, and emulator launch.

## 7. Other learnings folded in

1. **Golden fixtures.** The 37 Swift cases are exported to `fixtures/event-clustering/*.json` (inputs, expected ids, spans and sub-days). Swift and Rust assert against the same files, and any divergence fails CI. A small generator in the Swift test target keeps them current.
2. **CI.**
   - `verify.yml`: Swift engine and boundary suite on a macOS runner; `cargo test` on Linux.
   - `ios.yml`: simulator tests.
   - New `android-verify.yml`: Java 21, NDK, `cargo-ndk` and `gradlew test`.
   - `desktop-windows.yml`: crate tests.
3. **Contract §6.** Replace "one page drives both" with: two bundles (`desktop/`, `native/`) share `packages/core`; each surface names its bundle and transport.
4. **Privacy declarations.**
   - iOS `PrivacyInfo.xcprivacy`: photo library use, required-reason APIs and no tracking.
   - Play data-safety form: photos are accessed but not collected or shared.
   - Store copy explaining iCloud downloads as OS-performed.
5. **Hygiene.** Make `scripts/build-macos.sh` work from worktrees by resolving the `node_modules` symlink or building from the main checkout. Add a CI check that `scripts/*.sh` are executable. Keep `.build`, `.swiftpm` and Rust `target/` ignored.
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
- **JNI on Android:** JNI adds NDK, ABI and `.so` size concerns. The size budget is enforced in the slice 5 PR, and the JSON boundary keeps the surface to three functions.
- **Android location access:** denial of `ACCESS_MEDIA_LOCATION` weakens trip merge. Time-only clustering is tested explicitly.
- **Windows cloud placeholders:** detection varies by cloud provider, so it is unit-tested with synthetic attributes.
- **Version churn:** AGP, Java 21 and Capacitor versions drift over time, so `JAVA_HOME` and the NDK version are pinned in `android/gradle.properties` and CI.
