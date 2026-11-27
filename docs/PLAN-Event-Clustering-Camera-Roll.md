# Plan: Event Clustering for Camera Roll

## 1. Context, Philosophy & Core Non-Negotiables
**Manorama** (`github.com/thecont1/manorama`) is a cross-platform, privacy-first photo gallery across macOS, iOS, and iPadOS (SwiftUI), Windows (Tauri), and Android (Capacitor).

* **Strict Privacy & Zero Central Image Storage:** Originals never leave the owner's local disk or personal cloud drive (Dropbox, Google Drive, iCloud, Google Photos, MEGA, Ente, Proton Drive). Event clustering must run **100% on-device**—never upload EXIF timestamps, GPS coordinates, thumbnails, or folder paths to any remote server.
* **Zero Bundle Bloat (Strict ~65 MB Footprint):** The base Apple app binary is ~65 MB. **Do not add third-party ML frameworks, Core ML model packages (`.mlpackage`), or Vision-Language Models.** Grouping a chronological camera dump into events is a spatiotemporal problem solved with **0 MB added** using built-in OS APIs (`ImageIO`, `PhotoKit`, `CoreLocation`, and optionally `Vision` `VNGenerateImageFeaturePrintRequest`).
* **No Semantic Event Classification:** Do not attempt to classify events with wording like *"Wedding"* or *"Hiking"*. The user only needs an overwhelming, flat chronological camera dump re-presented as smartly separated groups of images (e.g., an evening outing with friends vs. a multi-day trip), identified by date span, item count, and optional sub-days.
* **Cross-Platform Parity:** Keep the core clustering engine pure, deterministic Swift (easy to port later to Rust for Tauri and TypeScript/Kotlin for Capacitor) so event boundaries remain predictable across devices.
* **Scoped Strictly to One User-Declared "Raw Dump" Source per Device:** Event clustering does **not** run on normal curated galleries. It runs exclusively on a single specially declared raw ingestion source per device:
  * **iOS / iPadOS:** The system Photos Library / Camera Roll (`PhotoKit`).
  * **macOS:** A single user-selected local directory representing their raw camera backup dump (e.g., `~/Google Drive/My Drive/Photos Backup` or `~/Proton Drive/Camera Uploads`).

---

## 2. Alignment with `thecont1/manorama` Repo Architecture
Before writing code, align with how **Manorama** is built in `macos/ManoramaMac/` (and its `ios/` counterpart):

1. **Shell vs. Web Bundle (`WKWebView`):**
   * The SwiftUI layer (`AppModel`) is a thin native host around a `WKWebView` running the shared web bundle (`desktop/` / `app/`).
   * The Library, Gallery views, and Settings sheets live inside the web bundle—do **not** build separate native SwiftUI Library/Timeline screens unless explicitly requested. Instead, expose event clustering through `NativeBridge.handle(_:)` using Tauri-compatible `invoke` command names so the web bundle and future Tauri/Capacitor shells share one interface.
2. **Security-Scoped Bookmarks (`FolderStore` & `GrantedRoots`):**
   * Never trust a raw path string passed from `WKWebView`. On macOS, folder grants are persisted as security-scoped bookmarks in `folders.json` (`FolderStore.Entry`) via `ScopedFolder.makeBookmark(for:)` and mirrored to `roots.json` (`NativeBridge.recordGalleryRoot`).
   * Every filesystem operation must validate against `FolderStore` / `GrantedRoots` (`grantedPath` in `NativeBridge.swift`), open security scopes via `folderStore.startAccess(_:)`, and rely on `FolderStore.renewStaleBookmarks()` so grants survive app relaunches and folder moves under the App Sandbox.
3. **Hardened Local Persistence (`write0600` & CLI Test Seams):**
   * All durable JSON files written to `configDir` (`Application Support/in.thecontrarian.manorama.desktop`) **must** be written atomically with POSIX `0600` permissions via `NativeBridge.write0600(to:data:)`.
   * Respect `--config <dir>` and `--store <path>` CLI flags (`AppModel.swift`) so automated test runs never touch or mutate the user's real catalogue, folder grants, or event index.
