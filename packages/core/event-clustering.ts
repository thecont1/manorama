/**
 * Event clustering — the wire contract's TypeScript half, and the
 * presentation maths the Library builds out of it.
 *
 * The contract is `docs/event-clustering-bridge-contract.md`: one
 * user-declared raw dump per device, epoch **milliseconds** everywhere on
 * the wire, four `invoke` commands, and a page that does nothing but present
 * what the shell computed. Nothing here clusters anything — the engine lives
 * in `native/EventClustering/` and this file mirrors what it answers.
 *
 * Invariant 8: platform-free. No `window`, no Node built-ins, no Capacitor
 * or Tauri. Dates are the only system-observable thing it touches.
 *
 * Every parse degrades instead of throwing. The index the shells hand back
 * is a cache the shell owns — `events-index.json`, never the page's to read
 * or write — so a half-written or future-versioned reply is a fact the
 * Library has to live with, not an exception that may take the rest of the
 * page down with it.
 */

export type EventDayGroup = {
  /** `YYYY-MM-DD` in the capture calendar; unique inside an event. */
  id: string
  /** First frame of that day, epoch ms. */
  date: number
  itemIds: string[]
}

export type EventCluster = {
  /** `evt_` + 20 hex. Stable across rescans. */
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

export type RawDumpStatus = {
  configured: boolean
  label: string | null
  /** Configured and reachable: an unmounted drive is configured, not available. */
  isAvailable: boolean
  /** Epoch ms, or null when never indexed. */
  lastIndexedAt: number | null
  eventCount: number
}

export type RawDumpScanResult = {
  clusters: EventCluster[]
  screenshotCount: number
  /** The dump root, for `assetUrl(joinDumpPath(rootPath, itemId))` only. */
  rootPath: string | null
}

/**
 * `rootPath` is a string on macOS and null on iOS, where there is no path to
 * answer — §3 says the iOS pick answers `label: "Camera Roll"` with
 * `rootPath: null`, while §2's sketch types the field as a bare string.
 * Widened here rather than silently dropped, so one command name keeps
 * meaning the same thing on both devices.
 */
export type RawDumpPick = {
  label: string
  itemCount: number
  rootPath: string | null
}

/** `evt_` + 20 hex: sha256(sourceId | startDateSeconds). The pattern is the
 *  contract's, not a preference — the id lands in `data-*` attributes and in
 *  the viewer's storage key, so a stray quote, space or separator in a
 *  hostile reply would corrupt both. */
export const EVENT_CLUSTER_ID_PATTERN = /^evt_[0-9a-f]{20}$/

/** `YYYY-MM-DD` in the capture calendar, unique inside an event. */
export const EVENT_DAY_ID_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** A dump is 50,000 frames by plan. Past these bounds a reply is a corrupt
 *  index rather than a timeline, and trying to render it would hang the
 *  Library on the attempt. */
export const MAX_EVENT_MEMBERS = 100_000
export const MAX_EVENT_DAYS = 366

/** A status that cannot be read is the same fact as no declaration at all:
 *  nothing to show. One object, so the UI branches on stages rather than on
 *  nulls. */
export const RAW_DUMP_NOT_CONFIGURED: RawDumpStatus = {
  configured: false,
  label: null,
  isAvailable: false,
  lastIndexedAt: null,
  eventCount: 0,
}

/** Item ids are paths relative to the dump root, or a PHAsset
 *  localIdentifier on iOS. Control characters or an embedded NUL make the id
 *  unusable both as a DOM key and as half of a file path. */
const isMemberId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/.test(value)

/** Epoch milliseconds, exactly as the wire spells it. A fractional or
 *  negative stamp is not a capture time. */
const isEpochMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

/** Display text: a folder's last path component. Newlines are refused
 *  because a label sits inline in a card. */
const asLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 120 || /[\u0000-\u001f]/.test(trimmed)) return null
  return trimmed
}

/** A path the page never displays, only hands back to the shell: bounded by
 *  the filesystem's own reach rather than a label's width. A cloud-storage
 *  camera backup sits deep — clipping it at 120 characters would break the
 *  join for the whole dump. */
const asPath = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4_096 || /[\u0000-\u001f]/.test(trimmed)) return null
  return trimmed
}

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** Members in the order the engine gave them. A non-string or an empty list
 *  voids the record rather than silently shortening it: an event whose
 *  membership cannot be trusted is not an event, it is a guess. A duplicate
 *  is the same signal — the engine's list is a set, so a repeat did not come
 *  from the engine. */
