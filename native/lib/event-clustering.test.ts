import { describe, expect, test } from 'bun:test'
import { Capacitor } from '@capacitor/core'
import { createEventClustering, isEventClusteringAvailable, type EventClusteringBridge } from './event-clustering'
import { isEventAssetFileUrl, isEventAssetRequest, parseEventAssetImages, parseEventAssetProgress, parseRawDumpStatus } from '../../packages/core/event-clustering'

const original = 'file:///private/container/tmp/event-originals/01234567-0123-0123-0123-012345678901/01234567-0123-0123-0123-012345678902.jpg'
const thumbnail = `file:///private/container/Library/Caches/event-thumbs/${'a'.repeat(64)}.jpg`
const androidThumbnail = `file:///data/user/0/in.thecontrarian.manorama/cache/event-thumbs/${'b'.repeat(64)}.jpg`
const ready = (id: string) => ({ id, url: original, width: 1200, height: 800, state: 'ready' })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const fake = (overrides: Partial<EventClusteringBridge> = {}) => {
  const listeners = new Map<string, (value: unknown) => void>()
  const released: string[][] = []
  const cancelled: string[][] = []
  const requests: unknown[] = []
  const bridge: EventClusteringBridge = {
    getRawDumpStatus: async () => ({ configured: false, authorization: 'notDetermined', downloadCloudOnOpen: false }),
    pickRawDumpRoot: async () => ({ label: 'Camera Roll', itemCount: 2, rootPath: null }),
    scanRawDumpEvents: async () => ({ clusters: [], screenshotCount: 0, rootPath: null }),
    clearRawDumpRoot: async () => null,
    getEventAssetImage: async (options) => { requests.push(options); return { items: options.ids.map(ready) } },
    cancelEventAssetImage: async ({ ids }) => { cancelled.push(ids); return null },
    releaseEventAssetImages: async ({ urls }) => { released.push(urls); return null },
    setEventCloudDownload: async () => null,
    presentLimitedLibraryPicker: async () => null,
    openEventPhotosSettings: async () => null,
    openEventAssetInPhotos: async () => null,
    addListener: async (event, listener) => { listeners.set(event, listener); return { remove: async () => { listeners.delete(event) } } },
    ...overrides,
  }
  return { bridge, listeners, released, cancelled, requests }
}