4. **Cloud-Sync Placeholder Safety (Critical on macOS):**
   * When a user points macOS Manorama to a Google Drive for Desktop or Proton Drive sync folder, many files exist as **cloud-only placeholders** (managed via macOS File Provider).
   * **DO NOT** decode full image bitmaps (`NSImage(contentsOf:)`, `UIImage`, or `Data(contentsOf:)`) during indexing—this forces the cloud sync client to download gigabytes of files over the network and stalls the machine.
   * **DO** extract metadata strictly via `CGImageSourceCreateWithURL` with `kCGImageSourceShouldCache: false` (which reads only the first ~32–64 KB EXIF header, matching the pattern in `NativeBridge.imageDimensions`), falling back gracefully to `URLResourceValues` (`creationDate`, `contentModificationDate`) if a cloud placeholder refuses partial byte reads.
5. **Existing Media Streaming (`LocalSchemeHandler`):**
   * Existing `LocalSchemeHandler` already serves any image inside `grantedRoots.all()`. Because the macOS Raw Dump folder is registered in `FolderStore` and `grantedRoots`, the `WKWebView` viewer can immediately render event covers and open any clustered event in Manorama's existing photostrip/grid viewer with **zero changes to media streaming**.

---

## 3. System Design & Data Pipeline

Design the feature around three decoupled layers so `iOS` and `macOS` share 100% of the clustering and persistence logic:

```text
[Ingestion Adapters]                   [Shared Pure-Swift Core]             [Bridge & Persistence]
iOS: PhotoKitDumpScanner   ──┐
                             ├──> [MediaMetadataItem] ──> [EventClusterer] ──> events-index.json (0600)
macOS: FolderDumpScanner   ──┘        (Lightweight)        (Deterministic)      └──> NativeBridge invoke
```

### Layer 1: Unified Lightweight Metadata Models
Place core models in a shared Swift module/directory (e.g., `native/EventClustering/` linked into both `macos` and `ios` targets) with **zero UIKit/AppKit dependencies**:

```swift
public struct MediaMetadataItem: Identifiable, Codable, Hashable, Sendable {
    public let id: String                 // PHAsset.localIdentifier (iOS) or relative path/inode hash (macOS)
    public let timestamp: Date            // EXIF DateTimeOriginal -> fallback to file/asset creationDate
    public let latitude: Double?
    public let longitude: Double?
    public let isScreenshot: Bool         // PHAsset.mediaSubtypes.contains(.photoScreenshot) or missing camera EXIF + PNG
    public let burstIdentifier: String?   // PHAsset.burstIdentifier or sub-2-second timestamp grouping
    public let fileModTime: TimeInterval? // Used for incremental cache invalidation on macOS
}

public struct EventCluster: Identifiable, Codable, Hashable, Sendable {
    public let id: String                 // Deterministic hash of sourceId + startTimestamp
    public let startDate: Date
    public let endDate: Date
    public let isMultiDay: Bool
    public let coverItemId: String        // Best representative frame (non-burst-tail, non-screenshot)
    public let itemIds: [String]          // Ordered chronological member IDs
    public let subDays: [EventDayGroup]?  // Populated when isMultiDay == true
}

public struct EventDayGroup: Identifiable, Codable, Hashable, Sendable {
    public let id: String                 // YYYY-MM-DD in local capture timezone
    public let date: Date
    public let itemIds: [String]
}

public struct ClusteringConfig: Codable, Sendable {
    public var sessionGapHours: Double = 3.5
    public var sessionDistanceKm: Double = 5.0
    public var transitBypassMinutes: Double = 45.0
    public var tripDistanceFromHomeKm: Double = 50.0
    public var tripOvernightGapHours: Double = 18.0
    public var burstThresholdSeconds: Double = 3.0
}
```

### Layer 2: Platform Ingestion Adapters
* **Shared Supported Extensions:** Reuse `LocalScanner.imageExtensions` (`["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"]`).
* **`FolderDumpScanner` (macOS):**
  * Enumerate the security-scoped Raw Dump root recursively (including nested `YYYY/MM/` subdirectories common in Google Drive and Proton Drive backups—unlike `LocalScanner.scan`, which stops at 1 level and caps at `maxGalleryItems = 1000`, a Raw Dump folder spans months or years of uploads and must not be capped at 1,000 items).
  * Extract header properties via `CGImageSourceCopyPropertiesAtIndex(source, 0, nil)`:
    * `{Exif}.DateTimeOriginal` (parsed with `{Exif}.OffsetTimeOriginal` if present, falling back to `URLResourceKey.creationDateKey` / `.contentModificationDateKey`).
    * `{GPS}.Latitude`, `{GPS}.LatitudeRef`, `{GPS}.Longitude`, `{GPS}.LongitudeRef`.
    * `{TIFF}.Make` / `{TIFF}.Model` — if absent and file is `.png` (or matches macOS/iOS screenshot dimensions/naming), mark `isScreenshot = true`.
