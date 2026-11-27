import { describe, expect, test } from 'bun:test'
import {
  MAX_EVENT_MEMBERS,
  RAW_DUMP_NOT_CONFIGURED,
  formatDaysLabel,
  formatEventCardLabel,
  formatEventDateSpan,
  formatEventDayLabel,
  formatEventFrameCount,
  formatEventPreviewState,
  formatDateSpan,
  formatFrameCount,
  formatIndexedAgo,
  formatMultiDayLabel,
  formatSelectedPhotoCount,
  formatSubDayLabel,
  isEventAssetFileUrl,
  isEventAssetLeaseUrl,
  isEventAssetRequest,
  orderedSubDays,
  parseEventAssetImages,
  parseEventCluster,
  parseEventClusters,
  parseRawDumpPick,
  parseRawDumpScanResult,
  parseRawDumpStatus,
  rawDumpStage,
  subDayStartIndex,
  type EventCluster,
} from './event-clustering'

/**
 * The contract's TypeScript half, tested the way the bridge contract reads:
 * a shape it names must parse, and everything else must degrade without
 * throwing. The index these parsers guard is a cache the shell owns, so a
 * half-written reply is a normal Tuesday — the Library may not crash on one,
 * and may not show a frame the shell cannot later read.
 *
 * Timestamps are built from local-date parts, not from `Z` strings: the span
 * labels read the device's own calendar, which is what the shell clustered
 * in, and a test that hard-coded UTC would pass here and fail on a Mac.
 */

const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

const clusterWire = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_0123456789abcdef0123',
  startDate: at(2026, 3, 12, 9),
  endDate: at(2026, 3, 12, 21),
  isMultiDay: false,
  coverItemId: '2026/03/IMG_4821.jpg',
  itemIds: ['2026/03/IMG_4821.jpg', '2026/03/IMG_4822.jpg'],
  ...overrides,
})

