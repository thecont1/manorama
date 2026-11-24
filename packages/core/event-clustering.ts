/**
 * Event clustering — the wire contract's TypeScript half, and the
 * presentation maths the Library builds out of it.
 *
 * The contract is `docs/event-clustering-bridge-contract.md`: one
 * user-declared raw dump per device, epoch **milliseconds** everywhere on
 * the wire, and a page that does nothing but present what the shell computed.
 * Nothing here clusters anything — the portable engine lives in
 * `crates/event-clustering/` and this file mirrors what the shells answer.
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
  authorization?: EventPhotosAuthorization
  selectedPhotoCount?: number | null
  downloadCloudOnOpen?: boolean
}

export type EventPhotosAuthorization = 'notDetermined' | 'denied' | 'restricted' | 'limited' | 'authorized'
export type EventAssetState = 'ready' | 'cloudOnly' | 'downloading' | 'failed' | 'missing'
export type EventAssetImage = { id: string; url: string | null; width: number; height: number; state: EventAssetState }
export type EventAssetRequest = { ids: string[]; purpose: 'thumbnail' | 'viewer'; maxPixelSize?: number; allowNetwork?: boolean }
export type EventAssetProgress = { id: string; fraction: number }
export const MAX_EVENT_ASSET_BATCH = 64

/** Opaque, not a filesystem grant. PHAsset identifiers contain slashes;
 * relative-path platforms share this seam, so traversal and controls fail closed. */
export const isEventAssetId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\u0000-\u001f\u007f\\\\:]/.test(value)
  && !value.split('/').some((part) => !part || part === '.' || part === '..')

export const isEventAssetRequest = (value: EventAssetRequest): boolean =>
  Array.isArray(value.ids) && value.ids.length > 0 && value.ids.length <= MAX_EVENT_ASSET_BATCH
  && value.ids.every(isEventAssetId) && new Set(value.ids).size === value.ids.length
  && (value.purpose === 'thumbnail' || value.purpose === 'viewer')
  && (value.maxPixelSize === undefined || (Number.isInteger(value.maxPixelSize) && value.maxPixelSize > 0 && value.maxPixelSize <= 8192))
  && (value.allowNetwork === undefined || typeof value.allowNetwork === 'boolean')
  && (value.allowNetwork !== true || (value.purpose === 'viewer' && value.ids.length === 1))

/** Local URLs only. In particular encoded traversal cannot turn a reply
 * into a read outside the shell-owned media directories. */
export const isEventAssetFileUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('file:///')) return false
  try {
    const rawPath = decodeURIComponent(value.slice(7))
    if (/[\u0000-\u001f\u007f\\\\?#]/.test(rawPath) || rawPath.split('/').some((part) => part === '.' || part === '..')) return false
    const url = new URL(value)
    return !url.host && !url.search && !url.hash
      && (/\/Caches\/event-thumbs\/[0-9a-f]{64}\.jpg$/.test(rawPath)
        || /\/cache\/event-thumbs\/[0-9a-f]{64}\.jpg$/.test(rawPath)
        || /\/event-originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-zA-Z0-9]+$/.test(rawPath))
  } catch { return false }
}

/** Desktop originals are reachable only through opaque, native-issued leases. */
export const isEventAssetLeaseUrl = (value: unknown): value is string =>
  typeof value === 'string'
  && /^(?:manorama-event:\/\/localhost\/|http:\/\/manorama-event\.localhost\/)[0-9a-fA-F]{32}$/.test(value)

export const isEventAssetUrl = (value: unknown): value is string =>
  isEventAssetLeaseUrl(value) || isEventAssetFileUrl(value)

