# Event clustering: the bridge contract

One page, because there is one interface and three implementations of it:
the macOS SwiftUI shell (`macos/ManoramaMac/`), the iOS Capacitor shell
(`ios/App/App/`), and, later, the Rust shell in `src-tauri/`. The web
bundle drives all of them through the same Tauri-compatible `invoke`
command names, so a command listed here means the same thing on every
device, and a page written against it never forks per platform.

The engine behind the commands is `native/EventClustering/` — pure
Foundation Swift, deterministic, no ML packages, no network. See
`docs/PLAN-Event-Clustering-Camera-Roll.md` for why the boundaries sit
where they do.

---

## 1. What is being grouped, and by whom

Event clustering runs on exactly **one user-declared raw dump per device**:

| Platform | Source | Item id |
| :--- | :--- | :--- |
| macOS | one security-scoped folder (a Drive/Proton/iCloud camera backup) | path relative to that folder, e.g. `2026/03/IMG_4821.jpg` |
| iOS / iPadOS | the system Photos library | `PHAsset.localIdentifier` |

Normal curated galleries are never re-grouped: they are already curated.
Gallery roots scan only their top level. The user-declared raw dump alone
recurses: its subfolders are never published. A folder cannot be both a
gallery root and the dump. Declaring either while the other exists is
rejected, including aliases resolving to the same folder.

Everything below is computed on-device. No timestamp, coordinate,
thumbnail, folder path or item id is ever sent to a server. The
`/api/*` surface does not gain a single route for this feature, and the
D1 schema does not gain a single column.

---

## 2. Types

Epoch **milliseconds** everywhere on the wire. The Swift index stores
seconds (`EventIndex`'s codable strategy) and the bridge multiplies by
1000 on the way out; one conversion, in one place, per platform.

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
  /** `evt_` + 20 hex: sha256(sourceId | startDateSeconds). Stable across
   *  rescans, so a viewer open on an event survives a re-index. */
  id: string
  startDate: number
  endDate: number
  isMultiDay: boolean
  coverItemId: string
  /** Every member, chronological. Burst frames included — the collapse
   *  chooses a cover, it never deletes a photograph. */
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
  /** The dump root, for `assetUrl(joinPath(rootPath, itemId))` only. */
  rootPath: string | null
}

type RawDumpPick = {
  label: string
  itemCount: number
  /** Absolute dump root on macOS; null on iOS, where the source is the
   *  system library and a `PHAsset.localIdentifier` needs no joining. */
  rootPath: string | null
}
```

`rootPath` is the one field that looks like a leak and is not. It is
device-local, never serialised into any request: the local catalogue
already stores absolute root paths in `catalogue.json` and
`pick_gallery_root` already returns a path to the renderer. The viewer
needs an absolute path to ask the shell's own media handler for the
original, and the media handler re-checks every request against the
granted roots — a path grants nothing, the bookmark does. `get_raw_dump_status`
carries no path: it is the command a page may poll.

---

## 3. Commands

| Command | Arguments | Returns | Errors |
| :--- | :--- | :--- | :--- |
| `pick_raw_dump_root` | `{}` | `RawDumpPick \| null` (null = the user cancelled) | native failure only |
| `get_raw_dump_status` | `{}` | `RawDumpStatus` | never throws for "not configured" — answers `configured: false` |
| `scan_raw_dump_events` | `{ force?: boolean }` | `RawDumpScanResult` | throws when no root is configured, or the root cannot be reached |
| `clear_raw_dump_root` | `{}` | `null` | — |
| `get_event_asset_image` / Capacitor `getEventAssetImage` | `{ ids: string[], purpose: 'thumbnail' \| 'viewer', maxPixelSize?: number, allowNetwork?: boolean }` | `{ items: EventAssetImage[] }` | invalid arguments; no declaration or Photos grant |

`EventAssetImage` is `{ id, url: string | null, width, height, state }`, where
`state` is `ready | cloudOnly | downloading | failed | missing`. At most 64
unique opaque source ids per request; ids are nonempty, at most 4096 characters,
without controls, absolute prefixes, backslashes or `.` / `..` / empty path
segments. Exactly one ordered reply per requested id, including missing assets.
Only `ready` carries a URL and positive intrinsic pixel dimensions. Other states
carry a null URL (zero dimensions when the asset is unknown). The renderer
validates private `file:///` URLs before `convertFileSrc`; no HTTP media endpoint.