describe('parseEventCluster', () => {
  test('reads the contract shape', () => {
    const parsed = parseEventCluster(clusterWire())
    expect(parsed).not.toBeNull()
    expect(parsed?.id).toBe('evt_0123456789abcdef0123')
    expect(parsed?.coverItemId).toBe('2026/03/IMG_4821.jpg')
    expect(parsed?.itemIds).toEqual(['2026/03/IMG_4821.jpg', '2026/03/IMG_4822.jpg'])
    expect(parsed?.isMultiDay).toBe(false)
    expect(parsed?.subDays).toBeUndefined()
  })

  test('degrades on anything that is not an object', () => {
    for (const junk of [null, undefined, 0, '', 'evt_x', [], [{ id: 'evt_0123456789abcdef0123' }]]) {
      expect(parseEventCluster(junk)).toBeNull()
    }
  })

  test('a malformed index cannot throw', () => {
    // Every one of these is a record the page must drop on the floor rather
    // than render: the identity, the timeline or the membership is unusable.
    expect(parseEventCluster(clusterWire({ id: 'evt_ZZZZZZZZZZZZZZZZZZZZ' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ id: '../../etc/passwd' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ id: 'evt_0123456789abcdef0123456789' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ startDate: null }))).toBeNull()
    expect(parseEventCluster(clusterWire({ startDate: '1773000000000' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ endDate: Number.NaN }))).toBeNull()
    expect(parseEventCluster(clusterWire({ startDate: at(2026, 3, 12), endDate: at(2026, 3, 11) }))).toBeNull()
    expect(parseEventCluster(clusterWire({ isMultiDay: undefined }))).toBeNull()
    expect(parseEventCluster(clusterWire({ isMultiDay: 'true' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ itemIds: [] }))).toBeNull()
    expect(parseEventCluster(clusterWire({ itemIds: 'a.jpg' }))).toBeNull()
    expect(parseEventCluster(clusterWire({ itemIds: ['a.jpg', null] }))).toBeNull()
    expect(parseEventCluster(clusterWire({ itemIds: ['a.jpg', ''] }))).toBeNull()
    expect(parseEventCluster(clusterWire({ itemIds: ['a.jpg', 'a.jpg'] }))).toBeNull()
    expect(
      parseEventCluster(clusterWire({ itemIds: ['a.jpg', `b.jpg\u0000trailing`] })),
    ).toBeNull()
  })

  test('ignores keys it does not know', () => {
    // A newer shell must not blank an older bundle's Library.
    const parsed = parseEventCluster(clusterWire({ classification: 'Wedding', geoHash: 's0000' }))
    expect(parsed?.id).toBe('evt_0123456789abcdef0123')
    expect((parsed as unknown as Record<string, unknown>).classification).toBeUndefined()
  })

  test('a cover outside the membership stands in rather than painting a dead tile', () => {
    const parsed = parseEventCluster(clusterWire({ coverItemId: '2026/03/IMG_9999.jpg' }))
    expect(parsed?.coverItemId).toBe('2026/03/IMG_4821.jpg')
  })

  test('sub-days survive only when they describe the whole event', () => {
    const days = [
      { id: '2026-03-12', date: at(2026, 3, 12, 9), itemIds: ['a.jpg'] },
      { id: '2026-03-13', date: at(2026, 3, 13, 8), itemIds: ['b.jpg'] },
    ]
    const multi = clusterWire({
      isMultiDay: true,
      startDate: at(2026, 3, 12, 9),
      endDate: at(2026, 3, 13, 20),
      itemIds: ['a.jpg', 'b.jpg'],
      coverItemId: 'a.jpg',
      subDays: days,
    })
    expect(parseEventCluster(multi)?.subDays).toEqual(days)

    // One day is not a choice, and a day naming a stranger is not a day.
    expect(parseEventCluster({ ...multi, subDays: days.slice(0, 1) })?.subDays).toBeUndefined()
    expect(
      parseEventCluster({ ...multi, subDays: [days[0], { ...days[1], itemIds: ['stranger.jpg'] }] })?.subDays,
    ).toBeUndefined()
    // A malformed day is dropped; the trip it belongs to is still an event.
    const withADeadDay = { ...multi, subDays: [days[0], { id: 'nope', date: 1, itemIds: ['a.jpg'] }, days[1]] }
    expect(parseEventCluster(withADeadDay)?.subDays).toEqual(days)
    // Claimed multi-day with no days at all still shows the event, without tabs.
    const bare = parseEventCluster({ ...multi, subDays: null })
    expect(bare?.isMultiDay).toBe(true)
    expect(bare?.subDays).toBeUndefined()
  })

  test('refuses a member list past the contract bounds', () => {
    // A 100k-member "event" is a corrupt index, not a timeline; rendering the
    // attempt is how the Library would hang.
    const ids = Array.from({ length: MAX_EVENT_MEMBERS + 1 }, (_, i) => `f${i}.jpg`)
    expect(parseEventCluster(clusterWire({ itemIds: ids }))).toBeNull()
  })
})

describe('parseEventClusters', () => {
  test('keeps chronological order and drops the unreadable', () => {
    const input = [
      clusterWire({ id: 'evt_bbbbbbbbbbbbbbbbbbbb', startDate: at(2026, 5, 1), endDate: at(2026, 5, 1, 20) }),
      clusterWire({ id: 'evt_not-a-valid-id' }),
      clusterWire({ id: 'evt_aaaaaaaaaaaaaaaaaaaa', startDate: at(2026, 4, 1), endDate: at(2026, 4, 1, 20) }),
    ]
    expect(parseEventClusters(input).map((cluster) => cluster.id)).toEqual([
      'evt_aaaaaaaaaaaaaaaaaaaa',
      'evt_bbbbbbbbbbbbbbbbbbbb',
    ])
  })

  test('a non-array index reads as no events', () => {
    for (const junk of [null, undefined, {}, '[]', 7]) expect(parseEventClusters(junk)).toEqual([])
  })
})