export const parseEventAssetImages = (value: unknown, ids: readonly string[]): EventAssetImage[] | null => {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EVENT_ASSET_BATCH
    || !ids.every(isEventAssetId) || new Set(ids).size !== ids.length) return null
  const body = asObject(value)
  if (!body || !Array.isArray(body.items) || body.items.length !== ids.length) return null
  const result: EventAssetImage[] = []
  for (let index = 0; index < ids.length; index++) {
    const item = asObject(body.items[index])
    if (!item || item.id !== ids[index] || !isEventAssetId(item.id)
      || !['ready', 'cloudOnly', 'downloading', 'failed', 'missing'].includes(String(item.state))
      || !Number.isInteger(item.width) || !Number.isInteger(item.height)
      || (item.width as number) < 0 || (item.height as number) < 0) return null
    if (item.state === 'ready' ? (!isEventAssetUrl(item.url) || (item.width as number) <= 0 || (item.height as number) <= 0) : item.url !== null) return null
    result.push({ id: item.id, url: item.url as string | null, width: item.width as number, height: item.height as number, state: item.state as EventAssetState })
  }
  return result
}

export const parseEventAssetProgress = (value: unknown): EventAssetProgress | null => {
  const body = asObject(value)
  return body && isEventAssetId(body.id) && typeof body.fraction === 'number'
    && Number.isFinite(body.fraction) && body.fraction >= 0 && body.fraction <= 1
    ? { id: body.id, fraction: body.fraction } : null
}

export type RawDumpScanResult = {
  clusters: EventCluster[]
  screenshotCount: number
  /** Diagnostic source information only; never a media URL or filesystem grant. */
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
  const photos = ['notDetermined', 'denied', 'restricted', 'limited', 'authorized'].includes(String(body.authorization))
    ? {
        authorization: body.authorization as EventPhotosAuthorization,
        selectedPhotoCount: typeof body.selectedPhotoCount === 'number' && Number.isInteger(body.selectedPhotoCount) && body.selectedPhotoCount >= 0 ? body.selectedPhotoCount : null,
        downloadCloudOnOpen: body.downloadCloudOnOpen === true,
      } : {}
  if (body.configured !== true) return Object.keys(photos).length ? { ...RAW_DUMP_NOT_CONFIGURED, ...photos } : RAW_DUMP_NOT_CONFIGURED
  return {
    ...photos,
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
 * The engine never names a date; these do. Locale, calendar and time zone are
 * explicit so a card, its accessible name and a test can read the same instant
 * identically. The shells pass the device's resolved preferences; the stable
 * English/Gregorian default keeps server-side rendering deterministic.
 * ───────────────────────────────────────────────────────────────────── */

type EventPluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export type EventPresentationMessages = {
  photographCount: Partial<Record<EventPluralCategory, string>>
  selectedPhotoCount: Partial<Record<EventPluralCategory, string>>
  selectedPhotosOnly: string
  multiDay: string
  neverIndexed: string
  indexedJustNow: string
  indexedMinutesAgo: string
  indexedHoursAgo: string
  indexedOn: string
  daysIn: string
  eventDay: string
  cloudOnly: string
  missing: string
  failed: string
  readingPreview: string
}

export type EventPresentationOptions = {
  locale?: string
  calendar?: string
  timeZone?: string
  messages?: Partial<EventPresentationMessages>
}

const DEFAULT_MESSAGES: EventPresentationMessages = {
  photographCount: { one: '{count} photograph', other: '{count} photographs' },
  selectedPhotoCount: { one: 'Showing {count} selected photo', other: 'Showing {count} selected photos' },
  selectedPhotosOnly: 'Selected photos only',
  multiDay: 'Multi-day',
  neverIndexed: 'Never indexed',
  indexedJustNow: 'Indexed just now',
  indexedMinutesAgo: 'Indexed {relative}',
  indexedHoursAgo: 'Indexed {relative}',
  indexedOn: 'Indexed {date}',
  daysIn: 'Days in {date}',
  eventDay: '{event}, {day}',
  cloudOnly: 'Not downloaded',
  missing: 'Photo unavailable',
  failed: 'Preview unavailable',
  readingPreview: 'Reading preview…',
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()
const pluralRules = new Map<string, Intl.PluralRules>()
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>()
const listFormatters = new Map<string, Intl.ListFormat>()

const formatterKey = (options: EventPresentationOptions): string =>
  `${options.locale ?? 'en-GB'}|${options.calendar ?? 'gregory'}|${options.timeZone ?? ''}`

const dateFormatter = (options: EventPresentationOptions, includeYear: boolean): Intl.DateTimeFormat => {
  const key = `${formatterKey(options)}|${includeYear}`
  const cached = dateFormatters.get(key)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat(options.locale ?? 'en-GB', {
    calendar: options.calendar ?? 'gregory',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
  })
  if (dateFormatters.size >= 8) dateFormatters.clear()
  dateFormatters.set(key, formatter)
  return formatter
}

const numberFormatter = (options: EventPresentationOptions): Intl.NumberFormat => {
  const locale = options.locale ?? 'en-GB'
  let formatter = numberFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    if (numberFormatters.size >= 8) numberFormatters.clear()
    numberFormatters.set(locale, formatter)
  }
  return formatter
}

const pluralRule = (options: EventPresentationOptions): Intl.PluralRules => {
  const locale = options.locale ?? 'en-GB'
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    if (pluralRules.size >= 8) pluralRules.clear()
    pluralRules.set(locale, rules)
  }
  return rules
}

const relativeFormatter = (options: EventPresentationOptions): Intl.RelativeTimeFormat => {
  const locale = options.locale ?? 'en-GB'
  let formatter = relativeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
    if (relativeFormatters.size >= 8) relativeFormatters.clear()
    relativeFormatters.set(locale, formatter)
  }
  return formatter
}