describe('event pixel contract', () => {
  test('opaque IDs, unique batch cap and only one explicit original may network', () => {
    expect(isEventAssetRequest({ ids: ['asset/L0/001'], purpose: 'thumbnail' })).toBe(true)
    for (const ids of [['../x'], ['x/../a'], ['/x'], ['x//a'], ['x\\a'], ['x:x'], ['x\u0000'], ['x\u007f'], ['x', 'x'], [], Array.from({ length: 65 }, (_, i) => `x${i}`)]) {
      expect(isEventAssetRequest({ ids, purpose: 'viewer' })).toBe(false)
    }
    expect(isEventAssetRequest({ ids: ['x'], purpose: 'thumbnail', allowNetwork: true })).toBe(false)
    expect(isEventAssetRequest({ ids: ['x', 'y'], purpose: 'viewer', allowNetwork: true })).toBe(false)
    expect(isEventAssetRequest({ ids: ['x'], purpose: 'viewer', allowNetwork: true })).toBe(true)
  })
  test('only private issued-directory file URLs reach convertFileSrc', () => {
    expect(isEventAssetFileUrl(original)).toBe(true)
    expect(isEventAssetFileUrl(thumbnail)).toBe(true)
    expect(isEventAssetFileUrl(androidThumbnail)).toBe(true)
    for (const url of ['https://example.test/image.jpg', 'file://remote/tmp/photo.jpg', 'file:///etc/passwd', `${original}?x=1`, original.replace('tmp/', 'tmp/../'), original.replace('tmp/', 'tmp/%2e%2e/'), original.replace('tmp/', 'tmp/%00/'), `${original}#fragment`, androidThumbnail.replace('event-thumbs', 'event-thumbs/../')]) expect(isEventAssetFileUrl(url)).toBe(false)
  })
  test('all states retain order; no partial, duplicate or forged pixel reply', () => {
    const states = ['ready', 'cloudOnly', 'downloading', 'failed', 'missing']
    const ids = states.map((_, index) => `id${index}`)
    const items = states.map((state, index) => ({ id: ids[index], state, url: state === 'ready' ? original : null, width: state === 'ready' ? 20 : 0, height: state === 'ready' ? 10 : 0 }))
    expect(parseEventAssetImages({ items }, ids)?.map((item) => item.state)).toEqual(states)
    expect(parseEventAssetImages({ items: items.slice(1) }, ids)).toBeNull()
    expect(parseEventAssetImages({ items: [...items].reverse() }, ids)).toBeNull()
    for (const patch of [{ state: 'other' }, { url: 'https://example.test/image.jpg' }, { width: 0 }, { height: -1 }, { id: '../escape' }]) expect(parseEventAssetImages({ items: [{ ...ready('id'), ...patch }] }, ['id'])).toBeNull()
    expect(parseEventAssetImages({ items: [{ ...ready('id'), state: 'cloudOnly' }] }, ['id'])).toBeNull()
  })
  test('permission state survives an unconfigured status without querying Photos', () => {
    for (const authorization of ['notDetermined', 'denied', 'restricted', 'limited', 'authorized']) {
      expect(parseRawDumpStatus({ configured: false, authorization, selectedPhotoCount: null })?.authorization).toBe(authorization)
    }
    expect(parseRawDumpStatus({ configured: true, authorization: 'limited', selectedPhotoCount: 12 })?.selectedPhotoCount).toBe(12)
  })
  test('progress rejects every out-of-range and hostile state', () => {
    expect(parseEventAssetProgress({ id: 'id', fraction: 0 })).toEqual({ id: 'id', fraction: 0 })
    expect(parseEventAssetProgress({ id: 'id', fraction: 1 })).not.toBeNull()
    for (const fraction of [-1, 1.01, NaN, Infinity, '0.5', null]) expect(parseEventAssetProgress({ id: 'id', fraction })).toBeNull()
    expect(parseEventAssetProgress({ id: '../x', fraction: 0.5 })).toBeNull()
  })
})

