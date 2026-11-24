# Event clustering: the bridge contract

One device-local interface, shared by the macOS Swift shell, the iOS Capacitor
shell and the Tauri desktop shell. Android will consume the same wire contract
through a thin Kotlin plugin and the portable Rust engine.

The repository has two web roots. `desktop/` is loaded by the macOS and Tauri
shells; `native/dist` is loaded by Capacitor. They share the platform-free
types, validators and presentation helpers in `packages/core/event-clustering.ts`,
but each owns its transport and island components.

The engines are Swift (`native/EventClustering/`) on Apple surfaces and Rust
(`crates/event-clustering/`) on Tauri and, later, Android. Neither engine uses
ML or network access. See `docs/PLAN-Event-Clustering-Camera-Roll.md` for why
these boundaries sit where they do.

---

## 1. What is being grouped, and by whom

Event clustering runs on exactly **one user-declared raw dump per device**:

| Platform | Source | Item id |
| :--- | :--- | :--- |
| macOS | one security-scoped folder (a Drive/Proton/iCloud camera backup) | path relative to that folder, e.g. `2026/03/IMG_4821.jpg` |
| Windows / Linux (Tauri) | one picker-approved folder | path relative to that folder |
| iOS / iPadOS | the system Photos library | `PHAsset.localIdentifier` |
| Android (planned) | MediaStore selection | MediaStore id |

Normal curated galleries are never re-grouped. Gallery roots scan only their
top level. The user-declared raw dump alone recurses: its subfolders are never
published. A folder cannot be both a gallery root and the dump. Declaring
either while the other exists is rejected, including canonical and symlink
aliases resolving to the same folder.

Everything below is computed on-device. No timestamp, coordinate, thumbnail,
folder path or item id is sent to a server. The `/api/*` surface gains no route
for this feature, and the D1 schema gains no column.

### Library presentation

The ordinary Library contains no event cards and performs no event scan.
Library Settings owns one compact Camera Roll folder declaration/clear action.
A capability-gated **Camera Roll** pill sits beside **Add Gallery**. Activating
it mounts the event controller and replaces only the gallery-list contents
with event cards; the brand/control rail remains. Opening Settings unmounts the
controller. Events open in the shared Viewer and return to the still-active
Camera Roll list.

The pill performs only the cheap capability/status probe. Scanning begins when
Camera Roll mode is activated, not when Settings declares or clears a folder.

---

## 2. Types

Epoch **milliseconds** everywhere on the wire. The Swift and Rust indexes store
seconds and their shell adapters multiply by 1000 on output.

```ts
/** packages/core/event-clustering.ts */
type EventDayGroup = {
  /** `YYYY-MM-DD` in the capture calendar; unique inside an event. */
  id: string
  /** First frame of that day, epoch ms. */
  date: number
  itemIds: string[]
}

type EventCluster = {
  /** `evt_` + 20 hex: sha256(sourceId | startDateSeconds). */
  id: string
  startDate: number
  endDate: number
  isMultiDay: boolean
  coverItemId: string
  /** Every member, chronological. Burst frames included. */
  itemIds: string[]
  /** Present exactly when `isMultiDay`. */
  subDays?: EventDayGroup[] | null
}

type RawDumpStatus = {
  configured: boolean
  label: string | null
  /** Configured and reachable: an unmounted drive is configured, not available. */
  isAvailable: boolean
  /** Epoch ms, or null when never indexed. */
  lastIndexedAt: number | null
  eventCount: number
}

type RawDumpScanResult = {
  clusters: EventCluster[]
  screenshotCount: number
  /** Diagnostic source information only; never a media URL or filesystem grant. */
  rootPath: string | null
}

type RawDumpPick = {
  label: string
  itemCount: number
  /** Absolute dump root on desktop; null on iOS. Never media-URL authority. */
  rootPath: string | null
}

type EventAssetState = 'ready' | 'cloudOnly' | 'downloading' | 'failed' | 'missing'
type EventAssetImage = {
  id: string
  url: string | null
  width: number
  height: number
  state: EventAssetState
}
type EventAssetRequest = {
  ids: string[]
  purpose: 'thumbnail' | 'viewer'
  maxPixelSize?: number
  allowNetwork?: boolean
}
type EventAssetProgress = { id: string; fraction: number }
```

`rootPath` is diagnostic only. The renderer must never join it to an item id,
construct an original-file URL from it, or treat it as a grant. Event media URLs
come only from a validated `get_event_asset_image` reply.

---

## 3. Commands

| Command | Arguments | Returns | Errors |
| :--- | :--- | :--- | :--- |
| `pick_raw_dump_root` | `{}` | `RawDumpPick \| null` (null = cancelled) | native failure only |
| `get_raw_dump_status` | `{}` | `RawDumpStatus` | never throws for "not configured" |
| `scan_raw_dump_events` | `{ force?: boolean }` | `RawDumpScanResult` | throws when unconfigured, unavailable or indexing fails |
| `clear_raw_dump_root` | `{}` | `null` | native failure only |
| `get_event_asset_image` | `EventAssetRequest` | `{ items: EventAssetImage[] }` | invalid request, unavailable source or native read failure |
| `reveal_event_asset` | `{ id: string }` | `null` | invalid id, missing member or reveal failure |