const listFormatter = (options: EventPresentationOptions): Intl.ListFormat => {
  const locale = options.locale ?? 'en-GB'
  let formatter = listFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' })
    if (listFormatters.size >= 8) listFormatters.clear()
    listFormatters.set(locale, formatter)
  }
  return formatter
}

const messagesFor = (options: EventPresentationOptions): EventPresentationMessages => {
  if (!options.messages) return DEFAULT_MESSAGES
  return {
    ...DEFAULT_MESSAGES,
    ...options.messages,
    photographCount: { ...DEFAULT_MESSAGES.photographCount, ...options.messages.photographCount },
    selectedPhotoCount: { ...DEFAULT_MESSAGES.selectedPhotoCount, ...options.messages.selectedPhotoCount },
  }
}

const formatMessage = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match))

const pluralTemplate = (
  templates: Partial<Record<EventPluralCategory, string>>,
  count: number,
  rules: Intl.PluralRules,
): string => templates[rules.select(count)] ?? templates.other ?? ''

export const deviceEventPresentation = (): EventPresentationOptions => {
  const resolved = new Intl.DateTimeFormat().resolvedOptions()
  return { locale: resolved.locale, calendar: resolved.calendar, timeZone: resolved.timeZone }
}

type CalendarDay = { day: number; month: number; year: number; era: string }

const calendarDay = (epochMs: number, options: EventPresentationOptions): CalendarDay => {
  const parts = dateFormatter(options, true).formatToParts(epochMs)
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  return { day: Number(value('day')), month: Number(value('month')), year: Number(value('year')), era: value('era') }
}

const sameDay = (a: CalendarDay, b: CalendarDay): boolean =>
  a.day === b.day && a.month === b.month && a.year === b.year && a.era === b.era

const isFormattableDate = (value: unknown): value is number =>
  isEpochMs(value) && !Number.isNaN(new Date(value).getTime())

/** A locale- and calendar-aware span. `Intl.DateTimeFormat` owns range
 * punctuation and field elision; unreadable stamps answer the empty string. */
export const formatDateSpan = (
  startDate: number,
  endDate: number,
  options: EventPresentationOptions = {},
): string => {
  if (!isFormattableDate(startDate) || !isFormattableDate(endDate)) return ''
  const end = Math.max(startDate, endDate)
  const formatter = dateFormatter(options, true)
  if (sameDay(calendarDay(startDate, options), calendarDay(end, options))) return formatter.format(startDate)
  return formatter.formatRange(startDate, end)
}

export const formatEventDateSpan = (cluster: EventCluster, options: EventPresentationOptions = {}): string =>
  formatDateSpan(cluster.startDate, cluster.endDate, options)

