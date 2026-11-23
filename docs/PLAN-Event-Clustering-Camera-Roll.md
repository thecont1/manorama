Implementation Plan: Local Event Clustering for Designated "Raw Dump" Sources (thecont1/manorama)

1. Architectural Alignment & Existing Repo Conventions

Before writing code, align with how Manorama actually works in macos/ManoramaMac/ (and its ios/ counterpart):
• Shell vs. Web Bundle Split: The SwiftUI layer (AppModel) is a thin native host around a WKWebView running the shared web bundle. Do not build separate native SwiftUI Library/Timeline screens unless explicitly requested—instead, expose event clustering through NativeBridge (using Tauri-compatible invoke commands so the web bundle and future Tauri/Capacitor shells share one interface).
• Zero-Byte Intelligence (Strict ~65 MB Footprint): Do not bundle Core ML models or third-party ML libraries. Rely exclusively on ImageIO (CGImageSource), PhotoKit (on iOS/iPadOS), and deterministic spatiotemporal math (with optional OS-native Vision VNGenerateImageFeaturePrintRequest only as a tie-breaker on hydrated local files).
• Security & Privacy Invariants (Must Preserve):
	• Never trust a raw path passed from WKWebView. Every filesystem operation must validate against FolderStore / GrantedRoots (grantedPath in NativeBridge.swift) and open security scopes via folderStore.startAccess(_:).
	• All durable JSON files written to configDir (Application Support/in.thecontrarian.manorama.desktop) must use NativeBridge.write0600(to:data:) (atomic temp-file replacement + POSIX 0600 permissions).
	• Respect --config <dir> and --store <path> CLI flags in AppModel.swift so automated tests never touch the user's real catalogue or dump index.
	• Never upload EXIF timestamps, GPS coordinates, or file paths to any remote server.

2. Persistence & Storage Design (Fitting Existing Stores)

A. Declaring the "Raw Dump" Source

• macOS (FolderStore + NativeBridge):
	• Extend FolderStore.Entry (or store a dedicated rawDumpFolderId: UUID? in folders.json / raw-dump.json via write0600) to mark at most one granted folder as the device's designated Raw Dump source (e.g., ~/Google Drive/My Drive/Photos Backup or ~/Proton Drive/Camera Uploads).
	• Reuse NSOpenPanel + ScopedFolder.makeBookmark(for:) in FolderStore so the grant survives app relaunches under the App Sandbox and handles stale bookmarks via renewStaleBookmarks().
	• Note: Unlike normal local galleries (LocalScanner.maxGalleryItems = 1000), a Raw Dump folder spans months or years of camera uploads—do not cap the metadata scan at 1,000 items.
• iOS / iPadOS (PhotoKit):
	• The designated Raw Dump source is the system Photos Library (PHPhotoLibrary), toggled on/off in library-prefs.json (or device.json per device ID). No folder bookmark is needed on iOS.

B. Persisting Computed Event Clusters (events-index.json)

• Store the cached clustering output in configDir as events-index.json (written via NativeBridge.write0600(to:data:)), or add it to NativeBridge.privateFiles if the web bundle reads it directly via read_private_file:
	• Schema should store:
		1. sourceFingerprint: Device ID (stableDeviceId()) + folder bookmark ID (macOS) or "photokit-library" (iOS) + lastIndexedAt timestamp.
		2. itemCache: Compact per-item metadata keyed by relative path (id in LocalScanner.Item) or PHAsset.localIdentifier (timestamp, lat, lon, isScreenshot, fileModTime) so rescans skip unchanged files.
		3. clusters: Array of EventCluster objects (id, startDate, endDate, isMultiDay, itemIds, coverItemId, subDays).

3. Core Pipeline Architecture

Implement the engine in a shared Swift module/directory (e.g., native/EventClustering/ or shared between macos/ManoramaMac/ and ios/) with zero UIKit/AppKit dependencies in the clustering core:

Step 1: Lightweight Metadata Ingestion Adapters

• Shared Supported Extensions: Reuse LocalScanner.imageExtensions (["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"]).
• macOS Adapter (FolderDumpScanner):
	• Walk the security-scoped Raw Dump root (including nested year/month subfolders common in Google Drive/Proton Drive backups, unlike LocalScanner's 1-level cap).
	• Cloud-Placeholder Safety: Google Drive for Desktop and Proton Drive materialize files via macOS File Provider. Never call Data(contentsOf:) or NSImage(contentsOf:) during indexing.
	• Use CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) and CGImageSourceCopyPropertiesAtIndex(source, 0, nil) (matching the pattern in NativeBridge.imageDimensions) to read only the header:
		• {Exif}.DateTimeOriginal (parsed with {Exif}.OffsetTimeOriginal if present, falling back to URLResourceKey.creationDateKey / .contentModificationDateKey).
		• {GPS}.Latitude, {GPS}.LatitudeRef, {GPS}.Longitude, {GPS}.LongitudeRef.
		• {TIFF}.Make / {TIFF}.Model (used to distinguish real camera photos from PNG/HEIC screenshots).