Thumbnails use opportunistic/fast PhotoKit requests, **never network**, with a
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
Never use a thumbnail as an original-sized stage image.

Capacitor lifecycle extensions (other shells need not offer iCloud download):

| Method / event | Payload | Semantics |
| :--- | :--- | :--- |
| `cancelEventAssetImage` | `{ ids: string[] }` → `null` | cancel PhotoKit data/image requests immediately; close and remove partial and completed temp copies; ignore subsequent chunks, progress and completion |
| `releaseEventAssetImages` | `{ urls: string[] }` → `null` | unlink only issued viewer URLs, never cache paths or arbitrary files; idempotent |
| `setEventCloudDownload` | `{ enabled: boolean }` → `null` | device-only preference, default false; grants no network access by itself |
| `presentLimitedLibraryPicker` | `{}` → `null` | system picker on the main thread, only when permission is limited |
| `openEventPhotosSettings` | `{}` → `null` | public app Settings URL |
| `openEventAssetInPhotos` | `{ id: string }` → `null` | public Photos application URL; no private per-asset URL API |
| `eventAssetProgress` | `{ id: string, fraction: number }` | fraction in [0,1], only for an active explicitly requested original |
| `eventLibraryChanged` | `{}` | declaration, permission, preference or Photos membership changed; invalidate and rescan, never carries ids |

The cheap status adds optional `authorization: 'notDetermined' | 'denied' |
'restricted' | 'limited' | 'authorized'`, `selectedPhotoCount: number | null`,
and `downloadCloudOnOpen: boolean`. The selected count is a mirrored scan/pick
count, null before selection; status itself never fetches photographs. The
authorization field is a live OS permission read, not an asset request. These
fields are absent on older/non-Photos shells.

`allowNetwork` defaults to false. True is accepted **only** for `purpose:
'viewer'` with one id: an explicit current-photo open/download, never a batch.
Even with the preference on, thumbnails and indexing cannot download. The OS
uses the user's iCloud account, not a Manorama endpoint. Each expensive,
constrained or not-yet-known network path requires a native confirmation before
starting that one download. Cancellation/clear also retire pending confirmations.
The native owner queue retains PhotoKit's `PHAssetResourceDataRequestID` and calls
`cancelDataRequest` on cancellation, clear and service close. It closes/removes
the partial file immediately and retires the promise once; late callbacks cannot
write more bytes, report progress or publish a cancelled copy.

Semantics that all three shells owe each other:

* **`pick_raw_dump_root`** replaces any previous raw dump. macOS opens the
  `NSOpenPanel`, marks the chosen `FolderStore.Entry` with
  `isRawDump = true`, clears the flag on every other entry, records the
  root in `roots.json`, and persists the grant as a security-scoped
  bookmark. iOS asks for `.readWrite` photo permission, records
  the declaration in native-owned `Application Support/EventClustering/source-state.json`, and answers
  `label: "Camera Roll"`, `rootPath: null` — there is no path on iOS, and
  the viewer resolves `PHAsset.localIdentifier` through the existing
  asset-protocol path.
* **`get_raw_dump_status`** is the only cheap command: it reads the store
  and the index header, touches no photographs, and is safe to call on
  every mount.