describe('parseRawDumpStatus', () => {
  test('reads the declared-and-reachable answer', () => {
    const status = parseRawDumpStatus({
      configured: true,
      label: 'Google Photos Backup',
      isAvailable: true,
      lastIndexedAt: at(2026, 11, 23, 8),
      eventCount: 42,
    })
    expect(status).toEqual({
      configured: true,
      label: 'Google Photos Backup',
      isAvailable: true,
      lastIndexedAt: at(2026, 11, 23, 8),
      eventCount: 42,
    })
  })

  test('an object that says nothing is answered as not configured', () => {
    expect(parseRawDumpStatus({})).toEqual(RAW_DUMP_NOT_CONFIGURED)
    expect(parseRawDumpStatus({ configured: false, isAvailable: true, eventCount: 9 })).toEqual(RAW_DUMP_NOT_CONFIGURED)
  })

  test('no answer is a different fact from a negative answer', () => {
    // Null means "this shell has no raw dump to talk about" — the case in
    // which the page must show no control at all, rather than an empty one.
    for (const missing of [null, undefined, 'configured: true', 7, []]) {
      expect(parseRawDumpStatus(missing)).toBeNull()
    }
  })

  test('junk fields degrade to their own defaults, not to the whole record', () => {
    const status = parseRawDumpStatus({
      configured: true,
      label: '   ',
      isAvailable: 'yes',
      lastIndexedAt: -1,
      eventCount: -5,
    })
    expect(status).toEqual({
      configured: true,
      label: null,
      isAvailable: false,
      lastIndexedAt: null,
      eventCount: 0,
    })
  })

  test('a label carrying control characters is refused', () => {
    const status = parseRawDumpStatus({ configured: true, label: 'Backup\nReboot Me', isAvailable: true })
    expect(status?.label).toBeNull()
  })
})

describe('parseRawDumpScanResult and parseRawDumpPick', () => {
  test('a scan reply that is not an object reads as nothing indexed', () => {
    expect(parseRawDumpScanResult(null)).toEqual({ clusters: [], screenshotCount: 0, rootPath: null })
    expect(parseRawDumpScanResult('nope').clusters).toEqual([])
  })

  test('a root path is kept whole, however deep', () => {
    // Cloud-storage roots sit far below 120 characters; clipping one would
    // break every join in the dump, so paths are bounded by the filesystem.
    const deep = `/Users/home/${'x'.repeat(200)}/Google Drive/Backups/Photos`
    expect(parseRawDumpScanResult({ rootPath: deep }).rootPath).toBe(deep)
  })

  test('a cancelled pick is a cancel, and an unlabelled answer is too', () => {
    expect(parseRawDumpPick(null)).toBeNull()
    expect(parseRawDumpPick({ itemCount: 12, rootPath: '/dump' })).toBeNull()
    expect(parseRawDumpPick({ label: 'Camera Roll', itemCount: 0, rootPath: null })).toEqual({
      label: 'Camera Roll',
      itemCount: 0,
      rootPath: null,
    })
  })

  test('a missing or junk count reads as zero rather than undefined', () => {
    expect(parseRawDumpPick({ label: 'Camera Roll' })?.itemCount).toBe(0)
    expect(parseRawDumpPick({ label: 'Camera Roll', itemCount: 'many' })?.itemCount).toBe(0)
  })
})