* **`PhotoKitDumpScanner` (iOS / iPadOS):**
  * Query `PHAsset.fetchAssets(with: .image, options: ...)` sorted by `creationDate`.
  * Read `asset.creationDate`, `asset.location?.coordinate`, `asset.mediaSubtypes.contains(.photoScreenshot)`, and `asset.burstIdentifier` directly from `PHAsset` metadata in memory (`< 100 ms` for 20,000 items, zero file I/O).

### Layer 3: Deterministic Multi-Pass Spatiotemporal Clustering (`EventClusterer`)
Run a deterministic, configurable pipeline on the extracted `MediaMetadataItem` list:

1. **Hygiene & Burst Pre-Filter:**
   * Separate `isScreenshot == true` items into a dedicated `screenshots` bucket so screen captures never fragment real-world events.
   * Group rapid-fire shots (`Δt < burstThresholdSeconds` with identical or `nil` GPS) into collapsed burst stacks, electing the middle frame as the stack representative when computing cluster density and choosing `coverItemId`, while keeping all `itemIds` in the event.
2. **Pass 1 — Home-Base Inference:**
   * Quantize all items with valid GPS coordinates into ~10 km grid cells (`round(lat * 10) / 10`, `round(lon * 10) / 10`).
   * Identify the highest-frequency cell as the user's inferred **Home Base** (requires zero network calls or external reverse-geocoding databases).
3. **Pass 2 — Atomic Sessionization (Separates Evening Outings & Local Events):**
   * Sort chronological items (`t_0, t_1, ..., t_n`).
   * Start a new `AtomicSession` whenever:
     * Time delta `Δt > sessionGapHours` (`3.5 hours`), **OR**
     * Both items have valid GPS and Haversine distance `Δd > sessionDistanceKm` (`5.0 km`), unless `Δt < transitBypassMinutes` (`45 minutes`, indicating continuous transit along a route).
   * *Outcome:* An evening dinner and drinks with friends across two nearby venues stays grouped as **1 cohesive Event**; a coffee run the following morning becomes a **distinct Event**.
4. **Pass 3 — Multi-Day Trip Merging:**
   * Evaluate consecutive `AtomicSession` clusters (`S_i, S_{i+1}`).
   * If **both** sessions are `> tripDistanceFromHomeKm` (`50.0 km`) away from **Home Base** AND the overnight gap between `S_i.endDate` and `S_{i+1}.startDate` is `< tripOvernightGapHours` (`18.0 hours`), merge them into a parent `EventCluster` with `isMultiDay = true`, preserving the underlying `AtomicSession`s as day-by-day `subDays` inside the event detail view.
5. **Optional Pass 4 — Visual Boundary Tie-Breaker (Apple `Vision.framework`, 0 MB):**
   * *Use sparingly:* Only invoke `VNGenerateImageFeaturePrintRequest` on boundary photos when an ambiguous gap occurs (e.g., `1.5 hours < Δt <= 3.5 hours` at the exact same GPS coordinate, such as an afternoon family gathering transitioning into an evening party).
   * Compute `featurePrintA.computeDistance(&distance, to: featurePrintB)` and split the session only if visual distance exceeds a calibrated threshold.
   * On macOS, **skip** this step if the file is an unhydrated cloud placeholder (`URLUbiquitousItemDownloadingStatusKey != .current`).
6. **Pass 5 — Filename Evidence:**
   * Rejoin only adjacent groups whose members all expose the same conservative, folder-scoped filename signal.
   * Explicit `MSYYYYMM-LabelNNNN` shoots may span up to 14 days; same-folder alphabetic sequences require increasing numbers no more than 12 apart, an 18-hour capture gap and a 72-hour total span. Fourteen-digit `IMG_YYYYMMDDHHMMSS` timestamps are not sequence evidence.
   * This pass affects folder-backed IDs that expose filenames. Current iOS `PHAsset.localIdentifier` values do not, so iOS retains the spatiotemporal baseline.

### Layer 4: Persistence & Incremental Sync
* **Source Declaration Persistence:**
  * **macOS:** Add `isRawDump: Bool = false` to `FolderStore.Entry` in `folders.json` (enforcing at most one active Raw Dump folder at a time) and register its root in `grantedRoots`.
  * **iOS:** Persist `cameraRollDumpEnabled: Bool` in `library-prefs.json` (or `device.json` per device ID).
