import { describe, expect, test } from 'bun:test'
import {
  RAW_DUMP_CHANGED_EVENT,
  clearRawDumpRoot,
  createEventClustering,
  eventAssetSrc,
  getEventAssetImage,
  getRawDumpStatus,
  onRawDumpChanged,
  pickRawDumpRoot,
  readEventAssetRange,
  revealEventAsset,
  scanRawDumpEvents,
  type RawDumpBridge,
} from './event-clustering'

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime()

type Stub = {
  bridge: RawDumpBridge
  calls: { command: string; args: Record<string, unknown> | undefined }[]
  emit: () => void
  listeners: number
}

const stub = (answers: Record<string, unknown> = {}): Stub => {
  const calls: Stub['calls'] = []
  const handlers = new Set<(payload: unknown) => void>()
  return {
    calls,
    get listeners() { return handlers.size },
    emit: () => { for (const handler of handlers) handler({ event: RAW_DUMP_CHANGED_EVENT }) },
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

const commands = (value: Stub) => value.calls.map((call) => call.command)
const status = {
  configured: true,
  label: 'Photos Backup',
  isAvailable: true,
  lastIndexedAt: at(2026, 11, 22, 9),
  eventCount: 2,
}
const lease = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'
const ready = (id: string, url = lease) => ({
  id, url, width: 4032, height: 3024, state: 'ready',
})

describe('raw dump commands', () => {
  test('status parses an answer and distinguishes unsupported from undeclared', async () => {
    const shell = stub({ get_raw_dump_status: status })
    await expect(getRawDumpStatus(shell.bridge)).resolves.toEqual(status)
    expect(shell.calls).toEqual([{ command: 'get_raw_dump_status', args: undefined }])
    expect(await getRawDumpStatus(stub({ get_raw_dump_status: { configured: false } }).bridge)).toEqual({
      configured: false, label: null, isAvailable: false, lastIndexedAt: null, eventCount: 0,
    })
    expect(await getRawDumpStatus(stub().bridge)).toBeNull()
    expect(await getRawDumpStatus(stub({ get_raw_dump_status: new Error('no such command') }).bridge)).toBeNull()
  })

  test('a half status keeps only the fields it can prove', async () => {
    const shell = stub({ get_raw_dump_status: { configured: true, label: 'Camera Roll', eventCount: 'lots' } })
    expect(await getRawDumpStatus(shell.bridge)).toEqual({
      configured: true, label: 'Camera Roll', isAvailable: false, lastIndexedAt: null, eventCount: 0,
    })
  })

  test('the picker returns a labelled declaration or a cancel', async () => {
    const chosen = stub({ pick_raw_dump_root: { label: 'Google Photos', itemCount: 12480, rootPath: '/dump' } })
    await expect(pickRawDumpRoot(chosen.bridge)).resolves.toEqual({ label: 'Google Photos', itemCount: 12480, rootPath: '/dump' })
    expect(commands(chosen)).toEqual(['pick_raw_dump_root'])
    await expect(pickRawDumpRoot(stub({ pick_raw_dump_root: null }).bridge)).resolves.toBeNull()
    await expect(pickRawDumpRoot(stub({ pick_raw_dump_root: new Error('bookmark write failed') }).bridge)).rejects.toThrow('bookmark write failed')
  })

  test('scan is incremental unless forced and parses clusters', async () => {
    const shell = stub({
      scan_raw_dump_events: {
        clusters: [{
          id: 'evt_aaaaaaaaaaaaaaaaaaaa', startDate: at(2026, 3, 12, 9), endDate: at(2026, 3, 12, 20),
          isMultiDay: false, coverItemId: 'a.jpg', itemIds: ['a.jpg', 'b.jpg'],
        }, { id: 'bogus' }],
        screenshotCount: 611, rootPath: '/dump',
      },
    })
    await scanRawDumpEvents({}, shell.bridge)
    await scanRawDumpEvents({ force: true }, shell.bridge)
    expect(shell.calls.map((call) => call.args)).toEqual([{}, { force: true }])
    const result = await scanRawDumpEvents({}, shell.bridge)
    expect(result.screenshotCount).toBe(611)
    expect(result.clusters.map((cluster) => cluster.id)).toEqual(['evt_aaaaaaaaaaaaaaaaaaaa'])
  })

  test('scan failures propagate instead of rendering an empty timeline', async () => {
    const shell = stub({ scan_raw_dump_events: new Error('the folder could not be reached') })
    await expect(scanRawDumpEvents({}, shell.bridge)).rejects.toThrow('could not be reached')
  })

  test('clear names only the declaration command', async () => {
    const shell = stub({ clear_raw_dump_root: null })
    await expect(clearRawDumpRoot(shell.bridge)).resolves.toBeUndefined()
    expect(commands(shell)).toEqual(['clear_raw_dump_root'])
  })
})

describe('onRawDumpChanged', () => {
  test('an emit reaches the handler and unlisten removes it', async () => {
    const shell = stub()
    let seen = 0
    const off = await onRawDumpChanged(() => { seen++ }, shell.bridge)
    expect(shell.listeners).toBe(1)
    shell.emit()
    expect(seen).toBe(1)
    off()
    shell.emit()
    expect(seen).toBe(1)
    expect(shell.listeners).toBe(0)
  })

  test('missing and rejected listener seams degrade to a callable no-op', async () => {
    const invokeOnly: RawDumpBridge = { invoke: async () => null }
    const off = await onRawDumpChanged(() => {}, invokeOnly)
    expect(() => off()).not.toThrow()
    const rejected: RawDumpBridge = { invoke: async () => null, listen: async () => { throw new Error('no event plugin') } }
    expect(typeof (await onRawDumpChanged(() => {}, rejected))).toBe('function')
  })
})

describe('native event assets', () => {
  test('uses the asset command with top-level contract arguments', async () => {
    const shell = stub({ get_event_asset_image: { items: [ready('a.jpg')] } })
    await expect(getEventAssetImage({ ids: ['a.jpg'], purpose: 'thumbnail', maxPixelSize: 512 }, shell.bridge)).resolves.toEqual([ready('a.jpg')])
    expect(shell.calls).toEqual([{
      command: 'get_event_asset_image',
      args: { ids: ['a.jpg'], purpose: 'thumbnail', maxPixelSize: 512, allowNetwork: false },
    }])
  })

  test('preserves order and accepts cloud, missing and failed states with no URL', async () => {
    const shell = stub({ get_event_asset_image: { items: [
      ready('a.jpg'),
      { id: 'b.jpg', url: null, width: 0, height: 0, state: 'cloudOnly' },
      { id: 'c.jpg', url: null, width: 0, height: 0, state: 'missing' },
      { id: 'd.jpg', url: null, width: 0, height: 0, state: 'failed' },
    ] } })
    const items = await getEventAssetImage({ ids: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], purpose: 'thumbnail' }, shell.bridge)
    expect(items.map((item) => item.state)).toEqual(['ready', 'cloudOnly', 'missing', 'failed'])
    expect(items.slice(1).every((item) => item.url === null)).toBe(true)
  })

  test('rejects malformed, remote, reordered and untruthful replies', async () => {
    for (const items of [
      [ready('b.jpg')],
      [{ ...ready('a.jpg'), url: 'https://example.com/a.jpg' }],
      [{ ...ready('a.jpg'), url: 'file:///tmp/a.jpg' }],
      [{ ...ready('a.jpg'), url: 'file:///tmp/a.jpg?download=1' }],
      [{ ...ready('a.jpg'), width: 0 }],
      [{ ...ready('a.jpg'), state: 'cloudOnly' }],
      [{ id: 'a.jpg', url: null, width: 0, height: 0, state: 'ready' }],
    ]) {
      const shell = stub({ get_event_asset_image: { items } })
      await expect(getEventAssetImage({ ids: ['a.jpg'], purpose: 'viewer' }, shell.bridge)).rejects.toThrow('reply could not be read')
    }
  })

  test('refuses invalid requests and every network ask before invoking', async () => {
    const shell = stub()
    await expect(getEventAssetImage({ ids: ['a.jpg'], purpose: 'viewer', allowNetwork: true }, shell.bridge)).rejects.toThrow('never download')
    await expect(getEventAssetImage({ ids: ['../a.jpg'], purpose: 'viewer' }, shell.bridge)).rejects.toThrow('Invalid event photograph')
    await expect(getEventAssetImage({ ids: ['a.jpg'], purpose: 'thumbnail', maxPixelSize: 0 }, shell.bridge)).rejects.toThrow('Invalid event photograph')
    expect(commands(shell)).toEqual([])
  })

  test('passes through only exact opaque native leases', () => {
    const unix = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'
    const windows = 'http://manorama-event.localhost/0123456789abcdef0123456789abcdef'
    expect(eventAssetSrc(unix)).toBe(unix)
    expect(eventAssetSrc(windows)).toBe(windows)
    expect(eventAssetSrc('manorama-event://localhost/0123456789abcdef0123456789abcdef?download=1')).toBeNull()
    expect(eventAssetSrc('file:///Users/example/Photos/a.jpg')).toBeNull()
    expect(eventAssetSrc('file:///C:/Photos/a.jpg')).toBeNull()
    expect(eventAssetSrc('https://example.com/a.jpg')).toBeNull()
    expect(eventAssetSrc(null)).toBeNull()
  })

  test('reads embedded metadata only through bounded verified lease ranges', async () => {
    const url = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'
    const bytes = new Uint8Array([1, 2, 3, 4])
    const realFetch = globalThis.fetch
    const calls: Parameters<typeof fetch>[] = []
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args)
      return new Response(bytes, {
        status: 206,
        headers: { 'Content-Range': 'bytes 512-515/4096' },
      })
    }) as typeof fetch
    try {
      await expect(readEventAssetRange(url, 512, 4)).resolves.toEqual(bytes)
      expect(calls).toEqual([[url, {
        headers: { Range: 'bytes=512-515' },
        credentials: 'omit',
        cache: 'no-store',
      }]])
      await expect(readEventAssetRange(url, -1, 4)).rejects.toThrow('Invalid event photograph range')
      await expect(readEventAssetRange(url, 0, 2 * 1024 * 1024 + 1)).rejects.toThrow('Invalid event photograph range')
      await expect(readEventAssetRange('https://example.com/a.jpg', 0, 4)).rejects.toThrow('Invalid event photograph range')
      expect(calls).toHaveLength(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('refuses full-file, malformed and incomplete range responses', async () => {
    const url = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'
    const realFetch = globalThis.fetch
    const responses = [
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 206, headers: { 'Content-Range': 'bytes 0-4/100' } }),
      new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Range': 'bytes 0-3/100' } }),
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 416 }),
    ]
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch
    try {
      for (let index = 0; index < 4; index++) {
        await expect(readEventAssetRange(url, 0, 4)).rejects.toThrow('range')
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the client never falls back to a renderer-joined original', async () => {
    const url = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'
    const shell = stub({ get_event_asset_image: { items: [ready('a.jpg', url)] } })
    const client = createEventClustering(shell.bridge)
    const [photo] = await client.images({ ids: ['a.jpg'], purpose: 'viewer' })
    expect(photo?.src).toBe(url)
  })

  test('a late reply after clear is cancelled before its URL reaches the renderer', async () => {
    let resolve!: (value: unknown) => void
    const bridge: RawDumpBridge = {
      invoke: (command) => command === 'get_event_asset_image'
        ? new Promise((done) => { resolve = done })
        : Promise.resolve(null),
    }
    const client = createEventClustering(bridge)
    const pending = client.images({ ids: ['a.jpg'], purpose: 'viewer' })
    await client.clear()
    resolve({ items: [ready('a.jpg')] })
    await expect(pending).rejects.toThrow('cancelled')
  })

  test('reveal validates the member and names the native command', async () => {
    const shell = stub({ reveal_event_asset: null })
    await expect(revealEventAsset('2026/a.jpg', shell.bridge)).resolves.toBeUndefined()
    expect(shell.calls).toEqual([{ command: 'reveal_event_asset', args: { id: '2026/a.jpg' } }])
    await expect(revealEventAsset('../a.jpg', shell.bridge)).rejects.toThrow('Invalid event photograph')
    expect(commands(shell)).toEqual(['reveal_event_asset'])
  })
})