describe('formatDateSpan', () => {
  test('one calendar day names itself once', () => {
    expect(formatDateSpan(at(2026, 3, 12, 9), at(2026, 3, 12, 21))).toBe('12 Mar 2026')
  })

  test('a run inside one month states the day range once', () => {
    expect(formatDateSpan(at(2026, 3, 12, 9), at(2026, 3, 16, 18))).toBe('12 – 16 Mar 2026')
  })

  test('across a month boundary the year is stated once', () => {
    expect(formatDateSpan(at(2026, 2, 28, 9), at(2026, 3, 3, 18))).toBe('28 Feb – 3 Mar 2026')
  })

  test('across a year boundary both years are stated', () => {
    expect(formatDateSpan(at(2025, 12, 30, 9), at(2026, 1, 2, 18))).toBe('30 Dec 2025 – 2 Jan 2026')
  })

  test('a leap day reads as itself', () => {
    expect(formatDateSpan(at(2024, 2, 29, 9), at(2024, 2, 29, 22))).toBe('29 Feb 2024')
    expect(formatDateSpan(at(2024, 2, 29, 9), at(2024, 3, 1, 22))).toBe('29 Feb – 1 Mar 2024')
    // And February has no 30th to be confused with: the day after the 28th in
    // a common year is the 1st.
    expect(formatDateSpan(at(2025, 2, 28, 9), at(2025, 3, 1, 22))).toBe('28 Feb – 1 Mar 2025')
  })

  test('unreadable stamps answer nothing rather than Invalid Date', () => {
    expect(formatDateSpan(Number.NaN, at(2026, 3, 12))).toBe('')
    expect(formatDateSpan(at(2026, 3, 12), -1)).toBe('')
  })

  test('the cluster convenience form reads the event’s own span', () => {
    const cluster = parseEventCluster(clusterWire()) as EventCluster
    expect(formatEventDateSpan(cluster)).toBe('12 Mar 2026')
  })
})

describe('formatFrameCount', () => {
  test('one photograph, many photographs', () => {
    expect(formatFrameCount(1)).toBe('1 photograph')
    expect(formatFrameCount(2)).toBe('2 photographs')
    expect(formatFrameCount(0)).toBe('0 photographs')
  })

  test('thousands are grouped without leaning on ICU', () => {
    expect(formatFrameCount(999)).toBe('999 photographs')
    expect(formatFrameCount(1000)).toBe('1,000 photographs')
    expect(formatFrameCount(50000)).toBe('50,000 photographs')
    expect(formatFrameCount(1234567)).toBe('1,234,567 photographs')
  })

  test('junk counts read as zero', () => {
    expect(formatFrameCount(-3)).toBe('0 photographs')
    expect(formatFrameCount(Number.NaN)).toBe('0 photographs')
  })

  test('the event form counts every member, bursts included', () => {
    const cluster = parseEventCluster(clusterWire()) as EventCluster
    expect(formatEventFrameCount(cluster)).toBe('2 photographs')
  })
})

describe('sub-day ordering', () => {
  const multi = parseEventCluster({
    id: 'evt_aaaaaaaaaaaaaaaaaaaa',
    startDate: at(2026, 3, 12, 9),
    endDate: at(2026, 3, 14, 19),
    isMultiDay: true,
    coverItemId: 'd1a.jpg',
    itemIds: ['d1a.jpg', 'd1b.jpg', 'd2a.jpg', 'd3a.jpg'],
    subDays: [
      { id: '2026-03-13', date: at(2026, 3, 13, 8), itemIds: ['d2a.jpg'] },
      { id: '2026-03-14', date: at(2026, 3, 14, 10), itemIds: ['d3a.jpg'] },
      { id: '2026-03-12', date: at(2026, 3, 12, 9), itemIds: ['d1a.jpg', 'd1b.jpg'] },
    ],
  }) as EventCluster

  test('tabs come back in the order the trip happened', () => {
    expect(orderedSubDays(multi).map((day) => day.id)).toEqual(['2026-03-12', '2026-03-13', '2026-03-14'])
    // The input array itself is not reordered — the index is the shell's.
    expect(multi.subDays?.[0].id).toBe('2026-03-13')
  })

  test('one day is not a choice, so it is not a tab list', () => {
    const single = parseEventCluster(clusterWire()) as EventCluster
    expect(orderedSubDays(single)).toEqual([])
  })

  test('a tab names the day, and the year only when the trip crosses one', () => {
    expect(formatSubDayLabel(orderedSubDays(multi)[1], multi)).toBe('13 Mar')
    const newYear = parseEventCluster({
      id: 'evt_bbbbbbbbbbbbbbbbbbbb',
      startDate: at(2025, 12, 30, 9),
      endDate: at(2026, 1, 1, 19),
      isMultiDay: true,
      coverItemId: 'a.jpg',
      itemIds: ['a.jpg', 'b.jpg'],
      subDays: [
        { id: '2025-12-30', date: at(2025, 12, 30, 9), itemIds: ['a.jpg'] },
        { id: '2026-01-01', date: at(2026, 1, 1, 9), itemIds: ['b.jpg'] },
      ],
    }) as EventCluster
    const [first, second] = orderedSubDays(newYear)
    expect(formatSubDayLabel(first, newYear)).toBe('30 Dec 2025')
    expect(formatSubDayLabel(second, newYear)).toBe('1 Jan 2026')
  })

  test('a chosen tab opens the event at that day’s first frame', () => {
    expect(subDayStartIndex(multi, '2026-03-12')).toBe(0)
    expect(subDayStartIndex(multi, '2026-03-13')).toBe(2)
    expect(subDayStartIndex(multi, '2026-03-14')).toBe(3)
    // A day the event no longer contains cannot push the viewer outside it.
    expect(subDayStartIndex(multi, '2026-03-15')).toBe(0)
  })
})