* **Cached Event Index (`events-index.json`):**
  * Persist in `configDir` via `NativeBridge.write0600(to:data:)` (and optionally register in `NativeBridge.privateFiles` if the web bundle reads it directly via `read_private_file`).
  * **Schema:**
    1. `sourceFingerprint`: Device ID (`stableDeviceId()`) + folder bookmark ID (macOS) or `"photokit-library"` (iOS) + `lastIndexedAt` timestamp.
    2. `itemCache`: `[String: MediaMetadataItem]` keyed by relative path (`id`) or `PHAsset.localIdentifier` so subsequent rescans compare `fileModTime` and skip re-reading EXIF headers for unchanged files.
    3. `clusters`: `[EventCluster]` plus `screenshotItemIds: [String]`.
* **Incremental Updates:**
  * Subscribe to `PHPhotoLibraryChangeObserver` (iOS) and `FSEvents` / `DispatchSourceFileSystemObject` (macOS) so adding 20 new photos incrementally updates `itemCache` and re-evaluates only the tail end of the timeline rather than re-scanning 50,000 historical items.
* **Sharing Compatibility:**
  * Because `EventCluster` serializes cleanly to a portable JSON manifest (`startDate`, `endDate`, `coverItemId`, `itemIds`), if a user later chooses to publish an event as a shared Manorama gallery, the grouping structure travels cleanly alongside the source pointers.

---

## 4. `NativeBridge` Command Contract
Expose clean, Tauri-compatible `invoke` commands in `NativeBridge.run(_:args:headers:)` so the web bundle drives the feature identically across platforms:

| Command Name | Arguments | Return Value / Behavior |
| :--- | :--- | :--- |
| `pick_raw_dump_root` | `{}` | **macOS:** Opens `NSOpenPanel`, saves security-scoped bookmark in `FolderStore` with `isRawDump = true`, updates `grantedRoots`, returns `{ label, itemCount }`.<br>**iOS:** Requests `PHPhotoLibrary.requestAuthorization(for: .readWrite)`, enables flag in `library-prefs.json`. |
| `get_raw_dump_status` | `{}` | Returns `{ configured: Bool, label: String?, isAvailable: Bool, lastIndexedAt: Int?, eventCount: Int }` without leaking raw filesystem paths. |
| `scan_raw_dump_events` | `{ force?: Bool }` | Runs incremental metadata scan + `EventClusterer` off-main (`offMain`), persists `events-index.json` via `write0600`, returns `{ clusters: EventCluster[], screenshotCount: Int }`. |
| `clear_raw_dump_root` | `{}` | Unmarks `isRawDump` in `FolderStore` / `library-prefs.json` and deletes `events-index.json`. |

---

## 5. Execution Milestones & Verification Plan

1. **Core Swift Engine (`native/EventClustering/`):**
   * Implement `MediaMetadataItem`, `EventCluster`, `EventDayGroup`, `ClusteringConfig`, Haversine distance math, and `EventClusterer`.
2. **Pure Swift Unit Tests (`XCTest`):**
   * Test `EventClusterer` with synthetic timelines:
     * Local evening dinner + drinks (7:30 PM – 11:30 PM, 2 km apart in Home City) → **1 Event**.
     * Morning hike + evening dinner in Home City (separated by 6 hours) → **2 Events**.
     * 4-day trip 300 km from Home Base with 10-hour overnight gaps → **1 Multi-Day Event** containing **4 `subDays`**.
     * Mixed screenshots + burst photos interspersed mid-dinner → Properly separated/collapsed without fragmenting the dinner event.
3. **macOS Ingestion & Bridge (`macos/ManoramaMac/`):**
   * Implement `FolderDumpScanner` with recursive enumeration, header-only `CGImageSource` EXIF reading, and cloud-placeholder safety.
   * Extend `FolderStore` (`isRawDump: Bool`) and `NativeBridge` with the four `raw_dump` commands.
   * Verify `--config <dir>` and `--store <path>` CLI test flags isolate `events-index.json` and `folders.json` in temporary directories and enforce `0600` file permissions.
4. **iOS / iPadOS Ingestion & Bridge (`ios/`):**
   * Implement `PhotoKitDumpScanner` + `PHPhotoLibraryChangeObserver` incremental updates and wire the identical bridge commands.
5. **Web Bundle Integration (`packages/core/` & UI):**
   * Add TypeScript types and `invoke` wrappers in `packages/core/`, add the Raw Dump declaration control in Settings, and render clustered event cards (date span, item count, hero cover thumbnail, multi-day badge) that open directly into Manorama's existing photostrip/grid viewer.