Semantics shared by the shells:

* **`pick_raw_dump_root`** replaces any previous raw dump. macOS opens the
  `NSOpenPanel`, marks one `FolderStore.Entry` as the dump, clears the flag on
  every other entry and persists a security-scoped bookmark. Tauri accepts only
  a directory returned by its native picker/drop provenance, rejects gallery
  roots and aliases before committing, and stores a Rust-only declaration. iOS
  records the system library as `label: "Camera Roll"`, `rootPath: null`.
  Selection itself performs no scan and loads no preview.
* **`get_raw_dump_status`** is the only cheap command: it reads the store and
  memoized index summary, touches no photograph bytes and is safe on mount.
* **`scan_raw_dump_events`** runs off the main thread. Incremental by default:
  it re-reads headers only for files whose metadata requires it. `force: true`
  rebuilds the metadata cache. Clustering always covers the whole timeline.
* **`clear_raw_dump_root`** removes the declaration and `events-index.json`,
  stops its watcher and leaves folder grants alone. The same folder may become
  a gallery only after the declaration is cleared. Clearing never modifies the
  provider or source folder.
* A source revision invalidates in-flight scans and asset replies. A late scan
  cannot repopulate a cleared or replaced source, and a late asset reply cannot
  become a URL under a new declaration.

### `get_event_asset_image`

Batch cap: **64** distinct, non-empty source-relative ids. `purpose` is
`thumbnail` or `viewer`; `maxPixelSize`, when present, is an integer from 1 to
8192. Replies contain exactly one item per requested id, in request order.

A `ready` item has a native-produced URL and positive intrinsic width and
height. Every other state has `url: null` and non-negative dimensions. The
renderer validates the complete reply before using any URL.

* **macOS and Tauri:** `purpose` and `maxPixelSize` are presentation hints only.
  The shell returns an opaque, native-issued lease after authorization and a
  bounded metadata-only header read. It creates no thumbnail, never resizes or
  re-encodes, and never decodes bitmap pixels. `allowNetwork: true` is rejected;
  cloud placeholders return `cloudOnly`. The renderer never derives a path from
  the lease or from `rootPath`.
* **iOS:** thumbnail replies reference the protected on-device thumbnail cache;
  viewer replies reference the original bytes in a protected temporary file.
  Thumbnail generation is bounded by both target and source dimensions. Viewer
  originals are never re-encoded. Temp files and cancelled requests are released
  when the viewer closes.
* **iCloud-only iOS assets:** default requests use `allowNetwork: false` and
  return `cloudOnly`. Only an explicit viewer request may opt into the OS
  download, with Low Data/cellular consent and `eventAssetProgress` updates.
  Indexing and thumbnails never download.
* **Android:** planned. MediaStore supplies metadata; the Kotlin bridge will
  call the Rust core and follow the same reply validation and no-implicit-
  download rule.

### Desktop verified-lease protocol

Desktop URLs contain no filesystem pathname:

| Shell | Exact ready URL |
| :--- | :--- |
| macOS / Linux | `manorama-event://localhost/<32 lowercase or uppercase hex>` |
| Windows | `http://manorama-event.localhost/<32 lowercase or uppercase hex>` |

Credentials, ports, queries, fragments, extra path segments, encoded characters,
non-hex tokens and wrong-length tokens are rejected. The native lease registry is
bounded and process-local. Swift uses capacity 128 with a 30-minute TTL; Rust uses
FIFO capacity 256 with no TTL. Both revoke by source generation, and tokens are
128-bit random, so this is a documented parity difference rather than a pathname
or token-guessing gap. Each lease retains the selected root identity, a pinned
parent directory handle, the leaf name, expected leaf device/inode identity and
MIME type. Every protocol read revalidates those identities and reopens the leaf
through the pinned parent with no-follow semantics. Replacing the root, an
ancestor or the leaf revokes the lease.

The asynchronous custom protocol supports `GET` and `HEAD`, unchanged original
bytes, one bounded byte range including suffix and open-ended ranges, truthful
`Content-Range`, `416` for unsatisfiable ranges and `405` for other methods.
Responses use `Cache-Control: private, no-store` and `X-Content-Type-Options:
nosniff`. Multi-range requests are refused. The renderer uses bounded range reads
for embedded metadata and never converts a lease into a filesystem URL.

### `reveal_event_asset`

Desktop-only metadata action. It validates the id under the active dump grant,
permits local and cloud-placeholder members without reading their bytes, and
asks Finder/Explorer to reveal only that declared member. It neither downloads
nor opens the photograph. The shell retains the verified root/directory/leaf
identities, revalidates them immediately before the OS call, and fails closed on
replacement. Finder/Explorer's public APIs accept pathnames rather than pinned
handles, so a race after the OS accepts that pathname remains unavoidable and is
not described as atomic. iOS uses its own explicit Photos action instead.

### iOS auxiliary plugin methods