const asMemberIds = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVENT_MEMBERS) return null
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isMemberId(entry) || seen.has(entry)) return null
    seen.add(entry)
    ids.push(entry)
  }
  return ids
}

/**
 * One sub-day. A day that does not parse is dropped by the caller rather
 * than voiding the event around it: a trip whose third day reads badly still
 * shows its first two tabs.
 */
export const parseEventDayGroup = (value: unknown): EventDayGroup | null => {
  const body = asObject(value)
  if (!body) return null
  if (typeof body.id !== 'string' || !EVENT_DAY_ID_PATTERN.test(body.id)) return null
  if (!isEpochMs(body.date)) return null
  const itemIds = asMemberIds(body.itemIds)
  if (!itemIds) return null
  return { id: body.id, date: body.date, itemIds }
}

/**
 * One event, or null when its identity or timeline cannot be trusted.
 *
 * The two rules the contract says the UI may rely on are enforced on the way
 * in rather than assumed: `coverItemId` is a member, and `subDays` is
 * non-empty exactly when `isMultiDay`. Breaking either degrades the record
 * instead of dropping it — a stand-in cover, or an event without tabs —
 * because the event's photographs are real whatever the index got wrong.
 */
export const parseEventCluster = (value: unknown): EventCluster | null => {
  const body = asObject(value)
  if (!body) return null
  if (typeof body.id !== 'string' || !EVENT_CLUSTER_ID_PATTERN.test(body.id)) return null
  if (!isEpochMs(body.startDate) || !isEpochMs(body.endDate)) return null
  if (body.endDate < body.startDate) return null
  // The badge is the engine's claim, not a derived one; a missing flag means
  // this reply did not come from the contract.
  if (body.isMultiDay !== true && body.isMultiDay !== false) return null
  const itemIds = asMemberIds(body.itemIds)
  if (!itemIds) return null

  const cluster: EventCluster = {
    id: body.id,
    startDate: body.startDate,
    endDate: body.endDate,
    isMultiDay: body.isMultiDay,
    itemIds,
    // A cover the members do not contain would paint a dead tile, and the
    // first frame is the same stand-in the pre-index grid used before the
    // engine had a preference to voice.
    coverItemId: typeof body.coverItemId === 'string' && itemIds.includes(body.coverItemId)
      ? body.coverItemId
      : itemIds[0],
  }

  if (body.isMultiDay && Array.isArray(body.subDays)) {
    const days = body.subDays
      .slice(0, MAX_EVENT_DAYS)
      .map(parseEventDayGroup)
      .filter((day): day is EventDayGroup => day !== null)
    const members = new Set(itemIds)
    // Tabs only mean something when there is more than one of them and every
    // frame they name is actually in the event.
    if (days.length > 1 && days.every((day) => day.itemIds.every((id) => members.has(id)))) {
      cluster.subDays = days
    }
  }
  return cluster
}

/** Events oldest first, which is both the contract's order and the Library's.
 *  Unreadable records are dropped. Never throws. */
export const parseEventClusters = (value: unknown): EventCluster[] => {
  if (!Array.isArray(value)) return []
  const clusters: EventCluster[] = []
  for (const entry of value) {
    const cluster = parseEventCluster(entry)
    if (cluster) clusters.push(cluster)
  }
  return clusters.sort((a, b) => a.startDate - b.startDate)
}

/**
 * The cheap command's answer, safe to read on every mount. Unknown keys are
 * ignored rather than rejected — unlike a request the server accepts, this is
 * a reply from a shell that may gain a field before this bundle is rebuilt,
 * and blanking the Library over a field the page does not read is the wrong
 * direction to fail in.
 *
 * Null means the shell did not answer the command at all — no object, a
 * rejection, or a build from before the feature. That is a different fact
 * from "configured: false", which is an answer: only the second one is a
 * user who has a folder to declare, so only the second may show a control.
 * Invariant 7's rule, applied to the desktop's own older shells.
 */
export const parseRawDumpStatus = (value: unknown): RawDumpStatus | null => {
  const body = asObject(value)
  if (!body) return null
  if (body.configured !== true) return RAW_DUMP_NOT_CONFIGURED
  return {
    configured: true,
    label: asLabel(body.label),
    // Availability is only ever claimed for something configured. A reply
    // that says both ways keeps the honest half: nothing to read.
    isAvailable: body.isAvailable === true,
    lastIndexedAt: isEpochMs(body.lastIndexedAt) ? body.lastIndexedAt : null,
    eventCount: asCount(body.eventCount),
  }
}

