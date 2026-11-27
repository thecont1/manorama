# Event clustering: the bridge contract

One device-local interface, shared by the macOS Swift shell, the iOS Capacitor
shell, the Android Capacitor shell and the Tauri desktop shell. Android consumes
the same wire contract through a thin Kotlin plugin and the portable Rust engine.

The repository has two web roots. `desktop/` is loaded by the macOS and Tauri
shells; `native/dist` is loaded by Capacitor. They share the platform-free
types, validators and presentation helpers in `packages/core/event-clustering.ts`,
but each owns its transport and island components.

The engines are Swift (`native/EventClustering/`) on Apple surfaces and Rust
(`crates/event-clustering/`) on Tauri and Android. Neither engine uses
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
| Android | MediaStore selection | MediaStore id |

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
| `get_raw_dump_status` | `{}` | `RawDumpStatus` | never throws for "not configured" — answers `configured: false` |
| `scan_raw_dump_events` | `{ force?: boolean }` | `RawDumpScanResult` | throws when unconfigured, unavailable or indexing fails |
| `clear_raw_dump_root` | `{}` | `null` | native failure only |
| `get_event_asset_image` / Capacitor `getEventAssetImage` | `{ ids: string[], purpose: 'thumbnail' \| 'viewer', maxPixelSize?: number, allowNetwork?: boolean }` | `{ items: EventAssetImage[] }` | invalid arguments; no declaration or media grant |
| `reveal_event_asset` | `{ id: string }` | `null` | desktop only: invalid id, missing member or reveal failure |

`EventAssetImage` is `{ id, url: string | null, width, height, state }`, where
`state` is `ready | cloudOnly | downloading | failed | missing`. At most 64
unique opaque source ids per request; ids are nonempty, at most 4096 characters,
without controls, absolute prefixes, backslashes or `.` / `..` / empty path
segments. Exactly one ordered reply per requested id, including missing assets.
Only `ready` carries a URL and positive intrinsic pixel dimensions. Other states
carry a null URL (zero dimensions when the asset is unknown). The renderer
validates native-issued private URLs before use; no HTTP media endpoint or
renderer-joined pathname is permitted.

iOS thumbnails use opportunistic/fast PhotoKit requests, **never network**, with a
physical-pixel long-edge cap of 512 and no target larger than the source. One
JPEG per `sha256(id|modificationDate|targetSize)` lives in protected
`Caches/event-thumbs`, with 0600 files and a 200 MB LRU bound. Viewer copies are
original-resource bytes, not thumbnails or renders: `PHAssetResourceManager.requestData`
streams unchanged chunks into an already-0600, completely protected file in
`tmp/event-originals/<lease>/`. Both cache and temporary directories are 0700,
completely protected and explicitly excluded from backup before children are
written; files are explicitly excluded too. Release on close; sweep on launch
and clear. These attributes never change the original Photos library. Simulator
attribute checks do not prove hardware encryption or locked-device behavior.
Never use a thumbnail as an original-sized stage image. Android uses verified
local MediaStore files, an equivalent bounded private thumbnail cache and
byte-for-byte private viewer leases; desktop serves unchanged originals through
opaque native leases.

Capacitor lifecycle extensions (other shells need not offer iCloud download):

| Method / event | Payload | Semantics |
| :--- | :--- | :--- |
| `cancelEventAssetImage` | `{ ids: string[] }` → `null` | cancel native data/image requests immediately; close and remove partial and completed temp copies; ignore subsequent chunks, progress and completion |
| `releaseEventAssetImages` | `{ urls: string[] }` → `null` | unlink only issued viewer URLs, never cache paths or arbitrary files; idempotent |
| `setEventCloudDownload` | `{ enabled: boolean }` → `null` | device-only preference, default false; grants no network access by itself |
| `presentLimitedLibraryPicker` | `{}` → `null` | system picker on the main thread, only when permission is limited |
| `openEventPhotosSettings` | `{}` → `null` | public app Settings URL |
| `openEventAssetInPhotos` | `{ id: string }` → `null` | public Photos application URL; no private per-asset URL API |
| `eventAssetProgress` | `{ id: string, fraction: number }` | fraction in [0,1], only for an active explicitly requested original |
| `eventLibraryChanged` | `{}` | declaration, permission, preference or media membership changed; invalidate and rescan, never carries ids |

The cheap status adds optional `authorization: 'notDetermined' | 'denied' |
'restricted' | 'limited' | 'authorized'`, `selectedPhotoCount: number | null`,
and `downloadCloudOnOpen: boolean`. The selected count is a mirrored scan/pick
count, null before selection; status itself never fetches photographs. The
authorization field is a live OS permission read, not an asset request. These
fields are absent on older/non-Photos shells.