describe('formatIndexedAgo', () => {
  const now = at(2026, 11, 23, 12)

  test('never indexed, just now, minutes, hours, then the date', () => {
    expect(formatIndexedAgo(null, now)).toBe('Never indexed')
    expect(formatIndexedAgo(now - 5_000, now)).toBe('Indexed just now')
    expect(formatIndexedAgo(now - 60_000, now)).toBe('Indexed 1 minute ago')
    expect(formatIndexedAgo(now - 5 * 60_000, now)).toBe('Indexed 5 minutes ago')
    expect(formatIndexedAgo(now - 60 * 60_000, now)).toBe('Indexed 1 hour ago')
    expect(formatIndexedAgo(now - 3 * 3_600_000, now)).toBe('Indexed 3 hours ago')
    expect(formatIndexedAgo(now - 26 * 3_600_000, now)).toBe('Indexed 22 Nov 2026')
  })

  test('a shell clock running ahead of ours still reads as just now', () => {
    expect(formatIndexedAgo(now + 30_000, now)).toBe('Indexed just now')
  })

  test('a junk stamp reads as never indexed', () => {
    expect(formatIndexedAgo(Number.NaN, now)).toBe('Never indexed')
    expect(formatIndexedAgo(-1, now)).toBe('Never indexed')
  })
})