export const parseRawDumpScanResult = (value: unknown): RawDumpScanResult => {
  const body = asObject(value)
  if (!body) return { clusters: [], screenshotCount: 0, rootPath: null }
  return {
    clusters: parseEventClusters(body.clusters),
    screenshotCount: asCount(body.screenshotCount),
    rootPath: asPath(body.rootPath),
  }
}

/** A cancelled picker answers null. Anything that is not a labelled answer
 *  is read as a cancel — from the page's side the two are the same event:
 *  the user did not choose a folder. */
export const parseRawDumpPick = (value: unknown): RawDumpPick | null => {
  const body = asObject(value)
  if (!body) return null
  const label = asLabel(body.label)
  if (!label) return null
  return {
    label,
    itemCount: asCount(body.itemCount),
    rootPath: asPath(body.rootPath),
  }
}

/* ── Presentation ────────────────────────────────────────────────────────
 * The engine never names a date; these do. Fixed English month abbreviations
 * rather than `toLocaleDateString`, because the same label is written into a
 * card, a sheet title and a storage key, and an ICU-less runtime must read
 * the trip the same way a full-ICU one does. Days are taken in the device's
 * own calendar: the shell clustered by the capture calendar and this page
 * runs on the same machine, so UTC would move an evening's last frame into
 * the following day.
 * ───────────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type CalendarDay = { day: number; month: number; year: number }

const calendarDay = (epochMs: number): CalendarDay => {
  const date = new Date(epochMs)
  return { day: date.getDate(), month: date.getMonth(), year: date.getFullYear() }
}

const sameDay = (a: CalendarDay, b: CalendarDay): boolean =>
  a.day === b.day && a.month === b.month && a.year === b.year

/**
 * The span an event is identified by — four shapes, no more:
 *
 *   `12 Mar 2026`                   one calendar day
 *   `12–16 Mar 2026`                same month
 *   `28 Feb – 3 Mar 2026`           across months, one year
 *   `30 Dec 2025 – 2 Jan 2026`      across years — both years stated
 *
 * Unreadable stamps answer the empty string. A card with no date is honest;
 * one that says `Invalid date` is a bug the user cannot dismiss.
 */
export const formatDateSpan = (startDate: number, endDate: number): string => {
  if (!isEpochMs(startDate) || !isEpochMs(endDate)) return ''
  const start = calendarDay(startDate)
  const end = calendarDay(Math.max(startDate, endDate))
  if (sameDay(start, end)) return `${start.day} ${MONTHS[start.month]} ${start.year}`
  if (start.year === end.year) {
    if (start.month === end.month) return `${start.day}–${end.day} ${MONTHS[start.month]} ${start.year}`
    return `${start.day} ${MONTHS[start.month]} – ${end.day} ${MONTHS[end.month]} ${start.year}`
  }
  return `${start.day} ${MONTHS[start.month]} ${start.year} – ${end.day} ${MONTHS[end.month]} ${end.year}`
}

export const formatEventDateSpan = (cluster: EventCluster): string =>
  formatDateSpan(cluster.startDate, cluster.endDate)

/** Grouped by hand for the same reason the month names are fixed: a
 *  50,000-frame dump must read the same in the Worker as in the shell. */
const groupThousands = (value: number): string => {
  const digits = String(value)
  const head = digits.length > 3 ? digits.length % 3 : 0
  const chunks: string[] = []
  if (head) chunks.push(digits.slice(0, head))
  for (let index = head; index < digits.length; index += 3) chunks.push(digits.slice(index, index + 3))
  return chunks.join(',')
}

/** The frame count in the Library's own voice. Bursts count as the separate
 *  frames the engine kept — the collapse chooses a cover, it does not delete
 *  a photograph, and the card must not imply otherwise. */
export const formatFrameCount = (count: number): string => {
  const value = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
  return `${groupThousands(value)} ${value === 1 ? 'photograph' : 'photographs'}`
}

export const formatEventFrameCount = (cluster: EventCluster): string =>
  formatFrameCount(cluster.itemIds.length)

/** Sub-days in the order the trip happened. The engine answers them in
 *  calendar order already; sorting here means a re-sorted index cannot make
 *  the tabs lie about which day came first. Fewer than two days answers no
 *  tabs at all — one tab is not a choice. */
export const orderedSubDays = (cluster: EventCluster): EventDayGroup[] => {
  const days = cluster.subDays
  if (!days || days.length < 2) return []
  return [...days].sort((a, b) => a.date - b.date || (a.id < b.id ? -1 : 1))
}

