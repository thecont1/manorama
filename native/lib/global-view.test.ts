import { describe, expect, test } from 'bun:test'
import type { OfflineGridFrame, OfflineObjectUrlProvider } from './offline-gallery'
import {
  GLOBAL_VIEW_PREFERENCE_KEY,
  GridThumbLoader,
  loadGlobalViewEnabled,
  saveGlobalViewEnabled,
} from './global-view'

const memoryPersistence = () => {
  const map = new Map<string, string>()
  return {
    map,
    async get(key: string) { return map.get(key) ?? null },
    async set(key: string, value: string) { map.set(key, value) },
  }
}

const frame = (entryId: string, mimeType = 'image/jpeg'): OfflineGridFrame => ({
  id: entryId,
  entryId,
  mimeType,
  width: 800,
  height: 600,
  alt: '',
  index: 0,
})

const countingUrls = (): OfflineObjectUrlProvider & { created: string[]; revoked: string[] } => {
  const created: string[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    create() {
      const url = `blob:mock-${created.length}`
      created.push(url)
      return url
    },
    revoke(url) {
      revoked.push(url)
    },
  }
}

describe('global view preference', () => {
  test('absent or corrupt values read as off', async () => {
    const persistence = memoryPersistence()
    expect(await loadGlobalViewEnabled(persistence)).toBe(false)
    await persistence.set(GLOBAL_VIEW_PREFERENCE_KEY, 'yes')
    expect(await loadGlobalViewEnabled(persistence)).toBe(false)
  })

  test('saves and restores the opt-in flag', async () => {
    const persistence = memoryPersistence()
    await saveGlobalViewEnabled(true, persistence)
    expect(persistence.map.get(GLOBAL_VIEW_PREFERENCE_KEY)).toBe('on')
    expect(await loadGlobalViewEnabled(persistence)).toBe(true)
    await saveGlobalViewEnabled(false, persistence)
    expect(await loadGlobalViewEnabled(persistence)).toBe(false)
  })
})

describe('GridThumbLoader', () => {
  test('materializes a URL per frame and dedupes in-flight reads', async () => {
    const objectUrls = countingUrls()
    let reads = 0
    const loader = new GridThumbLoader({
      objectUrls,
      read: async () => {
        reads++
        return new Uint8Array([1, 2, 3])
      },
    })
    const f = frame('entry-a')
    const [a, b] = await Promise.all([
      loader.urlFor('gallery', f),
      loader.urlFor('gallery', f),
    ])
    expect(a).toBe('blob:mock-0')
    expect(b).toBe('blob:mock-0')
    expect(reads).toBe(1)
    expect(loader.peek('gallery', f)).toBe('blob:mock-0')
  })

  test('evicts the least recently materialized URL past the cap', async () => {
    const objectUrls = countingUrls()
    const loader = new GridThumbLoader({
      objectUrls,
      maxLiveUrls: 2,
      read: async () => new Uint8Array([1]),
    })
    const first = frame('entry-1')
    const second = frame('entry-2')
    const third = frame('entry-3')
    await loader.urlFor('gallery', first)
    await loader.urlFor('gallery', second)
    // A hit on the oldest entry refreshes it so the middle one evicts instead.
    await loader.urlFor('gallery', first)
    await loader.urlFor('gallery', third)
    expect(objectUrls.revoked).toEqual(['blob:mock-1'])
    expect(loader.peek('gallery', first)).toBe('blob:mock-0')
    expect(loader.peek('gallery', second)).toBeUndefined()
    expect(loader.peek('gallery', third)).toBe('blob:mock-2')
  })

  test('bounds concurrent decrypts and drains the queue', async () => {
    const objectUrls = countingUrls()
    let inFlight = 0
    let peak = 0
    const loader = new GridThumbLoader({
      objectUrls,
      maxConcurrent: 2,
      read: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight--
        return new Uint8Array([1])
      },
    })
    const frames = Array.from({ length: 8 }, (_, index) => frame(`entry-${index}`))
    const urls = await Promise.all(frames.map((f) => loader.urlFor('gallery', f)))
    expect(peak).toBe(2)
    expect(urls.every((url) => url?.startsWith('blob:mock-'))).toBe(true)
    expect(objectUrls.created.length).toBe(8)
  })

  test('release revokes live URLs and URLs that land afterwards', async () => {
    const objectUrls = countingUrls()
    let resolveRead!: (bytes: Uint8Array) => void
    const readGate = new Promise<Uint8Array>((resolve) => { resolveRead = resolve })
    const loader = new GridThumbLoader({
      objectUrls,
      read: () => readGate,
    })
    const pending = loader.urlFor('gallery', frame('entry-late'))
    loader.release()
    resolveRead(new Uint8Array([1]))
    await pending
    // The URL arrived after release: created, then immediately revoked.
    expect(objectUrls.created).toEqual(['blob:mock-0'])
    expect(objectUrls.revoked).toEqual(['blob:mock-0'])
  })

  test('returns undefined when the vault holds no bytes', async () => {
    const objectUrls = countingUrls()
    const loader = new GridThumbLoader({ objectUrls, read: async () => undefined })
    expect(await loader.urlFor('gallery', frame('entry-x'))).toBeUndefined()
    expect(objectUrls.created).toEqual([])
  })
})