describe('localized event presentation', () => {
  const utc = { locale: 'en-GB', calendar: 'gregory', timeZone: 'UTC' }
  const start = Date.UTC(2026, 2, 12, 12)
  const end = Date.UTC(2026, 2, 13, 12)
  const multi: EventCluster = {
    id: 'evt_aaaaaaaaaaaaaaaaaaaa', startDate: start, endDate: end, isMultiDay: true,
    coverItemId: 'a.jpg', itemIds: ['a.jpg', 'b.jpg'],
    subDays: [
      { id: '2026-03-12', date: start, itemIds: ['a.jpg'] },
      { id: '2026-03-13', date: end, itemIds: ['b.jpg'] },
    ],
  }

  test('uses the requested locale for range punctuation, digits and plural selection', () => {
    const german = { locale: 'de-DE', calendar: 'gregory', timeZone: 'UTC' }
    expect(formatDateSpan(start, end, german)).toBe('12.–13. März 2026')
    expect(formatFrameCount(12345, { ...german, messages: { photographCount: { one: '{count} Foto', other: '{count} Fotos' } } })).toBe('12.345 Fotos')
    const arabic = {
      locale: 'ar-EG', calendar: 'gregory', timeZone: 'UTC',
      messages: {
        photographCount: { two: '{count} صورتان', other: '{count} صورة' },
        selectedPhotoCount: { other: '{count} صورة' },
      },
    }
    expect(formatFrameCount(2, arabic)).toBe('٢ صورتان')
    expect(formatSelectedPhotoCount(12, arabic)).toBe('١٢ صورة')
  })

  test('uses the requested calendar for dates, same-day detection and year boundaries', () => {
    const hebrew = { locale: 'en-US', calendar: 'hebrew', timeZone: 'UTC' }
    expect(formatDateSpan(start, start, hebrew)).toBe('23 Adar 5786')
    expect(formatSubDayLabel(multi.subDays![0], multi, hebrew)).toBe('23 Adar')
    const newYear: EventCluster = {
      ...multi,
      startDate: Date.UTC(2025, 8, 22, 12), endDate: Date.UTC(2025, 8, 24, 12),
      subDays: [
        { id: '2025-09-22', date: Date.UTC(2025, 8, 22, 12), itemIds: ['a.jpg'] },
        { id: '2025-09-24', date: Date.UTC(2025, 8, 24, 12), itemIds: ['b.jpg'] },
      ],
    }
    expect(formatSubDayLabel(newYear.subDays![0], newYear, hebrew)).toBe('29 Elul 5785')
    expect(formatSubDayLabel(newYear.subDays![1], newYear, hebrew)).toBe('2 Tishri 5786')
  })

  test('combines visible card and day text into localized accessible names', () => {
    const german = {
      locale: 'de-DE', calendar: 'gregory', timeZone: 'UTC',
      messages: {
        photographCount: { one: '{count} Foto', other: '{count} Fotos' },
        multiDay: 'Mehrtägig', daysIn: 'Tage in {date}', eventDay: '{day} ({event})',
      },
    }
    const span = formatEventDateSpan(multi, german)
    expect(formatDaysLabel(span, german)).toBe(`Tage in ${span}`)
    expect(formatEventDayLabel(multi.subDays![0], multi, span, german)).toBe(`12. März (${span})`)
    expect(formatEventCardLabel(multi, 'cloudOnly', german)).toBe(
      new Intl.ListFormat('de-DE', { style: 'long', type: 'conjunction' }).format([
        span, '2 Fotos', 'Mehrtägig', 'Not downloaded',
      ]),
    )
    expect(formatEventPreviewState('cloudOnly', { messages: { cloudOnly: 'In iCloud' } })).toBe('In iCloud')
    expect(formatMultiDayLabel({ messages: { multiDay: 'Mehrtägig' } })).toBe('Mehrtägig')
  })

  test('localizes indexed-age boundaries and absolute fallback dates', () => {
    const now = Date.UTC(2026, 10, 23, 12)
    const german = {
      locale: 'de-DE', calendar: 'gregory', timeZone: 'UTC',
      messages: {
        neverIndexed: 'Nie indexiert', indexedJustNow: 'Gerade indexiert',
        indexedMinutesAgo: '{relative} indexiert', indexedHoursAgo: '{relative} indexiert',
        indexedOn: 'Indexiert am {date}',
      },
    }
    expect(formatIndexedAgo(null, now, german)).toBe('Nie indexiert')
    expect(formatIndexedAgo(now - 5_000, now, german)).toBe('Gerade indexiert')
    expect(formatIndexedAgo(now - 120_000, now, german)).toBe('vor 2 Minuten indexiert')
    expect(formatIndexedAgo(now - 7_200_000, now, german)).toBe('vor 2 Stunden indexiert')
    expect(formatIndexedAgo(now - 86_400_000, now, german)).toBe('Indexiert am 22. Nov. 2026')
  })

  test('malformed cluster boundaries cannot break a readable sub-day', () => {
    expect(formatSubDayLabel(multi.subDays![0], { ...multi, startDate: Number.NaN, endDate: -1 }, utc)).toBe('12 Mar')
  })
})