`allowNetwork` defaults to false. True is accepted **only** for `purpose:
'viewer'` with one id: an explicit current-photo open/download, never a batch.
Even with the preference on, thumbnails and indexing cannot download. The OS
uses the user's own provider account, not a Manorama endpoint. Each expensive,
constrained or not-yet-known network path requires a native confirmation before
starting that one download. Cancellation/clear also retire pending confirmations.
The native owner queue cancels active provider requests on cancellation, clear
and service close. It closes/removes the partial file immediately and retires
the promise once; late callbacks cannot write more bytes, report progress or
publish a cancelled copy.

Semantics shared by the shells:

* **`pick_raw_dump_root`** replaces any previous raw dump. macOS opens the
  `NSOpenPanel`, marks one `FolderStore.Entry` as the dump, clears the flag on
  every other entry and persists a security-scoped bookmark. Tauri accepts only
  a directory returned by its native picker, rejects gallery roots and aliases
  before committing, and stores a Rust-only declaration plus separate dump
  approval provenance. That provenance never enters the gallery `roots.json`
  grants or the renderer filesystem/asset scopes. A declaration saved by an
  earlier build without that separate approval fails closed and requires folder
  reselection; it is never migrated from a gallery grant. iOS records the system library
  as `label: "Camera Roll"`, `rootPath: null`.
  Android selects the complete MediaStore library or one bucket and records the
  source in native-owned private state. Selection itself performs no scan and
  loads no preview.
* **`get_raw_dump_status`** is the only cheap command: it reads the store and
  memoized index summary, touches no photograph bytes and is safe on mount.
* **`scan_raw_dump_events`** runs off the main thread. Incremental by default:
  it re-reads headers only for files whose metadata requires it. `force: true`
  rebuilds the metadata cache. Clustering always covers the whole timeline.
* **`clear_raw_dump_root`** removes the declaration and `events-index.json`,
  stops its watcher or observer and leaves provider grants and source files
  alone. The same folder may become a gallery only after the declaration is
  cleared. Clearing never modifies the provider or source folder.
* A source revision invalidates in-flight scans and asset replies. A late scan
  cannot repopulate a cleared or replaced source, and a late asset reply cannot
  become a URL under a new declaration. Desktop serializes clear/change with the
  asset-response handoff, so an already-authorized read cannot answer after clear
  has completed.
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
* **Android:** MediaStore supplies metadata and JNI calls the Rust core.
  Thumbnails decode only verified local files with EXIF orientation, bounded
  downsampling and no upscaling; viewer originals are copied byte-for-byte into
  private leases. A non-local row returns `cloudOnly`. Only an explicit
  single-item viewer request with the preference enabled may stream through
  `ContentResolver`, after native metered-data/power confirmation when required.
  Indexing and thumbnails never invoke a provider.

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
or token-guessing gap. Each lease retains the selected root identity, every
ancestor pathname/device/inode identity, a pinned parent directory handle, the
leaf name, expected leaf device/inode identity and MIME type. Every protocol read
revalidates those identities and reopens the leaf through the pinned parent with
no-follow semantics. Replacing the root, an ancestor or the leaf revokes the
lease.

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

### Mobile auxiliary plugin methods

The Capacitor plugin additionally exposes `cancelEventAssetImage`,
`releaseEventAssetImages`, `setEventCloudDownload`,
`presentLimitedLibraryPicker`, `openEventPhotosSettings` and
`openEventAssetInPhotos`. These are native capabilities, not commands the Tauri
or macOS shells must implement.

---

## 4. `events-index.json`

Written into the shell's private config directory through its atomic protected
writer, never through the renderer-writable private-file allowlist. The page
reads events from command replies, not from this file. macOS uses
`Application Support/in.thecontrarian.manorama.desktop`; iOS uses the dedicated
`Application Support/EventClustering` directory; Android uses
`filesDir/EventClustering`; Tauri uses its isolated config directory.