describe('Capacitor event wrapper', () => {
  test('plain web stays unavailable even if another native capability exists', async () => {
    expect(Capacitor.isNativePlatform()).toBe(false)
    expect(await isEventClusteringAvailable()).toBe(false)
    expect(await isEventClusteringAvailable(createEventClustering(fake().bridge))).toBe(true)
    expect(await isEventClusteringAvailable(createEventClustering(fake({ getRawDumpStatus: async () => null }).bridge))).toBe(false)
    expect(await isEventClusteringAvailable(createEventClustering(fake({ getRawDumpStatus: async () => { throw new Error('not implemented') } }).bridge))).toBe(false)
  })
  test('validates all command replies and never converts absent pixels', async () => {
    const deps = fake({ getEventAssetImage: async ({ ids }) => ({ items: ids.map((id) => ({ id, url: null, width: 0, height: 0, state: 'missing' })) }) })
    let conversions = 0
    const client = createEventClustering(deps.bridge, () => { conversions++; return 'converted' })
    expect(await client.pick()).toEqual({ label: 'Camera Roll', itemCount: 2, rootPath: null })
    expect(await client.scan()).toEqual({ clusters: [], screenshotCount: 0, rootPath: null })
    expect((await client.images({ ids: ['a'], purpose: 'viewer' }))[0].src).toBeNull()
    expect(conversions).toBe(0)
    await expect(client.images({ ids: ['../a'], purpose: 'viewer' })).rejects.toThrow()
  })
  test('forged URLs never reach the converter', async () => {
    let conversions = 0
    const client = createEventClustering(fake({ getEventAssetImage: async () => ({ items: [{ ...ready('a'), url: 'https://bad.test/a.jpg' }] }) }).bridge, () => { conversions++; return '' })
    await expect(client.images({ ids: ['a'], purpose: 'viewer' })).rejects.toThrow('could not be read')
    expect(conversions).toBe(0)
    await client.close()
  })
  test('a thumbnail URL can never masquerade as a viewer original', async () => {
    for (const url of [thumbnail, androidThumbnail]) {
      let conversions = 0
      const client = createEventClustering(fake({ getEventAssetImage: async () => ({ items: [{ ...ready('a'), url }] }) }).bridge, () => { conversions++; return '' })
      await expect(client.images({ ids: ['a'], purpose: 'viewer' })).rejects.toThrow('wrong rendition')
      expect(conversions).toBe(0)
    }
  })
  test('an original URL can never masquerade as an Android thumbnail', async () => {
    let conversions = 0
    const client = createEventClustering(fake({ getEventAssetImage: async () => ({ items: [{ ...ready('a'), url: original }] }) }).bridge, () => { conversions++; return '' })
    await expect(client.images({ ids: ['a'], purpose: 'thumbnail' })).rejects.toThrow('wrong rendition')
    expect(conversions).toBe(0)
  })
  test('clear racing an original releases a late copy rather than reviving it', async () => {
    const pending = deferred<unknown>()
    const deps = fake({ getEventAssetImage: () => pending.promise })
    const client = createEventClustering(deps.bridge, (url) => url)
    const operation = client.images({ ids: ['a'], purpose: 'viewer' })
    await client.clear()
    pending.resolve({ items: [ready('a')] })
    await expect(operation).rejects.toThrow('cancelled')
    expect(deps.released).toEqual([[original]])
  })
  test('only active current-photo download emits progress; cancel stops later events', async () => {
    const pending = deferred<unknown>()
    const deps = fake({ getEventAssetImage: () => pending.promise })
    const client = createEventClustering(deps.bridge, (url) => url)
    const values: number[] = []
    const subscription = await client.progress((value) => values.push(value.fraction))
    const operation = client.images({ ids: ['a'], purpose: 'viewer', allowNetwork: true })
    const emit = deps.listeners.get('eventAssetProgress')!
    emit({ id: 'a', fraction: 0.5 }); emit({ id: 'other', fraction: 0.9 }); emit({ id: 'a', fraction: 2 })
    await client.cancel(['a'])
    emit({ id: 'a', fraction: 1 })
    pending.resolve({ items: [{ id: 'a', url: null, width: 0, height: 0, state: 'failed' }] })
    await expect(operation).rejects.toThrow('cancelled')
    expect(values).toEqual([0.5]); expect(deps.cancelled).toEqual([['a']])
    await subscription.remove()
  })
  test('close releases more than 64 original leases in bounded batches', async () => {
    const deps = fake({ getEventAssetImage: async ({ ids }) => ({ items: ids.map((id) => ({ ...ready(id), url: original.replace('012345678902.jpg', `${id.padStart(12, '0')}.jpg`) })) }) })
    const client = createEventClustering(deps.bridge, (url) => url)
    for (let index = 0; index < 130; index++) await client.images({ ids: [String(index)], purpose: 'viewer' })
    await client.close()
    expect(deps.released.map((batch) => batch.length)).toEqual([64, 64, 2])
  })
  test('close releases owned originals and default requests never network', async () => {
    const deps = fake()
    const client = createEventClustering(deps.bridge, () => 'file-converted')
    expect((await client.images({ ids: ['a'], purpose: 'viewer' }))[0].src).toBe('file-converted')
    expect(deps.requests).toEqual([{ ids: ['a'], purpose: 'viewer', allowNetwork: false }])
    await client.close()
    expect(deps.released).toEqual([[original]])
  })
})