/**
 * A tab name for one day: `12 Mar`, or `12 Mar 2026` when the event crosses a
 *  year boundary — inside a trip that spans New Year the bare day is
 *  ambiguous and the year is the only thing that resolves it.
 */
export const formatSubDayLabel = (day: EventDayGroup, cluster?: EventCluster): string => {
  const date = calendarDay(day.date)
  const crossesYear = cluster !== undefined
    && calendarDay(cluster.startDate).year !== calendarDay(cluster.endDate).year
  return `${date.day} ${MONTHS[date.month]}${crossesYear ? ` ${date.year}` : ''}`
}

/**
 * Where a sub-day begins inside the event's own frame order — the index the
 * viewer opens at when a tab is chosen. Falls back to the event's first frame
 * when the day names nothing the event contains, so a stale tab cannot land
 * the viewer outside the gallery it was opened from.
 */
export const subDayStartIndex = (cluster: EventCluster, dayId: string): number => {
  const day = cluster.subDays?.find((entry) => entry.id === dayId)
  if (!day || day.itemIds.length === 0) return 0
  const index = cluster.itemIds.indexOf(day.itemIds[0])
  return index < 0 ? 0 : index
}

/**
 * How long ago the dump was indexed, in the fewest words that stay true.
 * `now` is a parameter rather than `Date.now()` inside the call so the
 * boundaries read the same in a test as on a Mac at 23:59.
 */
export const formatIndexedAgo = (lastIndexedAt: number | null, now: number): string => {
  if (!isEpochMs(lastIndexedAt)) return 'Never indexed'
  const since = now - lastIndexedAt
  if (since < 60_000) return 'Indexed just now'
  if (since < 3_600_000) {
    const minutes = Math.floor(since / 60_000)
    return `Indexed ${minutes} minute${minutes === 1 ? '' : 's'} ago`
  }
  if (since < 86_400_000) {
    const hours = Math.floor(since / 3_600_000)
    return `Indexed ${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  // Past a day the absolute date is the useful fact; "3 days ago" would age
  // out of meaning the moment the Mac sleeps over a weekend.
  return `Indexed ${formatDateSpan(lastIndexedAt, lastIndexedAt)}`
}

/**
 * The dump root and one member id, joined into the absolute path the shell's
 * media handler is asked for.
 *
 * The id comes from an index the page does not own, so this is where the
 * traversal check lives: no leading separator (an absolute id would replace
 * the root whole), no `..`, no empty or `.` segment. A refused join answers
 * null and the caller drops that frame from the event rather than pointing
 * the asset protocol outside the folder the user declared. The shell re-checks
 * every path against its granted roots anyway — this is the page's half of the
 * same refusal.
 */
export const joinDumpPath = (rootPath: string | null | undefined, itemId: string): string | null => {
  if (!isMemberId(itemId)) return null
  if (typeof rootPath !== 'string' || rootPath.length === 0) return null
  if (itemId.startsWith('/') || itemId.startsWith('\\')) return null
  const segments = itemId.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  const base = rootPath.replace(/[\\/]+$/, '')
  if (!base || base === '/' || base === '\\') return null
  return `${base}/${segments.join('/')}`
}

/* ── State mapping ─────────────────────────────────────────────────────
 * The one place the feature's shape is decided from what the shell answered,
 * so the Library section and the Settings control cannot disagree about
 * whether a dump is declared, reachable, awaiting its first index, or empty.
 * ───────────────────────────────────────────────────────────────────── */

export type RawDumpStage =
  /** Nothing declared: the Library shows no section and no teaser. */
  | 'not-configured'
  /** The shell does not answer the command at all — an older build, or a
   *  plain web runtime. No control is honest when nothing can persist. */
  | 'unsupported'
  /** Declared, drive not mounted or folder gone — say so, offer no scan. */
  | 'unavailable'
  /** Declared and reachable, awaiting the scan's answer. */
  | 'indexing'
  /** Indexed, with events worth showing. */
  | 'ready'
  /** Indexed and there is nothing in the dump to group. */
  | 'empty'
  /** The scan itself refused, or the index could not be read at all. */
  | 'failed'

export const rawDumpStage = (
  status: RawDumpStatus | null,
  scan: RawDumpScanResult | null,
  failed: boolean,
): RawDumpStage => {
  if (status === null) return 'unsupported'
  if (!status.configured) return 'not-configured'
  if (!status.isAvailable) return 'unavailable'
  if (failed) return 'failed'
  if (!scan) return 'indexing'
  return scan.clusters.length > 0 ? 'ready' : 'empty'
}
