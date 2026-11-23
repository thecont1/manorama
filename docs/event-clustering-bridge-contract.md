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
  rootPath: string
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

Semantics that all three shells owe each other:

* **`pick_raw_dump_root`** replaces any previous raw dump. macOS opens the
  `NSOpenPanel`, marks the chosen `FolderStore.Entry` with
  `isRawDump = true`, clears the flag on every other entry, records the
  root in `roots.json`, and persists the grant as a security-scoped
  bookmark. iOS asks for `.readWrite` photo permission, records
  `cameraRollDumpEnabled` in `library-prefs.json`, and answers
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
  `events-index.json`, and leaves the folder grant alone if the user also
  added it as a normal gallery. Un-granting a folder is a different action
  and stays in the folder's own UI.

---

## 4. `events-index.json`

Written into `configDir` (`Application Support/in.thecontrarian.manorama.desktop`
on macOS; the app container on iOS) through the shell's atomic `0600`
writer, never through `write_private_file`, and deliberately **not** added
to the private-file allowlist: the page reads events from the scan
command's answer, not from the file, so the index stays a cache the shell
owns rather than a second source of truth a renderer can write.

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
