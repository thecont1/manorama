import { describe, expect, test } from 'bun:test'
import {
  RAW_DUMP_CHANGED_EVENT,
  clearRawDumpRoot,
  eventGalleryRecord,
  getRawDumpStatus,
  onRawDumpChanged,
  pickRawDumpRoot,
  scanRawDumpEvents,
  type RawDumpBridge,
} from './event-clustering'
import { parseEventCluster, type EventCluster } from '../../packages/core/event-clustering'

/**
 * The bridge is the only place this feature talks to the shell, so the two
 * things worth proving are that it says the contract's command names with the
 * contract's arguments, and that an answer it does not like cannot reach a
 * page as a thrown surprise. The bridge is injected — the same seam
 * `local-scan.ts` uses for its directory reader — so none of this needs
 * `@tauri-apps` or a running shell.
 */

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime()

type Stub = {
  bridge: RawDumpBridge
  calls: { command: string; args: Record<string, unknown> | undefined }[]
  emit: () => void
  listeners: number
}

/** `answers` maps a command to the reply, or an Error to reject with. */
const stub = (answers: Record<string, unknown> = {}): Stub => {
  const calls: Stub['calls'] = []
  const handlers = new Set<(payload: unknown) => void>()
  return {
    calls,
    get listeners() {
      return handlers.size
    },
    emit: () => {
      for (const handler of handlers) handler({ event: RAW_DUMP_CHANGED_EVENT })
    },
    bridge: {
      invoke: async (command, args) => {
        calls.push({ command, args })
        const answer = answers[command]
        if (answer instanceof Error) throw answer
        return answer ?? null
      },
      listen: async (_event, handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
  }
}

const commands = (stubValue: Stub) => stubValue.calls.map((call) => call.command)

const status = {
  configured: true,
  label: 'Photos Backup',
  isAvailable: true,
  lastIndexedAt: at(2026, 11, 22, 9),
  eventCount: 2,
}

describe('getRawDumpStatus', () => {
  test('asks for the status and parses the answer', async () => {
    const shell = stub({ get_raw_dump_status: status })
    await expect(getRawDumpStatus(shell.bridge)).resolves.toEqual(status)
    expect(shell.calls).toEqual([{ command: 'get_raw_dump_status', args: undefined }])
  })

  test('an explicit “no folder” answer is not the same as no answer', async () => {
    const declared = stub({ get_raw_dump_status: { configured: false } })
    expect(await getRawDumpStatus(declared.bridge)).toEqual({
      configured: false,
      label: null,
      isAvailable: false,
      lastIndexedAt: null,
      eventCount: 0,
    })
    const missing = stub()
    expect(await getRawDumpStatus(missing.bridge)).toBeNull()
  })

  test('a shell that rejects the command reads as unsupported, not as a crash', async () => {
    const shell = stub({ get_raw_dump_status: new Error('no such command') })
    await expect(getRawDumpStatus(shell.bridge)).resolves.toBeNull()
  })

  test('half an answer keeps the halves it has', async () => {
    const shell = stub({ get_raw_dump_status: { configured: true, label: 'Camera Roll', eventCount: 'lots' } })
    expect(await getRawDumpStatus(shell.bridge)).toEqual({
      configured: true,
      label: 'Camera Roll',
      isAvailable: false,
      lastIndexedAt: null,
      eventCount: 0,
    })
  })
})

describe('pickRawDumpRoot', () => {
  test('a chosen folder comes back labelled, with its root', async () => {
    const shell = stub({ pick_raw_dump_root: { label: 'Google Photos', itemCount: 12480, rootPath: '/dump' } })
    await expect(pickRawDumpRoot(shell.bridge)).resolves.toEqual({
      label: 'Google Photos',
      itemCount: 12480,
      rootPath: '/dump',
    })
    expect(commands(shell)).toEqual(['pick_raw_dump_root'])
  })

  test('a cancel answers null — iOS has no path, so the field is optional', async () => {
    const cancelled = stub({ pick_raw_dump_root: null })
    await expect(pickRawDumpRoot(cancelled.bridge)).resolves.toBeNull()
    const ios = stub({ pick_raw_dump_root: { label: 'Camera Roll', itemCount: 812, rootPath: null } })
    await expect(pickRawDumpRoot(ios.bridge)).resolves.toEqual({
      label: 'Camera Roll',
      itemCount: 812,
      rootPath: null,
    })
  })

  test('a native failure is told to the page, because the folder is not taken', async () => {
    const shell = stub({ pick_raw_dump_root: new Error('bookmark write failed') })
    await expect(pickRawDumpRoot(shell.bridge)).rejects.toThrow('bookmark write failed')
  })
})

describe('scanRawDumpEvents', () => {
  test('incremental by default, forced only when asked', async () => {
    const shell = stub({ scan_raw_dump_events: { clusters: [], screenshotCount: 0, rootPath: '/dump' } })
    await scanRawDumpEvents({}, shell.bridge)
    await scanRawDumpEvents({ force: true }, shell.bridge)
    expect(shell.calls.map((call) => call.args)).toEqual([{}, { force: true }])
  })

  test('the clusters are parsed, not passed through raw', async () => {
    const shell = stub({
      scan_raw_dump_events: {
        clusters: [
          {
            id: 'evt_aaaaaaaaaaaaaaaaaaaa',
            startDate: at(2026, 3, 12, 9),
            endDate: at(2026, 3, 12, 20),
            isMultiDay: false,
            coverItemId: 'a.jpg',
            itemIds: ['a.jpg', 'b.jpg'],
          },
          { id: 'bogus' },
        ],
        screenshotCount: 611,
        rootPath: '/dump',
      },
    })
    const result = await scanRawDumpEvents({}, shell.bridge)
    expect(result.screenshotCount).toBe(611)
    expect(result.rootPath).toBe('/dump')
    expect(result.clusters.map((cluster) => cluster.id)).toEqual(['evt_aaaaaaaaaaaaaaaaaaaa'])
  })

  test('an unreachable root is a rejection the page has to show', async () => {
    const shell = stub({ scan_raw_dump_events: new Error('the folder could not be reached') })
    await expect(scanRawDumpEvents({}, shell.bridge)).rejects.toThrow('could not be reached')
  })
})

describe('clearRawDumpRoot', () => {
  test('names the command and answers nothing', async () => {
    const shell = stub({ clear_raw_dump_root: null })
    await expect(clearRawDumpRoot(shell.bridge)).resolves.toBeUndefined()
    expect(commands(shell)).toEqual(['clear_raw_dump_root'])
  })
})

describe('onRawDumpChanged', () => {
  test('a shell emit reaches the handler, and the unlisten stops it', async () => {
    const shell = stub()
    let seen = 0
    const unlisten = await onRawDumpChanged(() => {
      seen += 1
    }, shell.bridge)
    expect(shell.listeners).toBe(1)
    shell.emit()
    expect(seen).toBe(1)
    unlisten()
    shell.emit()
    expect(seen).toBe(1)
    expect(shell.listeners).toBe(0)
  })

  test('no listener seam is a no-op, not a crash', async () => {
    const invokeOnly: RawDumpBridge = { invoke: async () => null }
    const unlisten = await onRawDumpChanged(() => {}, invokeOnly)
    expect(() => unlisten()).not.toThrow()
  })

  test('a rejected listen degrades to a no-op unlisten', async () => {
    const shell: RawDumpBridge = {
      invoke: async () => null,
      listen: async () => {
        throw new Error('no event plugin')
      },
    }
    // A rejected listen still answers a callable: the subscriber's teardown
    // must never be the thing that throws on the way out.
    expect(typeof (await onRawDumpChanged(() => {}, shell))).toBe('function')
  })
})

describe('eventGalleryRecord', () => {
  const cluster = (overrides: Partial<EventCluster> = {}): EventCluster =>
    parseEventCluster({
      id: 'evt_aaaaaaaaaaaaaaaaaaaa',
      startDate: at(2026, 3, 12, 9),
      endDate: at(2026, 3, 13, 20),
      isMultiDay: true,
      coverItemId: '2026/03/IMG_4821.jpg',
      itemIds: ['2026/03/IMG_4821.jpg', '2026/03/IMG_4822.jpg'],
      ...overrides,
    }) as EventCluster

  test('members become viewer items under the dump root', () => {
    const record = eventGalleryRecord(cluster(), '/Users/home/Backups/Photos')
    expect(record?.id).toBe('evt_aaaaaaaaaaaaaaaaaaaa')
    // The title is the span the card wears — no invented event name.
    expect(record?.title).toBe('12–13 Mar 2026')
    expect(record?.rootPath).toBe('/Users/home/Backups/Photos')
    expect(record?.sourceKind).toBe('folder')
    expect(record?.itemCount).toBe(2)
    expect(record?.items).toEqual([
      {
        id: '2026/03/IMG_4821.jpg',
        name: 'IMG_4821.jpg',
        path: '/Users/home/Backups/Photos/2026/03/IMG_4821.jpg',
      },
      {
        id: '2026/03/IMG_4822.jpg',
        name: 'IMG_4822.jpg',
        path: '/Users/home/Backups/Photos/2026/03/IMG_4822.jpg',
      },
    ])
    // Nothing is claimed about order or concealment the shell did not say.
    expect(record?.hidden).toBeUndefined()
    expect(record?.pinnedAt).toBeUndefined()
  })

  test('a member that will not join under the root is dropped, not pointed outside', () => {
    const record = eventGalleryRecord(
      cluster({ itemIds: ['a.jpg', '../../etc/passwd', 'b.jpg'] }),
      '/dump',
    )
    expect(record?.items.map((item) => item.id)).toEqual(['a.jpg', 'b.jpg'])
    expect(record?.itemCount).toBe(2)
  })

  test('an event with nowhere to read from does not open', () => {
    expect(eventGalleryRecord(cluster(), null)).toBeNull()
    expect(eventGalleryRecord(cluster({ itemIds: ['../escape.jpg'] }), '/dump')).toBeNull()
  })

  test('the record is stamped from the event, not from the clock', () => {
    const record = eventGalleryRecord(cluster(), '/dump')
    expect(record?.addedAt).toBe(new Date(at(2026, 3, 12, 9)).toISOString())
    expect(record?.lastSeenAt).toBe(record?.addedAt)
  })
})