• iOS / iPadOS Adapter (PhotoKitDumpScanner):
	• Fetch PHAsset.fetchAssets(with: .image, options: ...) sorted by creationDate.
	• Read asset.creationDate, asset.location?.coordinate, asset.mediaSubtypes.contains(.photoScreenshot), and asset.burstIdentifier directly from PHAsset metadata (0 disk I/O).

Step 2: Deterministic Spatiotemporal Clustering (EventClusterer)

Run a 3-pass pure-Swift algorithm on the extracted MediaMetadataItem list:
1. Hygiene & Burst Pass:
	• Route isScreenshot == true items into a separate screenshots bucket so screen captures never split real-world events.
	• Collapse rapid-fire shots (Δt < 3.0s and identical/nil GPS) into a single representative frame for cluster density calculations while keeping all itemIds in the event.
2. Pass 1 — Home-Base Inference:
	• Bin all items with valid GPS into ~10 km grid cells (round(lat * 10) / 10, round(lon * 10) / 10).
	• The highest-count grid cell is inferred as Home Base (completely offline, zero reverse-geocoding required).
3. Pass 2 — Atomic Sessionization (Separates Evening Outings from Next-Day Activity):
	• Sort items chronologically. Start a new AtomicSession when:
		• Time gap Δt > 3.5 hours, OR
		• Both items have GPS and Haversine distance Δd > 5.0 km (unless Δt < 45 minutes, indicating continuous transit).
4. Pass 3 — Multi-Day Trip Merging:
	• Merge consecutive AtomicSession clusters (S_i, S_{i+1}) into a single multi-day EventCluster when both sessions are > 50 km from Home Base and the overnight gap between them is < 18 hours. Preserve individual days as subDays inside the cluster.

4. Bridge Commands (NativeBridge.swift & LocalSchemeHandler.swift)

Expose clean, Tauri-compatible invoke commands in NativeBridge.run(_:args:headers:) so the web bundle drives the feature identically across platforms:

Command Name	Args	Behavior
pick_raw_dump_root (macOS) / enable_camera_roll_dump (iOS)	{}	Opens NSOpenPanel (or requests PHPhotoLibrary .readWrite / .authorized permission on iOS), saves bookmark in FolderStore, marks as Raw Dump root.
get_raw_dump_status	{}	Returns { configured: Bool, label: String?, lastIndexedAt: Int?, eventCount: Int } without leaking raw paths unless permitted.
scan_raw_dump_events	{ force?: Bool }	Runs incremental metadata scan off-main (offMain), updates events-index.json via write0600, and returns the EventCluster[] manifest.
clear_raw_dump_root	{}	Unmarks the Raw Dump source and deletes events-index.json.

• Serving Clustered Thumbnails/Originals: Existing LocalSchemeHandler already serves any image inside grantedRoots.all(). Because the macOS Raw Dump folder is registered in FolderStore and grantedRoots, the WKWebView viewer can immediately render event covers and open any clustered event in the existing photostrip/grid viewer with zero changes to media streaming.

5. Verification & Testing Plan (Matching Repo Patterns)

1. Pure Swift Unit Tests (XCTest):
	• Test EventClusterer with synthetic timelines:
		• Evening dinner + drinks (7:30 PM – 11:30 PM, 2 km apart in Home City) → 1 Event.
		• Morning hike + evening dinner in Home City (separated by 6 hours) → 2 Events.
		• 4-day trip 300 km from Home Base with 10-hour overnight gaps → 1 Multi-Day Event with 4 subDays.
		• Screenshots interspersed mid-dinner → Excluded from splitting the dinner event.
2. CLI Test Seam Parity (AppModel.swift / NativeBridge.swift):
	• Support --config <dir> and --store <path> in all new persistence tests so events-index.json and folders.json are isolated in temporary directories and verified to have 0600 file permissions.
3. Cloud Placeholder Safety Check:
	• Verify on macOS that scanning a directory containing zero-byte or unhydrated File Provider items falls back gracefully to file resource dates without blocking or triggering downloads.