The Capacitor plugin additionally exposes `cancelEventAssetImage`,
`releaseEventAssetImages`, `setEventCloudDownload`,
`presentLimitedLibraryPicker`, `openEventPhotosSettings` and
`openEventAssetInPhotos`. These are native capabilities, not commands the Tauri
or macOS shells must implement.

---

## 4. `events-index.json`

Written into the shell's private config directory through its atomic protected
writer, never through the renderer-writable private-file allowlist. The page
reads events from command replies, not from this file.

```jsonc
{
  "schemaVersion": 1,
  "source": { "deviceId": "…", "sourceId": "…", "sourceKind": "folder", "label": "Photos Backup", "lastIndexedAt": 1764000000 },
  "config": { "sessionGapHours": 3.5, "…": "the ClusteringConfig that made these events" },
  "itemCache": { "2026/03/IMG_4821.jpg": { "id": "…", "timestamp": 1773000000, "latitude": 18.51, "longitude": 73.85, "isScreenshot": false, "burstIdentifier": null, "fileModTime": 1773000123 } },
  "events": [ … EventCluster … ],
  "screenshotItemIds": [ … ]
}
```

A fingerprint mismatch (`deviceId`, `sourceId`, or `schemaVersion`) means the
index belongs to another source or engine: the shell rebuilds instead of
migrating. Dates here are epoch **seconds**; only the wire uses milliseconds.
Unknown schema versions are discarded.

---

## 5. Cover and day rules the UI can rely on

* `coverItemId ∈ itemIds`, always.
* A screenshot is never a cover or event member.
* `subDays` is non-empty exactly when `isMultiDay`, with one representative per
  local calendar day the event spans.
* Events are chronological, oldest first.
* `itemIds` are chronological; the Viewer opens at the requested index and
  pages through the event like a gallery.
* The UI presents date span, frame count, cover, multi-day badge and day entry
  points. It never receives or shows a semantic classification label.
* Covers and picker thumbnails are lazy and intrinsically sized. A bitmap is
  never rendered larger than its intrinsic pixels.

---

## 6. Where each shell hooks in

| Shell | Bundle | Engine | Transport / registration | State |
| :--- | :--- | :--- | :--- | :--- |
| macOS (`macos/ManoramaMac`) | `desktop/` | Swift | `NativeBridge` snake_case commands | implemented |
| Windows / Linux (`src-tauri`) | `desktop/` | Rust | Tauri `invoke`, explicit `generate_handler!` | implemented |
| iOS / iPadOS (`ios/App/App`) | `native/dist` | Swift | `registerPluginInstance(EventClusteringPlugin())`, camelCase methods under `EventClustering` | implemented |
| Android (`android/`) | `native/dist` | Rust via JNI | planned Kotlin Capacitor plugin | pending |
| Web app (`app/`) | `app/` | none | none | absent by invariant 7 |

`desktop/lib/event-clustering.ts` dynamically imports Tauri's `invoke` and
`listen`. `native/lib/event-clustering.ts` uses Capacitor's `registerPlugin`.
Both validate replies through `packages/core`; neither interprets a renderer
path as native authorization.

---

## 7. Verification status and remaining gates

Implemented and locally verified:

* Swift engine, macOS boundary and iOS Camera Roll mode.
* Portable Rust engine with Swift golden-fixture parity.
* Tauri private declaration/index/provenance, scanner, watcher and six commands.
* Persisted selected-root identity, pinned no-follow member authorization, opaque
  desktop leases, asynchronous original-byte protocol reads and reveal handoff
  revalidation in Rust; matching Swift asset/reveal commands and boundary tests.
* Desktop pill, Settings action, conditional right-rail event list, shared
  Viewer, lazy intrinsic covers, cloud placeholders, source-revision races,
  modal-drop blocking and bounded cover-cancellation retries.

Independent round-3 reviewer `qfmodel` returned **“Verdict: APPROVED as a local
checkpoint.”** P1/P2/P3 are closed. The desktop renderer accepts only exact opaque
lease URLs; shared-core file-URL support remains for iOS. The tracked Swift suites
pass 262 checks, including a real headless `WKWebView` using the production
configuration and an issued `manorama-event` URL that served unchanged original
bytes.

The broad Playwright run remains red (61 failed, 386 passed, 8 skipped). A
same-environment clean-base comparison reproduced 60 exact failures; the sole
Slice-4-only observation and two base-only observations passed an isolated warm
base rerun. No Slice 4-specific regression is demonstrated, but the matrix is not
green. Synthetic browser evidence, real headless WKWebView protocol evidence and
partial signed/unsandboxed native GUI evidence are recorded separately.

Still gated:

* Complete six-state native release evidence from a packaged sandboxed app; the
  current 3456×2168 synthetic evidence covers the event rail, Viewer, picker and
  Library Settings controls only.
* Android NDK/JNI/Kotlin/MediaStore implementation and physical-device checks.
* Real iCloud-only behavior, Low Data/cellular consent and locked-device checks.
* 50,000-item performance budgets, localization and accessibility sweep.
* Windows/Linux packaged-app runs and the cross-surface verification script.
