# Plan: Event Clustering on All Surfaces

Status: proposed · Branch base: `feat/event-clustering-camera-roll` (9 commits on `b4a91f29`) · Normative contract: `docs/event-clustering-bridge-contract.md`

This plan takes the camera-roll event clustering feature from "macOS complete, iOS plugin dormant" to every Manorama surface: iPhone, iPad, Windows, Linux and Android. It is organised by the seven directions requested, followed by sequencing, risks and decisions. The standing non-negotiables of `PLAN-Event-Clustering-Camera-Roll.md` apply throughout: 100% on-device (no EXIF, GPS, thumbnails or paths leave the device), no ML frameworks or bundle bloat, no semantic labels, one raw-dump source per device, no full-bitmap decode during indexing, safe handling of cloud placeholders, private files written 0600 / complete file protection, and `--config`/`--store` isolation.

## 0. Where we stand

| Surface | Engine | Shell commands (4) | Pixels for an event | UI visible | Tests |
|---|---|---|---|---|---|
| macOS | Swift core | Done (`RawDumpEvents`, `FolderDumpScanner`) | Done (local scheme) | Done (`desktop/islands/EventClusters.tsx`) | 37 engine + 126 boundary + bun |
| iOS / iPadOS | Swift core | Done (`EventClusteringPlugin`, `PhotoKitDumpScanner`), registered | **Missing** | **Hidden** (no `native/` wrapper) | Simulator typecheck only |
| Windows / Linux (Tauri) | **None** | **None** | Existing `read_file_range` | Gated off in shared desktop bundle | None |
| Android | **None** | **None** | **None** | **None** | None |

## 1. Make the feature visible on iPhone and iPad

The native side already answers the four contract commands; what is missing is the `native/` bundle side.

**Phase 1a: bridge wrapper.** Add `native/lib/event-clustering.ts`, modelled on `native/lib/local-gallery.ts`: `registerPlugin<EventClusteringPlugin>('EventClustering')` exposing `pickRawDumpRoot`, `getRawDumpStatus`, `scanRawDumpEvents`, `clearRawDumpRoot`. Every reply is passed through the validators in `packages/core/event-clustering.ts` (epoch-ms dates, `evt_` ids) so the mobile bundle never trusts shape. An `isEventClusteringAvailable()` gate returns true only for `Capacitor.getPlatform() === 'ios'` until Android (section 5) lands; afterwards the gate becomes a capability probe (`getRawDumpStatus` resolves) rather than a platform check.

**Phase 1b: Settings row.** In `native/islands/Settings.tsx`, a "Camera roll events" row: declare / change / clear the source, show status (authorisation state, event count, last indexed). Copy follows `docs/copy-labels.md`; no semantic wording.

**Phase 1c: event cards.** In `native/islands/GalleryList.tsx`, an Events section rendered when a dump is declared: chronological cards with date span, frame count and optional sub-days. Reuse the presentation maths (span formatting, sub-day grouping) by lifting it from `desktop/islands/EventClusters.tsx` into `packages/core` so desktop and mobile share one implementation and one test file. GalleryList is 2,895 lines; the section goes in a new `native/islands/EventSection.tsx` imported by GalleryList, not inline.

**Phase 1d: iPad and permissions.** iPad: multi-column card grid at regular width, Split View / Stage Manager resizing, pointer hover states, keyboard focus order. Photos authorisation: handle `.notDetermined`, `.denied` (link to Settings), and `.limited` (show "Showing N selected photos", offer `presentLimitedLibraryPicker`, re-scan on `PHPhotoLibraryChangeObserver`). `NSPhotoLibraryUsageDescription` wording reviewed against the on-device promise.

**Acceptance.** On iPhone 17 Pro Max and iPad Pro 13 (M5) simulators with seeded media, declaring the dump shows events; clearing removes them and deletes `events-index.json`; limited access shows only selected frames; no network request is made (verified by Web Inspector network log being empty for the flow).

## 2. Spec: the fifth method, showing a photograph from an event

Today an iOS event card has `localIdentifier`s but no way to get pixels into the WebView; `convertFileSrc` needs a file URL and PhotoKit assets have none. This section is spec-level; the contract (§3 new method, §7 table) is updated before code.

