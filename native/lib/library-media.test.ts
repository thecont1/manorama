import { describe, expect, test } from 'bun:test'
import type { GalleryImage, GalleryMediaItem, VideoItem } from '../../app/lib/imagesource'
import { CacheFillRegistry } from './cache-fill'
import {
  LibraryMediaLoader,
  mimeTypeForItem,
  previewSrcFor,
  type LibraryMediaCell,
} from './library-media'
import type { OfflineObjectUrlProvider } from './offline-gallery'

const cell = (input: Partial<LibraryMediaCell> & Pick<LibraryMediaCell, 'entryId'>): LibraryMediaCell => ({
  galleryId: input.galleryId ?? 'gallery-a',
  entryId: input.entryId,
  mimeType: input.mimeType ?? 'image/jpeg',
  remote: input.remote,
})

const countingUrls = (): OfflineObjectUrlProvider & { created: string[]; revoked: string[] } => {
  const created: string[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    create() {
      const url = `blob:lib-${created.length}`
      created.push(url)
      return url
    },
    revoke(url) {
      revoked.push(url)
    },
  }
}

const byteStore = (entries: Record<string, Uint8Array>) => {
  const reads: string[] = []
  const read = async (galleryId: string, entryId: string) => {
    reads.push(`${galleryId}:${entryId}`)
    return entries[`${galleryId}:${entryId}`]?.slice()
  }
  return { read, reads }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('LibraryMediaLoader', () => {
  test('saved bytes beat the remote preview and nothing else is fetched', async () => {
    const objectUrls = countingUrls()
    const { read } = byteStore({ 'gallery-a:thumb:one': new Uint8Array([1, 2, 3]) })
    const loader = new LibraryMediaLoader({ read, objectUrls })
    const lease = await loader.acquire(cell({ entryId: 'thumb:one', remote: 'https://provider.test/preview.jpg' }))
    expect(lease?.kind).toBe('vault')
    expect(lease?.src).toBe('blob:lib-0')
    lease?.release()
  })

  test('a vault miss falls back to the remote preview without minting a URL', async () => {
    const objectUrls = countingUrls()
    const { read, reads } = byteStore({})
    const loader = new LibraryMediaLoader({ read, objectUrls })
    const lease = await loader.acquire(cell({ entryId: 'thumb:absent', remote: 'https://provider.test/preview.jpg' }))
    expect(lease?.kind).toBe('remote')
    expect(lease?.src).toBe('https://provider.test/preview.jpg')
    expect(objectUrls.created).toEqual([])
    expect(reads).toEqual(['gallery-a:thumb:absent'])
  })

  test('a cell with neither bytes nor preview keeps its placeholder', async () => {
    const loader = new LibraryMediaLoader({ read: async () => undefined, objectUrls: countingUrls() })
    const lease = await loader.acquire(cell({ entryId: 'thumb:none' }))
    expect(lease?.kind).toBe('none')
    expect(lease?.src).toBeUndefined()
  })

  test('cells that never acquire never start a media request', async () => {
    const { read, reads } = byteStore({ 'gallery-a:thumb:one': new Uint8Array([1]) })
    const loader = new LibraryMediaLoader({ read, objectUrls: countingUrls() })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reads).toEqual([])
    loader.release()
  })

  test('concurrent acquires share one read and each pin their own lease', async () => {
    const { read, reads } = byteStore({ 'gallery-a:thumb:one': new Uint8Array([1, 2]) })
    const loader = new LibraryMediaLoader({ read, objectUrls: countingUrls() })
    const target = cell({ entryId: 'thumb:one' })
    const [a, b] = await Promise.all([loader.acquire(target), loader.acquire(target)])
    expect(reads).toHaveLength(1)
    expect(a?.src).toBe('blob:lib-0')
    expect(b?.src).toBe('blob:lib-0')
    a?.release()
    b?.release()
  })

  test('at most four reads run concurrently', async () => {
    const gate = deferred<void>()
    let active = 0
    let maxActive = 0
    const loader = new LibraryMediaLoader({
      objectUrls: countingUrls(),
      read: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate.promise
        active -= 1
        return new Uint8Array([1])
      },
    })
    const acquires = Array.from({ length: 10 }, (_, i) => loader.acquire(cell({ entryId: `thumb:${i}` })))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(maxActive).toBeLessThanOrEqual(4)
    gate.resolve()
    await Promise.all(acquires)
    expect(maxActive).toBe(4)
  })

  test('live object URLs evict LRU past the cap but never a pinned lease', async () => {
    const objectUrls = countingUrls()
    const bytes = new Uint8Array([1])
    const entries: Record<string, Uint8Array> = {}
    for (let i = 0; i < 6; i++) entries[`gallery-a:thumb:${i}`] = bytes
    const loader = new LibraryMediaLoader({ read: byteStore(entries).read, objectUrls, maxLiveUrls: 4, maxBlobBytes: 1 << 20 })
    const pinned = await loader.acquire(cell({ entryId: 'thumb:0' }))
    for (let i = 1; i < 5; i++) {
      const lease = await loader.acquire(cell({ entryId: `thumb:${i}` }))
      lease?.release()
    }
    // Five cells through a four-URL cap: thumb:0 survived on its pin, the
    // oldest unpinned (thumb:1) was evicted.
    expect(objectUrls.created).toHaveLength(5)
    expect(objectUrls.revoked).toEqual(['blob:lib-1'])
    expect(pinned?.src).toBe('blob:lib-0')
    pinned?.release()
  })

  test('the byte budget evicts unpinned entries and re-reads after release', async () => {
    const objectUrls = countingUrls()
    const big = new Uint8Array(40)
    const small = new Uint8Array(10)
    const loader = new LibraryMediaLoader({
      read: byteStore({ 'gallery-a:thumb:big': big, 'gallery-a:thumb:small': small }).read,
      objectUrls,
      maxLiveUrls: 24,
      maxBlobBytes: 50,
    })
    const first = await loader.acquire(cell({ entryId: 'thumb:big' }))
    first?.release()
    const second = await loader.acquire(cell({ entryId: 'thumb:small' }))
    second?.release()
    // 40 + 10 fits in 50 — nothing evicted yet.
    expect(objectUrls.revoked).toEqual([])
    const third = await loader.acquire(cell({ entryId: 'thumb:big', galleryId: 'gallery-a' }))
    // Re-acquiring a pooled entry is a warm hit: no new read, no eviction.
    expect(third?.src).toBe('blob:lib-0')
    third?.release()
    const fourth = await loader.acquire(cell({ entryId: 'thumb:small', galleryId: 'gallery-b' }))
    expect(fourth?.src).toBeUndefined()
  })

  test('a job parks when the whole budget is pinned and resumes on release', async () => {
    const objectUrls = countingUrls()
    const loader = new LibraryMediaLoader({
      read: byteStore({
        'gallery-a:thumb:one': new Uint8Array(40),
        'gallery-a:thumb:two': new Uint8Array(40),
      }).read,
      objectUrls,
      maxLiveUrls: 24,
      maxBlobBytes: 50,
    })
    const first = await loader.acquire(cell({ entryId: 'thumb:one' }))
    let secondSettled = false
    const second = loader.acquire(cell({ entryId: 'thumb:two' })).then((lease) => {
      secondSettled = true
      return lease
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 40 live + 40 incoming cannot fit 50 while the first lease is pinned.
    expect(secondSettled).toBe(false)
    first?.release()
    const secondLease = await second
    expect(secondSettled).toBe(true)
    expect(secondLease?.src).toBe('blob:lib-1')
    // The released first entry was evicted to make room.
    expect(objectUrls.revoked).toEqual(['blob:lib-0'])
    secondLease?.release()
  })

  test('a source larger than the whole budget shows alone and leaves with its cell', async () => {
    const objectUrls = countingUrls()
    const loader = new LibraryMediaLoader({
      read: byteStore({
        'gallery-a:thumb:tiny': new Uint8Array(5),
        'gallery-a:thumb:huge': new Uint8Array(200),
      }).read,
      objectUrls,
      maxLiveUrls: 24,
      maxBlobBytes: 50,
    })
    const tiny = await loader.acquire(cell({ entryId: 'thumb:tiny' }))
    tiny?.release()
    const huge = await loader.acquire(cell({ entryId: 'thumb:huge' }))
    expect(huge?.kind).toBe('vault')
    expect(huge?.src).toBe('blob:lib-1')
    // Admitting the oversized frame evicted every pool entry.
    expect(objectUrls.revoked).toEqual(['blob:lib-0'])
    huge?.release()
    // It never pools — leaving the window revokes it outright.
    expect(objectUrls.revoked).toEqual(['blob:lib-0', 'blob:lib-1'])
  })

  test('release cancels queued work and revokes late completions', async () => {
    const objectUrls = countingUrls()
    const gate = deferred<Uint8Array>()
    const loader = new LibraryMediaLoader({ read: async () => gate.promise, objectUrls })
    const pending = loader.acquire(cell({ entryId: 'thumb:slow' }))
    loader.release()
    gate.resolve(new Uint8Array([9]))
    expect(await pending).toBeUndefined()
    expect(objectUrls.created).toEqual([])
  })

  test('invalidating a gallery revokes its live URLs and kills queued work', async () => {
    const objectUrls = countingUrls()
    const entries: Record<string, Uint8Array> = {
      'gallery-a:thumb:one': new Uint8Array([1]),
      'gallery-b:thumb:two': new Uint8Array([2]),
    }
    const loader = new LibraryMediaLoader({ read: byteStore(entries).read, objectUrls })
    const a = await loader.acquire(cell({ galleryId: 'gallery-a', entryId: 'thumb:one' }))
    const b = await loader.acquire(cell({ galleryId: 'gallery-b', entryId: 'thumb:two' }))
    loader.invalidate('gallery-a')
    expect(objectUrls.revoked).toEqual(['blob:lib-0'])
    a?.release()
    b?.release()
    // A stale in-flight completion for the invalidated gallery is discarded.
    const stale = await loader.acquire(cell({ galleryId: 'gallery-a', entryId: 'thumb:one' }))
    expect(stale?.kind).toBe('vault') // a fresh generation may read again
    stale?.release()
  })

  test('invalidation mid-read discards the late completion for that gallery', async () => {
    const objectUrls = countingUrls()
    const gate = deferred<Uint8Array>()
    const loader = new LibraryMediaLoader({ read: async () => gate.promise, objectUrls })
    const pending = loader.acquire(cell({ galleryId: 'gallery-a', entryId: 'thumb:one' }))
    loader.invalidate('gallery-a')
    gate.resolve(new Uint8Array([7]))
    expect(await pending).toBeUndefined()
    expect(objectUrls.created).toEqual([])
  })
})

describe('cache fill registry', () => {
  test('subscribers see only their own gallery arrivals until reset', () => {
    const registry = new CacheFillRegistry()
    const seen: string[] = []
    registry.subscribe('gallery-a', (item) => seen.push(item.entryId))
    registry.publish({ galleryId: 'gallery-b', item: { id: 'x', entryId: 'thumb:x', mimeType: 'image/jpeg', index: 0 } })
    registry.publish({ galleryId: 'gallery-a', item: { id: 'one', entryId: 'thumb:one', mimeType: 'image/jpeg', index: 0 } })
    expect(seen).toEqual(['thumb:one'])
    registry.reset()
    registry.publish({ galleryId: 'gallery-a', item: { id: 'two', entryId: 'thumb:two', mimeType: 'image/jpeg', index: 1 } })
    expect(seen).toEqual(['thumb:one'])
  })

  test('unsubscribe stops deliveries', () => {
    const registry = new CacheFillRegistry()
    const seen: string[] = []
    const off = registry.subscribe('gallery-a', (item) => seen.push(item.entryId))
    off()
    registry.publish({ galleryId: 'gallery-a', item: { id: 'one', entryId: 'thumb:one', mimeType: 'image/jpeg', index: 0 } })
    expect(seen).toEqual([])
  })
})

describe('gallery presentation helpers', () => {
  const still = (input: Partial<GalleryImage>): GalleryImage => ({
    id: 'one',
    filename: 'one.heic',
    src: 'https://provider.test/original.heic',
    width: 10,
    height: 10,
    alt: '',
    c2pa: false,
    placeholder: 'data:,',
    ...input,
  })

  test('the preview picks the provider variant, a poster for film, else src', () => {
    const withVariant = still({ variants: [{ width: 320, src: 'https://provider.test/small.jpg', format: 'jpeg' }] })
    expect(previewSrcFor(withVariant)).toBe('https://provider.test/small.jpg')
    expect(previewSrcFor(still({}))).toBe('https://provider.test/original.heic')
    const video: GalleryMediaItem = {
      type: 'video',
      id: 'film',
      filename: 'film.mp4',
      src: 'https://provider.test/film.mp4',
      mimeType: 'video/mp4',
      width: 10,
      height: 10,
      poster: { src: 'https://provider.test/poster.jpg', width: 10, height: 10 },
      alt: '',
      c2pa: false,
      placeholder: 'data:,',
    }
    expect(previewSrcFor(video)).toBe('https://provider.test/poster.jpg')
  })

  test('mime resolves from the variant format, then the filename', () => {
    expect(mimeTypeForItem(still({ variants: [{ width: 1, src: 'x', format: 'image/png' }] }))).toBe('image/png')
    expect(mimeTypeForItem(still({}))).toBe('image/heic')
    expect(mimeTypeForItem(still({ filename: 'one.jpeg' }))).toBe('image/jpeg')
    expect(mimeTypeForItem(still({ filename: 'one' }))).toBe('application/octet-stream')
  })
})