* **`scan_raw_dump_events`** runs off the main thread. Incremental by
  default: it re-reads EXIF headers only for files whose modification
  time moved (`EventIndex.needsMetadataRead`), and `force: true` rebuilds
  the metadata cache from scratch. The clustering pass itself always
  covers the whole timeline — it is in-memory arithmetic over 50,000 tiny
  records and costs milliseconds; the expensive thing on a backup folder
  is the byte-reading, and that is what the cache exists to avoid.
* **`clear_raw_dump_root`** unmarks `isRawDump`, deletes
  `events-index.json`, and leaves the folder grant alone. The same root may
  be added as a gallery only after this declaration is cleared. Un-granting
  a folder is a different action and stays in the folder's own UI.

---

## 4. `events-index.json`

Written into `configDir` (`Application Support/in.thecontrarian.manorama.desktop`
on macOS; `Application Support/EventClustering/events-index.json` on iOS)
through the shell's atomic `0600` writer, never through `write_private_file`,
and deliberately **not** added
to the private-file allowlist: the page reads events from the scan
command's answer, not from the file, so the index stays a cache the shell
owns rather than a second source of truth a renderer can write.

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

A fingerprint mismatch (`deviceId`, `sourceId`, or `schemaVersion`) means
the index belongs to a different source or an older engine: the shell
rebuilds instead of merging. Dates here are epoch **seconds**, matching
`EventIndex`'s codable strategy; only the wire format uses milliseconds.

---

## 5. Cover and day rules the UI can rely on

* `coverItemId ∈ itemIds`, always.
* A screenshot is never a cover and never a member of an event.
* `subDays` is non-empty exactly when `isMultiDay`, and one entry per
  local calendar day the event spans.
* Events are returned in chronological order, oldest first.
* `itemIds` are chronological, which means the viewer can open an event
  at index 0 and page forward through it like any other gallery.

The UI's job is presentation only: date span, frame count, cover
thumbnail, a multi-day badge, and sub-day tabs. It never receives, and
must never show, a classification label.

One caveat on "cover thumbnail": on macOS it is a solved problem, because
the dump root is a granted folder and the shell's media handler already
answers absolute paths inside it. On iOS a member id is a
`PHAsset.localIdentifier`, which is not a URL and has no route to the page
yet. See §7 item 2 — an event that cannot show a photograph is not
shippable on that platform, however correct its clustering is.

---

## 6. Where each shell hooks in

The four names and their payloads are the contract. What is *not* shared is
the bundle: the repository ships two web roots, and each shell loads its
own, so "one page drives both" would be wrong and the table below is the
accurate version.

* `desktop/` is the macOS bundle (staged into `Resources/ViewerBundle`). It
  reaches the commands through `invoke` in `desktop/lib/event-clustering.ts`.
* `native/` is what the Capacitor shells serve — `webDir: 'native/dist'` —
  and it does not import the desktop islands' event UI today. Its own call
  path for an app-local plugin is `registerPlugin('EventClustering')`, the
  pattern `native/lib/local-gallery.ts` already uses for `LocalGallery`.

Both bundles must speak the same four commands with the same payloads; that
is what keeps the engine's answer from being interpreted differently per
device. A shared presentation layer is possible — `native/islands/` already
imports from `desktop/lib` — but it is not what exists now.

| Shell | Entry point | Method name on the native side |
| :--- | :--- | :--- |
| macOS (`macos/ManoramaMac`) | `NativeBridge.run` command switch | the snake_case names verbatim |
| iOS / iPadOS (`ios/App/App`) | `SceneDelegate.viewDidLoad` → `bridge?.registerPluginInstance(EventClusteringPlugin())`, which is also what calls the plugin's `load()` | camelCase: `pickRawDumpRoot`, `getRawDumpStatus`, `scanRawDumpEvents`, `clearRawDumpRoot`, under `jsName` `EventClustering` |
| Tauri desktop (`src-tauri`) | not implemented | none — see below |
| Android (`android/`) | not implemented | none — see §7 |