**Method.** `getEventAssetImage({ ids: string[], purpose: 'thumbnail' | 'viewer', maxPixelSize?: number })` → `{ items: [{ id, url | null, width, height, state: 'ready' | 'cloudOnly' | 'missing' }] }`.

- `ids` are opaque per-source asset ids already emitted by `scanRawDumpEvents` (PHAsset `localIdentifier` on iOS, MediaStore id on Android, relative path on desktop). Batch cap 64.
- `thumbnail`: `PHCachingImageManager.requestImage` with `deliveryMode .opportunistic`, `resizeMode .fast`, `isNetworkAccessAllowed = false`, target `min(maxPixelSize, 512) × scale`; never larger than the asset (no upscale, invariant 13). Encoded once as JPEG into `Caches/event-thumbs/<sha256(id|modDate|size)>.jpg`, complete file protection, LRU eviction at 200 MB, purged on `clearRawDumpRoot`.
- `viewer`: originals are not re-encoded (invariant 2). `PHAssetResourceManager.writeData` of the original resource to a private temp file, served via `convertFileSrc`; files are removed when the viewer closes or on next launch. HEIC is displayed natively by WKWebView.
- iCloud-only assets: `isNetworkAccessAllowed` stays false; reply `state: 'cloudOnly'`, UI shows a placeholder with "Available in Photos" and an "Open in Photos" action. Downloading from iCloud is a deliberate, opt-in follow-up decision, not part of this spec.
- Alternative considered: a `WKURLSchemeHandler` (`manorama-asset://`) streaming bytes without temp files. Capacitor owns the WebView configuration, so this would require a Capacitor bridge subclass; deferred unless temp-file I/O proves too slow.

**Tests.** XCTest on simulator with `simctl addmedia` fixtures: thumbnail respects max size and never upscales; cache key changes when the asset changes; eviction bound; `clearRawDumpRoot` purges cache; unknown id yields `missing`. Bun tests for the TS wrapper validating every state.

## 3. Root-only scanning: a documented exception for the raw dump

`b4a91f29` made gallery ingestion (Cloud and Local) scan folder roots only. The raw dump is a different concept: one user-declared camera-roll source whose whole point is to be recursed and re-presented as events.

- `docs/manorama-operations.md` (line 35, "Source link expectations"): add "Exception: the user-declared camera-roll dump (event clustering) is indexed recursively, because it is a single dump rather than a curated gallery. It never becomes a gallery source and its subfolders are not published."
- Contract: add the same rule as an invariant, and state that a folder cannot be both a gallery root and the raw dump (declaring one rejects the other with a clear error).
- Tests: a boundary test asserting `LocalGallery` scanning of a nested tree stays root-only while `FolderDumpScanner` over the same tree recurses; equivalent Rust and Android tests as those ports land.

## 4. Tauri for Windows and Linux

**Engine.** Port the Swift core (`Models`, `EventClusterer`, `EventIndex`, `DumpMetadataParser`, `GeoMath`, `SHA256Digest`) to a Rust crate `crates/event-clustering` (workspace member, no Tauri dependency, so it can also serve Android, see section 5). Pass order identical: hygiene → home base → sessionize → trip merge. The optional `VisualBoundaryProbe` is not ported initially (Vision-only; the probe is optional by design).

**Dependencies (justified per AGENTS.md).** `sha2` (event ids must match byte-for-byte), `kamadak-exif` (pure Rust, header-only EXIF read, no decode), `walkdir` (recursive dump walk), `notify` (change watching, parity with `RawDumpWatcher`), `serde_json` already present. No image crates: indexing never decodes pixels, and thumbnails are deferred to the existing `read_file_range` path plus WebView decode.