describe('event asset contract', () => {
  test('accepts only private issued mobile thumbnail and original URLs', () => {
    const thumbnail = 'a'.repeat(64)
    const lease = '11111111-1111-4111-8111-111111111111'
    expect(isEventAssetFileUrl(`file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${thumbnail}.jpg`)).toBe(true)
    expect(isEventAssetFileUrl(`file:///Users/example/Library/Caches/event-thumbs/${thumbnail}.jpg`)).toBe(true)
    expect(isEventAssetFileUrl(`file:///private/event-originals/${lease}/${lease}.HEIC`)).toBe(true)
    expect(isEventAssetFileUrl('file:///Users/example/Photos/a.jpg')).toBe(false)
    expect(isEventAssetFileUrl('file:///C:/Photos/a.jpg')).toBe(false)
  })

  test('refuses remote, query, hash, traversal and malformed URLs', () => {
    for (const value of [
      'https://example.com/a.jpg',
      'asset://localhost/a.jpg',
      'file://server/share/a.jpg',
      'file:///Users/example/a.jpg?download=1',
      'file:///Users/example/a.jpg#frame',
      'file:///Users/example/%2e%2e/a.jpg',
      'file:///Users/example/%2E%2E/a.jpg',
      'file:///Users/example/../a.jpg',
      'file:///Users/example//a.jpg',
      'file:///Users/example/a\\b.jpg',
      'file:///Users/example/a\u0000.jpg',
      'file:///',
      null,
    ]) expect(isEventAssetFileUrl(value)).toBe(false)
  })

  test('accepts only exact opaque desktop lease URLs', () => {
    const token = '0123456789abcdef0123456789abcdef'
    expect(isEventAssetLeaseUrl(`manorama-event://localhost/${token}`)).toBe(true)
    expect(isEventAssetLeaseUrl(`http://manorama-event.localhost/${token.toUpperCase()}`)).toBe(true)
    for (const value of [
      `manorama-event://localhost/${token.slice(1)}`,
      `manorama-event://localhost/${token}0`,
      `manorama-event://localhost/${token}/extra`,
      `manorama-event://localhost/${token}?download=1`,
      `manorama-event://localhost/${token}#frame`,
      `manorama-event://localhost:80/${token}`,
      `manorama-event://user@localhost/${token}`,
      `manorama-event://example.com/${token}`,
      `manorama-event://localhost/%30${token.slice(1)}`,
      `manorama-event://localhost/${token.slice(0, 16)}%2f${token.slice(16)}`,
      `http://manorama-event.localhost:80/${token}`,
      `http://user@manorama-event.localhost/${token}`,
      `https://manorama-event.localhost/${token}`,
      `http://manorama.xyz/${token}`,
      `manorama-event://localhost/${'g'.repeat(32)}`,
      null,
    ]) expect(isEventAssetLeaseUrl(value)).toBe(false)
  })

  test('validates request bounds and desktop-incompatible network asks', () => {
    expect(isEventAssetRequest({ ids: ['a.jpg'], purpose: 'thumbnail', maxPixelSize: 512 })).toBe(true)
    expect(isEventAssetRequest({ ids: ['a.jpg'], purpose: 'viewer', allowNetwork: true })).toBe(true)
    expect(isEventAssetRequest({ ids: [], purpose: 'viewer' })).toBe(false)
    expect(isEventAssetRequest({ ids: ['a.jpg', 'a.jpg'], purpose: 'viewer' })).toBe(false)
    expect(isEventAssetRequest({ ids: ['../a.jpg'], purpose: 'viewer' })).toBe(false)
    expect(isEventAssetRequest({ ids: ['a.jpg'], purpose: 'thumbnail', maxPixelSize: 0 })).toBe(false)
    expect(isEventAssetRequest({ ids: ['a.jpg'], purpose: 'thumbnail', allowNetwork: true })).toBe(false)
    expect(isEventAssetRequest({ ids: Array.from({ length: 65 }, (_, index) => `${index}.jpg`), purpose: 'viewer' })).toBe(false)
  })

  test('preserves reply order and enforces truthful ready and unavailable states', () => {
    const parsed = parseEventAssetImages({ items: [
      { id: 'a.jpg', url: `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, width: 4032, height: 3024, state: 'ready' },
      { id: 'b.jpg', url: null, width: 0, height: 0, state: 'cloudOnly' },
      { id: 'c.jpg', url: null, width: 0, height: 0, state: 'missing' },
    ] }, ['a.jpg', 'b.jpg', 'c.jpg'])
    expect(parsed?.map((item) => item.id)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(parsed?.[1]).toEqual({ id: 'b.jpg', url: null, width: 0, height: 0, state: 'cloudOnly' })
  })

  test('a ready item needs a local URL and positive intrinsic dimensions', () => {
    for (const item of [
      { id: 'a.jpg', url: null, width: 10, height: 10, state: 'ready' },
      { id: 'a.jpg', url: 'https://example.com/a.jpg', width: 10, height: 10, state: 'ready' },
      { id: 'a.jpg', url: `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, width: 0, height: 10, state: 'ready' },
      { id: 'a.jpg', url: `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, width: 10.5, height: 10, state: 'ready' },
      { id: 'a.jpg', url: `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, width: 10, height: 10, state: 'cloudOnly' },
    ]) expect(parseEventAssetImages({ items: [item] }, ['a.jpg'])).toBeNull()
  })

  test('accepts issued mobile file URLs and opaque desktop leases as ready assets', () => {
    for (const url of [`file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, 'manorama-event://localhost/0123456789abcdef0123456789abcdef']) {
      const parsed = parseEventAssetImages({ items: [
        { id: 'a.jpg', url, width: 4032, height: 3024, state: 'ready' },
      ] }, ['a.jpg'])
      expect(parsed?.[0]?.url).toBe(url)
    }
  })

  test('a reply cannot reorder, omit or duplicate requested members', () => {
    const ready = { id: 'a.jpg', url: `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'a'.repeat(64)}.jpg`, width: 10, height: 10, state: 'ready' }
    expect(parseEventAssetImages({ items: [ready] }, ['b.jpg'])).toBeNull()
    expect(parseEventAssetImages({ items: [] }, ['a.jpg'])).toBeNull()
    expect(parseEventAssetImages({ items: [ready, ready] }, ['a.jpg', 'b.jpg'])).toBeNull()
    expect(parseEventAssetImages({ items: [ready] }, [])).toBeNull()
  })
})

describe('rawDumpStage', () => {
  const configured = {
    configured: true,
    label: 'Photos Backup',
    isAvailable: true,
    lastIndexedAt: null,
    eventCount: 0,
  }
  const scan = (clusters: EventCluster[]) => ({ clusters, screenshotCount: 0, rootPath: '/dump' })

  test('an unsupported shell and an undeclared dump are both no section', () => {
    expect(rawDumpStage(null, null, false)).toBe('unsupported')
    expect(rawDumpStage(RAW_DUMP_NOT_CONFIGURED, null, false)).toBe('not-configured')
    // A failed scan cannot promote an undeclared dump into anything.
    expect(rawDumpStage(RAW_DUMP_NOT_CONFIGURED, null, true)).toBe('not-configured')
  })

  test('a declared but unreachable dump is stated before it is indexed', () => {
    expect(rawDumpStage({ ...configured, isAvailable: false }, null, true)).toBe('unavailable')
  })

  test('reachable, waiting, then ready or empty', () => {
    expect(rawDumpStage(configured, null, false)).toBe('indexing')
    expect(rawDumpStage(configured, null, true)).toBe('failed')
    expect(rawDumpStage(configured, scan([]), false)).toBe('empty')
    expect(rawDumpStage(configured, scan([parseEventCluster(clusterWire()) as EventCluster]), false)).toBe('ready')
  })
})