/** The frame count in the Library's own voice. Bursts count as the separate
 *  frames the engine kept — the collapse chooses a cover, it does not delete
 *  a photograph, and the card must not imply otherwise. */
export const formatFrameCount = (count: number, options: EventPresentationOptions = {}): string => {
  const value = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
  const messages = messagesFor(options)
  const template = pluralTemplate(messages.photographCount, value, pluralRule(options))
  return formatMessage(template, { count: numberFormatter(options).format(value) })
}

export const formatEventFrameCount = (cluster: EventCluster, options: EventPresentationOptions = {}): string =>
  formatFrameCount(cluster.itemIds.length, options)

export const formatSelectedPhotoCount = (count: number | null | undefined, options: EventPresentationOptions = {}): string => {
  const messages = messagesFor(options)
  if (count === null || count === undefined) return messages.selectedPhotosOnly
  const value = Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
  const template = pluralTemplate(messages.selectedPhotoCount, value, pluralRule(options))
  return formatMessage(template, { count: numberFormatter(options).format(value) })
}

export const formatMultiDayLabel = (options: EventPresentationOptions = {}): string =>
  messagesFor(options).multiDay

export const formatEventPreviewState = (
  state: EventAssetState | undefined,
  options: EventPresentationOptions = {},
): string => {
  const messages = messagesFor(options)
  if (state === 'cloudOnly') return messages.cloudOnly
  if (state === 'missing') return messages.missing
  if (state === 'failed') return messages.failed
  return messages.readingPreview
}

export const formatDaysLabel = (span: string, options: EventPresentationOptions = {}): string =>
  formatMessage(messagesFor(options).daysIn, { date: span })

export const formatEventDayLabel = (
  day: EventDayGroup,
  cluster: EventCluster,
  span: string,
  options: EventPresentationOptions = {},
): string => formatMessage(messagesFor(options).eventDay, {
  event: span,
  day: formatSubDayLabel(day, cluster, options),
})

export const formatEventCardLabel = (
  cluster: EventCluster,
  state: EventAssetState | undefined,
  options: EventPresentationOptions = {},
): string => {
  const parts = [formatEventDateSpan(cluster, options), formatEventFrameCount(cluster, options)]
  if (cluster.isMultiDay) parts.push(messagesFor(options).multiDay)
  if (state && state !== 'ready') parts.push(formatEventPreviewState(state, options))
  return listFormatter(options).format(parts)
}

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
export const formatSubDayLabel = (
  day: EventDayGroup,
  cluster?: EventCluster,
  options: EventPresentationOptions = {},
): string => {
  if (!isFormattableDate(day.date)) return ''
  const start = cluster !== undefined && isFormattableDate(cluster.startDate) ? calendarDay(cluster.startDate, options) : undefined
  const end = cluster !== undefined && isFormattableDate(cluster.endDate) ? calendarDay(cluster.endDate, options) : undefined
  const crossesYear = start !== undefined && end !== undefined && (start.year !== end.year || start.era !== end.era)
  return dateFormatter(options, crossesYear).format(day.date)
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
export const formatIndexedAgo = (
  lastIndexedAt: number | null,
  now: number,
  options: EventPresentationOptions = {},
): string => {
  const messages = messagesFor(options)
  if (!isFormattableDate(lastIndexedAt)) return messages.neverIndexed
  const since = now - lastIndexedAt
  if (since < 60_000) return messages.indexedJustNow
  if (since < 3_600_000) {
    const minutes = Math.floor(since / 60_000)
    return formatMessage(messages.indexedMinutesAgo, { relative: relativeFormatter(options).format(-minutes, 'minute') })
  }
  if (since < 86_400_000) {
    const hours = Math.floor(since / 3_600_000)
    return formatMessage(messages.indexedHoursAgo, { relative: relativeFormatter(options).format(-hours, 'hour') })
  }
  // Past a day the absolute date is the useful fact; "3 days ago" would age
  // out of meaning the moment the Mac sleeps over a weekend.
  return formatMessage(messages.indexedOn, { date: formatDateSpan(lastIndexedAt, lastIndexedAt, options) })
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