**Shell.** Four Tauri commands in `src-tauri/src/event_clustering.rs` registered in `generate_handler!`: `pick_raw_dump_root` (dialog plugin), `get_raw_dump_status`, `scan_raw_dump_events`, `clear_raw_dump_root`. Index and declaration written via `private_store.rs` (0600 on Unix, user-only ACL default on Windows). Paths honour `--config`/`--store`. Cloud placeholders: skip OneDrive/Dropbox files with `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / `OFFLINE` on Windows so indexing never triggers a download. The fs-plugin capability scope must include the declared dump root only.

**Bundle.** `desktop/lib/event-clustering.ts` already gates on the host; add the Tauri `invoke` transport so the same island renders. Pixels use `read_file_range`.

**Verification.** `cargo test -p event-clustering` (golden parity, section 7), `cargo test` in `src-tauri`, `cargo check --target x86_64-unknown-linux-gnu` via Docker, and the Windows build in `desktop-windows.yml` (no cargo-xwin locally; do not add it).

## 5. Android in sync

Android currently has only `MainActivity.java` and no LocalGallery equivalent, so this is the largest section.

**Engine.** Use the Rust crate from section 4 via JNI (`cargo-ndk` in CI, `aarch64-linux-android` + `x86_64-linux-android` for the emulator), or a Kotlin port. Recommendation in Decisions (D1).

**Plugin.** `android/app/src/main/java/in/thecontrarian/manorama/EventClusteringPlugin.kt` (`@CapacitorPlugin(name = "EventClustering")`), registered in `MainActivity` via `registerPlugin`. Source is MediaStore `Images` (and optionally `Video`) of the camera bucket or the whole library, user-chosen; one source per device. Metadata from MediaStore columns (`DATE_TAKEN`, `WIDTH`, `HEIGHT`, `BUCKET_ID`) plus `ExifInterface` on `setRequireOriginal` URIs for GPS; never decode bitmaps. `ContentObserver` replaces `RawDumpWatcher`. Index in `filesDir/events-index.json` (app-private, `MODE_PRIVATE`). Fifth method via `ContentResolver.loadThumbnail` into `cacheDir`, served by `convertFileSrc`.

**Permissions and manifest.** `READ_MEDIA_IMAGES` (33+), `READ_MEDIA_VISUAL_USER_SELECTED` (34+, partial access UX mirroring iOS `.limited`), `READ_EXTERNAL_STORAGE` with `maxSdkVersion=32`, `ACCESS_MEDIA_LOCATION` (GPS; without it EXIF location is redacted and trip merge degrades gracefully, which must be tested). minSdk 24 stays.

**Bundle.** The section 1 gate flips to a capability probe; Android uses the same `EventSection`.

**Verification.** `./gradlew test` (JVM unit tests with parity fixtures), `./gradlew connectedAndroidTest` on `manorama_api36` with media pushed via `adb push` + media scan, and a manual check on `Pixel_10a` of partial access.

## 6. Run every suite on simulators and emulators

| Suite | Command | Notes |
|---|---|---|
| Swift engine | `scripts/test-event-clustering.sh` | 37 tests |
| macOS boundary | swiftc command in contract §6, `/tmp/boundaryN` | 126 checks; needs escalation for `@Observable` |
| Bun / TS | `bunx tsc --noEmit && bun test` | 583 + 21 |
| iOS build + tests | `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=27.1' -derivedDataPath /tmp/mano-dd -clonedSourcePackagesDirPath /tmp/mano-spm test` | Repeat for `iPad Pro 13-inch (M5)`, `iPhone 17e`, `iPad mini (A17 Pro)`; seed with `xcrun simctl addmedia <udid> fixtures/*.heic`; grant with `xcrun simctl privacy <udid> grant photos in.thecontrarian.manorama`; never pass `DEVELOPMENT_TEAM` |
| Android unit | `JAVA_HOME=<JDK 21> ./gradlew test` in `android/` | JDK 26 on PATH is likely unsupported by AGP; install Temurin 21 (decision D3) |
| Android instrumented | `emulator -avd manorama_api36 -no-window &` then `./gradlew connectedAndroidTest` | |
| Rust | `cargo test --workspace` | plus Linux via Docker |
| Playwright | existing e2e config | desktop bundle with event fixtures |

