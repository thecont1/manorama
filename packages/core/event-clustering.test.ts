import { describe, expect, test } from 'bun:test'
import {
  MAX_EVENT_MEMBERS,
  RAW_DUMP_NOT_CONFIGURED,
  formatEventDateSpan,
  formatEventFrameCount,
  formatDateSpan,
  formatFrameCount,
  formatIndexedAgo,
  formatSubDayLabel,
  joinDumpPath,
  orderedSubDays,
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
    expect(formatDateSpan(at(2026, 3, 12, 9), at(2026, 3, 16, 18))).toBe('12–16 Mar 2026')
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

describe('joinDumpPath', () => {
  test('joins a relative member under the root', () => {
    expect(joinDumpPath('/Users/home/Backups/Photos', '2026/03/IMG_4821.jpg'))
      .toBe('/Users/home/Backups/Photos/2026/03/IMG_4821.jpg')
    // A trailing separator on the root does not double up.
    expect(joinDumpPath('/Users/home/Backups/Photos/', 'a.jpg'))
      .toBe('/Users/home/Backups/Photos/a.jpg')
  })

  test('refuses to leave the declared folder', () => {
    expect(joinDumpPath('/dump', '../../etc/passwd')).toBeNull()
    expect(joinDumpPath('/dump', '2026/../../etc/passwd')).toBeNull()
    expect(joinDumpPath('/dump', '../outside.jpg')).toBeNull()
    // An absolute id would replace the root whole.
    expect(joinDumpPath('/dump', '/etc/passwd')).toBeNull()
    expect(joinDumpPath('/dump', '\\etc\\passwd')).toBeNull()
    expect(joinDumpPath('/dump', './a.jpg')).toBeNull()
    expect(joinDumpPath('/dump', 'a//b.jpg')).toBeNull()
    expect(joinDumpPath('/dump', '')).toBeNull()
    expect(joinDumpPath('/dump', 'a\u0000.jpg')).toBeNull()
  })

  test('no root means no path to build', () => {
    // iOS answers no root at all; an asset identifier is resolved by the
    // shell's own protocol, so a caller that expected a path must not get one.
    expect(joinDumpPath(null, 'a.jpg')).toBeNull()
    expect(joinDumpPath(undefined, 'a.jpg')).toBeNull()
    expect(joinDumpPath('', 'a.jpg')).toBeNull()
    expect(joinDumpPath('/', 'a.jpg')).toBeNull()
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