`registerPluginInstance` is the only registration path that works for an
app-local plugin in this target: `LocalGalleryPlugin` is registered the same
way, and a plugin that is compiled into the app but never registered is
simply absent from `window.Capacitor.Plugins`.

**Known gap.** `src-tauri/src/lib.rs` registers its commands explicitly, and
none of the four are among them. A page running in the Tauri build therefore
gets a rejection from `invoke`, which is the same answer as "this shell does
not do this": the raw-dump UI stays hidden rather than rendering a control
that can only error. Adding the four commands to the Tauri shell is separate
work and must reuse the same `native/EventClustering` sources, not a
reimplementation.

---

## 7. Open work per surface

Where the feature actually stands, so that "available everywhere" is a
checklist rather than an assumption. Ordered by what unblocks the most.

| Surface | Bundle loaded | Engine | Four commands | Event UI | Pixels for a member |
| :--- | :--- | :--- | :--- | :--- | :--- |
| macOS | `desktop/` | linked into the binary | all four | Library section + Settings row | granted root, `manorama://media/local/…` |
| iOS / iPadOS | `native/dist` | compiled into the target | all commands | Library Camera Roll mode + Settings folder row | bounded PhotoKit thumbnails; explicit unchanged-original streaming |
| Android | `native/dist` | **absent** (Swift only) | none | none | n/a |
| Tauri desktop | `desktop/` | **absent** (Swift only) | none | hidden by design | n/a |
| Web app | `app/` | n/a | n/a | none, per invariant 7 | n/a |

**Traversal policy reconciled.** The root-only rule in
`docs/manorama-operations.md` explicitly exempts the declared dump. The
macOS boundary suite runs both scanners over the same nested tree and
checks picker, catalogue-write and drop-batch source conflicts, including
symlink aliases at the picker and catalogue boundaries.

1. **Mobile event UI (`native/`, implemented in slice 2).** Library
   Settings contains one folder declaration/clear row. A capability-gated
   Camera Roll pill beside Add Gallery mounts the event controller and replaces
   the gallery-list pane with event cards only while active; the ordinary
   Library mounts no event controller and performs no scan. Cards open the
   existing viewer, and closing it returns to the active Camera Roll list.
   The pure presentation maths and validators are platform-free in
   `packages/core/event-clustering.ts`, so this remains a port of layout rather
   than clustering logic.
2. **An iOS pixel route (implemented in slice 2).** Thumbnail requests are
   addressed by `PHAsset.localIdentifier` at a bounded pixel size and always
   disable iCloud network access. Viewer originals stream unchanged through
   `PHAssetResourceManager.requestData`; only the explicitly opened current
   photo may request network after separate confirmation, and real PhotoKit
   cancellation stops the transfer. The fifth-method contract deliberately
   remains separate from the four source commands because it moves pixels
   rather than describing them.
3. **Traversal policy (completed in slice 1).** The bullet under
   "Source link expectations" in `docs/manorama-operations.md` states that
   only the top level of a folder is scanned and subfolders are not
   descended into, and `fix(gallery): scan folder roots only` made that
   structural for local folders as well — "the behavior is structural, not
   configurable". The raw dump descends by design, because a Drive backup
   laid out `YYYY/MM/` is the case the feature exists for; the plan's macOS
   ingestion section argued the exemption at the time, but a reader following
   the runbook would find nothing acknowledging it. The fix is one clarifying
   sentence naming a
   user-declared raw dump as a distinct concept from a scanned gallery root
   — the two rules are not in conflict, but they look that way. Left as a
   decision rather than edited here, because it touches the contract that
   commit deliberately just tightened.
4. **Tauri and Android need the engine outside Swift.** The core has no
   platform imports beyond Foundation and CryptoKit, which is what makes the
   plan's "portable later to Rust/TS" realistic, but nothing has been
   ported: `packages/core/event-clustering.ts` holds wire types, validators
   and labels, not the clusterer. Until one of those ports exists, these two
   surfaces should stay silent rather than half-implemented.