A single `scripts/test-all-surfaces.sh` drives these and writes a summary; each step is skippable with a clear "SKIPPED: reason" rather than silently passing. Known sandbox needs: DerivedData and SwiftPM caches redirected to `/tmp`, escalation for `swiftc` with macros and for git writes, emulator launch outside the sandbox.

## 7. Other learnings to fold in

1. **Shared golden fixtures.** Export the 37 Swift test cases as JSON (`fixtures/event-clustering/*.json`: inputs + expected events, ids, spans). Swift, Rust, Kotlin (if chosen) and TS all assert against the same files; a mismatch in any port fails CI.
2. **CI.** `verify.yml`: Swift engine tests and boundary suite on macOS runners; `cargo test` on Linux; `ios.yml`: simulator tests; `android-release.yml` or a new `android-verify.yml`: unit tests.
3. **Contract §6 "one page drives both".** Rewrite: two bundles (`desktop/`, `native/`) share `packages/core` only; each surface section names its bundle.
4. **Privacy declarations.** iOS `PrivacyInfo.xcprivacy` (photo library access, no tracking, file timestamp API reason codes); Play Console data safety ("photos accessed, not collected"); macOS/Windows privacy copy.
5. **Hygiene.** Fix `scripts/build-macos.sh` in worktrees (resolve the `node_modules` symlink or build from the main checkout); a CI check for exec bits on `scripts/*.sh`; keep `.build`/`.swiftpm` ignored.
6. **End-to-end runs, not summaries.** Each phase closes with a real app run on its surface (macOS app launch, simulator, emulator), with screenshots, because typechecks missed the unregistered iOS plugin and the reentrant `queue.sync` crash.
7. **Performance budget.** A 50,000-item synthetic dump: index under 10 s on M-class Mac, memory under 300 MB, incremental rescan under 1 s; equivalent Android budget on the emulator.
8. **Localisation and accessibility.** Date spans via `Intl.DateTimeFormat` with the device locale and calendar; VoiceOver/TalkBack labels like "12 to 15 March, 214 photos"; Dynamic Type.
9. **Schema versioning.** `events-index.json` `schemaVersion`: a newer unknown version is discarded and rebuilt, never migrated in place; documented in the contract.
10. **Clustering stability.** Event ids depend on `startSeconds`; adding an earlier frame changes the id. Document this and keep any UI state keyed defensively.

## Sequencing and PR slicing

One issue, branch and PR per slice, per AGENTS.md:

1. `feat/event-clustering-camera-roll` (current, 9 commits) → PR for engine + macOS + dormant iOS plugin + contract, plus section 3 docs and test.
2. `feat/event-clustering-golden-fixtures` → shared JSON fixtures and CI jobs (section 7.1 and 7.2). Prerequisite for every port.
3. `feat/event-clustering-ios-visible` → sections 1 and 2 (wrapper, Settings, EventSection, fifth method).
4. `feat/event-clustering-rust-core` → Rust crate with parity.
5. `feat/event-clustering-tauri` → section 4 shell and bundle transport.
6. `feat/event-clustering-android` → section 5.
7. `chore/event-clustering-hardening` → performance, localisation, accessibility, privacy declarations, test-all script.

Slices 3 and 4 can proceed in parallel after 2; 6 depends on 4 if D1 chooses Rust.

## Risks

- PhotoKit temp-file viewer path may be slow for large ProRAW/HEIC originals; mitigated by the scheme-handler alternative.
- `ACCESS_MEDIA_LOCATION` denial removes GPS on Android, weakening trip merge; must degrade to time-only clustering with tests.
- JNI adds build complexity (NDK in CI, 4 ABIs); a Kotlin port avoids it at the cost of a third engine.
- Windows cloud-placeholder detection varies by provider; unit-test the attribute check with synthetic files.

## Decisions needed

- **D1 Port strategy.** Recommended: one Rust core for Tauri and Android (JNI), Swift stays for Apple, golden fixtures bind all. Alternative: Kotlin port for Android.
- **D2 iCloud-only assets.** Placeholder only (recommended) or opt-in download.
- **D3 JDK.** Install Temurin 21 for Android builds (recommended) versus trying JDK 26.
- **D4 PR slicing.** Accept the seven slices above or merge 4 and 5.