On iOS the dedicated `EventClustering` directory is 0700, completely protected
and explicitly excluded from backup **before** any child write. Both the index
and tiny `source-state.json` are atomically replaced using already-0600,
completely protected, explicitly backup-excluded staging files. The native state
holds `enabled`, `downloadCloudOnOpen` (default false), `selectedPhotoCount`, and
the mirrored index `header` (`lastIndexedAt` in seconds, `eventCount`). Warm status
reads use cached state plus an index-existence check and the current OS
authorization status; they never fetch Photos assets or decode the index.
No event state belongs to renderer preferences or ordinary `UserDefaults`.
First access removes only the four legacy keys (`manorama.cameraRollDumpEnabled`,
`manorama.cameraRollIndexHeader`, `manorama.eventCloudDownload`,
`manorama.eventSelectedPhotoCount`) and the backup-eligible legacy
`Application Support/events-index.json`. Declaration/download preference and
selected count are retained in protected state; the old index and its header
are discarded and rebuilt, not schema-migrated. Clearing the source deletes the
private index and clears declaration/count/header, retaining the download preference.
Unrelated preferences and their backup policy are untouched.

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
| iOS / iPadOS (`ios/App/App`) | `native/dist` | Swift | `registerPluginInstance(EventClusteringPlugin())`, camelCase methods under `EventClustering` | pending — implementation files are on the [#273](https://github.com/thecont1/manorama/pull/273) branch and absent from checkouts that predate its merge |
| Android (`android/`) | `native/dist` | Rust via JNI | registered Kotlin Capacitor plugin | pending — implementation files are on the [#273](https://github.com/thecont1/manorama/pull/273) branch and absent from checkouts that predate its merge |
| Web app (`app/`) | `app/` | none | none | absent by invariant 7 |

`desktop/lib/event-clustering.ts` dynamically imports Tauri's `invoke` and
`listen`. `native/lib/event-clustering.ts` uses Capacitor's `registerPlugin`.
Both validate replies through `packages/core`; neither interprets a renderer
path as native authorization.

---

## 7. Verification status and remaining gates

Implemented and locally verified:

| Surface | Bundle loaded | Engine | Commands | Event UI | Pixels for a member |
| :--- | :--- | :--- | :--- | :--- | :--- |
| macOS | `desktop/` | Swift, linked into the binary | 5 | Library Camera Roll mode + Settings row | opaque verified `manorama-event` lease |
| iOS / iPadOS | `native/dist` | Swift, compiled into the target | 11 | Library Camera Roll mode + Settings row | bounded PhotoKit thumbnails; explicit unchanged-original streaming |
| Android | `native/dist` | Rust via JNI | 11 | Library Camera Roll mode + Settings row | bounded local thumbnails; byte-for-byte private leases; explicit cloud reveal |
| Tauri desktop | `desktop/` | Rust | 6 | Library Camera Roll mode + Settings row | opaque verified `manorama-event` lease |
| Web app | `app/` | n/a | none | none, per invariant 7 | n/a |

The portable Rust engine passes the Swift golden fixtures. Tauri retains a
private declaration/index/provenance store, scanner, watcher, pinned no-follow
member authorization, opaque leases and reveal revalidation. Desktop and mobile
share lazy intrinsic covers, the existing Viewer, source-revision race guards and
validated native asset replies.

Independent round-3 reviewer returned **“Verdict: APPROVED as a local
checkpoint.”** with 0 P0/P1/P2 findings and three non-blocking P3 observations:
large-response handoff latency, gallery-confined Tauri drag-drop scope, and inert
filesystem-scope drift from pre-release Slice 4 developer declarations. The
desktop renderer accepts only exact opaque lease URLs; shared-core file-URL
support remains for iOS. The tracked Swift suites pass 262 checks, including a
real headless `WKWebView` using the production configuration and an issued
`manorama-event` URL that served unchanged original bytes.

The ordinary Library mounts no event controller and performs no event scan.
Library Settings owns one source declaration/clear action. The capability-gated
Camera Roll pill replaces only the gallery-list pane while active, and closing
the shared Viewer returns to that still-active event list. Event metadata,
paths, identifiers, thumbnails and originals stay on-device.

The raw dump is the documented recursive exception to root-only gallery scans;
it never becomes a gallery source and its subfolders are never published. The
operations runbook and structural root/dump alias checks enforce that distinction.

The broad Playwright run remains red (61 failed, 386 passed, 8 skipped). A
same-environment clean-base comparison reproduced 60 exact failures; the sole
Slice-4-only observation and two base-only observations passed an isolated warm
base rerun. No Slice 4-specific regression is demonstrated, but the matrix is not
green. Synthetic browser evidence, real headless WKWebView protocol evidence and
partial signed/unsandboxed native GUI evidence are recorded separately.

Slice 6 local gates completed:

* `scripts/test-all-surfaces.sh` records PASS/FAIL/SKIP per lane, fails closed and
  passed 17 lanes; Windows is explicitly skipped without a Windows runner.
* TypeScript is clean and 2,757 Bun tests pass. The Rust feature matrix, strict
  Clippy, 78 Swift engine tests and 262 macOS boundary checks pass.
* The real 50,000-file macOS gate completes its initial scan in 4.142 s and an
  unchanged rescan in 0.899 s with zero rescan header reads and 193.50 MB peak
  RSS, below the 300 MB budget.
* Tauri builds cleanly with 48 shell tests and strict Clippy. Focused desktop
  Playwright passes 10/10, including axe, 200% text, reflow and 44 px targets.
* Seeded iPhone and iPad runs each pass 28 XCTest checks. Android passes its JVM,
  packaged JNI and 12-test emulator lanes; both ABI libraries are below 1.5 MiB
  and export all three JNI symbols. The Linux Docker core passes 74 tests.

Owner/device and packaging gates remain unclaimed:

* Complete six-state native release evidence from a packaged sandboxed app.
* Real iCloud-only behavior, Low Data/cellular consent and locked-device checks.
* Physical Pixel partial-access and real VoiceOver/Dynamic Type/TalkBack sweeps.
* Packaged Windows/Linux application runtime evidence; the local Linux lane
  verifies the Rust core only.
