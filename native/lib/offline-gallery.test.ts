import { describe, expect, test } from 'bun:test'
import type { GalleryImage, GalleryManifest, VideoItem } from '../../app/lib/imagesource'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import { NativeGalleryHttpError, type NativeGalleryResponse } from './api'
import {
  EncryptedOfflineGalleryStore,
  OfflineGalleryUnavailableError,
  __private__,
  offlineGalleryId,
  offlineSourceFor,
  openGalleryNetworkFirst,
  type OfflineGalleryStore,
  type OfflineObjectUrlProvider,
} from './offline-gallery'
import { thumbnailEntryId } from './thumbs'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'
import { EncryptedVault, VAULT_INDEX_PATH, webCryptoProvider } from './vault'

class MemoryStorage implements VaultStorageProvider {
  readonly files = new Map<string, Uint8Array>()
  async read(path: string) { return this.files.get(path)?.slice() ?? null }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes.slice()) }
  async remove(path: string) { this.files.delete(path) }
  async list(root: string) {
    return [...this.files.entries()]
      .filter(([path]) => path === root || path.startsWith(`${root}/`))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }))
  }
  async move(from: string, to: string) {
    const bytes = this.files.get(from)
    if (!bytes) throw new Error(`Missing temporary file: ${from}`)
    this.files.set(to, bytes)
    this.files.delete(from)
  }
}

class MemoryKeys implements VaultKeyProvider {
  readonly values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
}

class FakeObjectUrls implements OfflineObjectUrlProvider {
  readonly created: { url: string; bytes: Uint8Array; mimeType: string }[] = []
  readonly revoked: string[] = []
  readonly inputs: Uint8Array[] = []
  create(bytes: Uint8Array, mimeType: string) {
    this.inputs.push(bytes)
    const url = `blob:offline-${this.created.length + 1}`
    this.created.push({ url, bytes: bytes.slice(), mimeType })
    return url
  }
  revoke(url: string) { this.revoked.push(url) }
}

const selection = { owner: 'photographer', slug: 'quiet-light' }
const firstBytes = new TextEncoder().encode('provider bytes one')
const secondBytes = new TextEncoder().encode('provider bytes two')

const image = (input: Partial<GalleryImage> & Pick<GalleryImage, 'id' | 'filename' | 'src'>): GalleryImage => ({
  ...input,
  width: input.width ?? 2400,
  height: input.height ?? 1600,
  alt: input.alt ?? `${input.id} alt`,
  c2pa: input.c2pa ?? false,
  placeholder: input.placeholder ?? `data:image/svg+xml,${input.id}`,
})

const manifest: GalleryManifest = {
  slug: selection.slug,
  title: 'Quiet light',
  caption: 'A cached gallery',
  date: '2026-09-24',
  images: [
    image({
      id: 'stable-one',
      ref: 'provider-stable-one',
      filename: 'one.jpg',
      src: 'https://provider.test/original-one.jpg',
      caption: 'First caption',
      c2pa: true,
      exif: { camera: 'Camera A', lens: 'Lens A' },
      variants: [
        { width: 1024, src: 'https://provider.test/one-1024.jpg', format: 'jpeg' },
        { width: 320, src: 'https://provider.test/one-320.jpg', format: 'jpeg' },
      ],
    }),
    image({
      id: 'stable-two',
      ref: 'provider-stable-two',
      filename: 'two.png',
      src: 'https://provider.test/original-two.png',
      exif: { dateOriginal: '2026-09-23' },
    }),
  ],
}

const gallery: NativeGalleryResponse = {
  manifest,
  settings: {
    ...defaultGallerySettings(manifest),
    curtainKicker: 'From the vault',
    curtainPrompt: 'Enter quietly',
    defaultMode: 'single',
    defaultShowCaptions: true,
    imageCaptions: { 'stable-one': 'Owner caption', 'stable-two': '' },
  },
}

const makeHarness = (responses = new Map<string, { bytes: Uint8Array; type: string }>([
  ['https://provider.test/one-320.jpg', { bytes: firstBytes, type: 'image/jpeg' }],
  ['https://provider.test/original-two.png', { bytes: secondBytes, type: 'image/png' }],
])) => {
  const storage = new MemoryStorage()
  const keys = new MemoryKeys()
  const vault = new EncryptedVault({
    storage,
    keys,
    crypto: {
      ...webCryptoProvider,
      randomBytes(length) { return new Uint8Array(length).fill(7) },
    },
  })
  const urls = new FakeObjectUrls()
  const requested: string[] = []
  const store = new EncryptedOfflineGalleryStore({
    vault,
    objectUrls: urls,
    fetchImage: async (url) => {
      requested.push(url)
      const response = responses.get(url)
      if (!response) return new Response('missing', { status: 404 })
      return new Response(response.bytes.slice(), { headers: { 'content-type': response.type } })
    },
  })
  return { storage, keys, vault, urls, requested, store }
}

const storageContains = (storage: MemoryStorage, needle: Uint8Array): boolean =>
  [...storage.files.values()].some((haystack) => {
    if (needle.length > haystack.length) return false
    for (let start = 0; start <= haystack.length - needle.length; start += 1) {
      if (needle.every((byte, offset) => haystack[start + offset] === byte)) return true
    }
    return false
  })

describe('EncryptedOfflineGalleryStore', () => {
  test('round-trips metadata and settings only through encrypted vault entries', async () => {
    const { store } = makeHarness()
    await store.cache(selection, gallery)

    const opened = await store.open(selection)
    expect(opened?.settings).toEqual(gallery.settings)
    expect(opened?.manifest).toEqual({
      ...gallery.manifest,
      images: gallery.manifest.images.map((item, index) => ({
        ...item,
        src: `blob:offline-${index + 1}`,
        variants: item.variants?.map((variant) => ({ ...variant, src: `blob:offline-${index + 1}` })),
      })),
    })
  })

  test('chooses the smallest existing provider variant and falls back byte-for-byte to the original', async () => {
    expect(offlineSourceFor(manifest.images[0] as GalleryImage)).toEqual({
      src: 'https://provider.test/one-320.jpg',
      format: 'jpeg',
    })
    expect(offlineSourceFor(manifest.images[1] as GalleryImage)).toEqual({
      src: 'https://provider.test/original-two.png',
    })

    const { store, requested } = makeHarness()
    await store.cache(selection, gallery)
    expect(requested).toEqual([
      'https://provider.test/one-320.jpg',
      'https://provider.test/original-two.png',
    ])
  })

  test('stores provider pixels encrypted and uses one stable image-ID entry per still', async () => {
    const { store, vault, storage } = makeHarness()
    await store.cache(selection, gallery)

    const galleryId = await offlineGalleryId(selection)
    expect(await vault.read(galleryId, thumbnailEntryId('stable-one'))).toEqual(firstBytes)
    expect(await vault.read(galleryId, thumbnailEntryId('stable-two'))).toEqual(secondBytes)
    expect(storage.files.has(VAULT_INDEX_PATH)).toBe(true)
    expect(storageContains(storage, firstBytes)).toBe(false)
    expect(storageContains(storage, secondBytes)).toBe(false)
    expect(storageContains(storage, new TextEncoder().encode(JSON.stringify(gallery.manifest)))).toBe(false)
    const index = JSON.parse(new TextDecoder().decode((await storage.read(VAULT_INDEX_PATH))!)) as { entries: Record<string, unknown> }
    expect(Object.keys(index.entries).sort()).toEqual([
      `${galleryId}\u0000${__private__.METADATA_ENTRY_ID}`,
      `${galleryId}\u0000${thumbnailEntryId('stable-one')}`,
      `${galleryId}\u0000${thumbnailEntryId('stable-two')}`,
    ].sort())
  })

  test('detects complete caches and refuses a missing image entry', async () => {
    const { store, vault } = makeHarness()
    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
    await store.cache(selection, gallery)
    expect(await store.inspect(selection)).toEqual({ status: 'complete', images: 2 })

    await vault.remove(await offlineGalleryId(selection), thumbnailEntryId('stable-two'))
    expect(await store.inspect(selection)).toEqual({ status: 'incomplete', images: 0 })
    expect(await store.open(selection)).toBeUndefined()
  })

  test('invalidates every encrypted entry for a gallery', async () => {
    const { store, vault } = makeHarness()
    const galleryId = await offlineGalleryId(selection)
    await store.cache(selection, gallery)

    await store.invalidate(selection)

    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
    expect(await vault.read(galleryId, __private__.METADATA_ENTRY_ID)).toBeUndefined()
    expect(await vault.read(galleryId, thumbnailEntryId('stable-one'))).toBeUndefined()
    expect(await vault.read(galleryId, thumbnailEntryId('stable-two'))).toBeUndefined()
  })

  test('reconstructs stills with short-lived URLs while retaining all manifest fields', async () => {
    const { store, urls } = makeHarness()
    await store.cache(selection, gallery)
    const opened = await store.open(selection)
    expect(opened?.source).toBe('offline')
    expect(opened?.manifest.slug).toBe(selection.slug)
    expect(opened?.manifest.images[0]).toMatchObject({
      id: 'stable-one',
      ref: 'provider-stable-one',
      filename: 'one.jpg',
      src: 'blob:offline-1',
      width: 2400,
      height: 1600,
      alt: 'stable-one alt',
      caption: 'First caption',
      exif: { camera: 'Camera A', lens: 'Lens A' },
      c2pa: true,
      placeholder: 'data:image/svg+xml,stable-one',
      variants: [
        { width: 1024, src: 'blob:offline-1', format: 'jpeg' },
        { width: 320, src: 'blob:offline-1', format: 'jpeg' },
      ],
    })
    expect(urls.created.map((entry) => entry.mimeType)).toEqual(['image/jpeg', 'image/png'])
    expect(urls.created.map((entry) => entry.bytes)).toEqual([firstBytes, secondBytes])
  })

  test('recovers from corrupt metadata without claiming offline success', async () => {
    const { store, vault } = makeHarness()
    const galleryId = await offlineGalleryId(selection)
    await vault.write(galleryId, __private__.METADATA_ENTRY_ID, new TextEncoder().encode('{bad json'))

    expect(await store.inspect(selection)).toEqual({ status: 'corrupt', images: 0 })
    expect(await store.open(selection)).toBeUndefined()
    expect(await vault.read(galleryId, __private__.METADATA_ENTRY_ID)).toBeUndefined()
  })

  test('revokes partial and live URLs and wipes every decrypted buffer', async () => {
    const { store, vault, urls } = makeHarness()
    await store.cache(selection, gallery)
    await vault.remove(await offlineGalleryId(selection), thumbnailEntryId('stable-two'))

    expect(await store.open(selection)).toBeUndefined()
    expect(urls.revoked).toEqual(['blob:offline-1'])
    expect(urls.inputs.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)

    const complete = makeHarness()
    await complete.store.cache(selection, gallery)
    const opened = await complete.store.open(selection)
    opened?.dispose()
    opened?.dispose()
    expect(complete.urls.revoked).toEqual(['blob:offline-1', 'blob:offline-2'])
    expect(complete.urls.inputs.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  test('skips mixed/video galleries rather than caching a poster as the wrong media type', async () => {
    const video: VideoItem = {
      type: 'video',
      id: 'video-one',
      filename: 'video.mp4',
      src: 'https://provider.test/video.mp4',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      poster: { src: 'https://provider.test/poster.jpg', width: 640, height: 360 },
      alt: 'A video',
      c2pa: false,
      placeholder: 'data:image/svg+xml,video',
      variants: [{ width: 640, src: 'https://provider.test/poster.jpg', format: 'jpeg' }],
    }
    const mixed: NativeGalleryResponse = {
      manifest: { ...manifest, images: [...manifest.images, video] },
      settings: defaultGallerySettings({ ...manifest, images: [...manifest.images, video] }),
    }
    const { store, requested } = makeHarness()

    expect(await store.cache(selection, mixed)).toEqual({ status: 'skipped-video', images: 0 })
    expect(requested).toEqual([])
    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
  })
})

describe('openGalleryNetworkFirst', () => {
  test('falls back to a complete encrypted cache on network failure', async () => {
    const { store } = makeHarness()
    await store.cache(selection, gallery)

    const opened = await openGalleryNetworkFirst({
      selection,
      store,
      fetchOnline: async () => { throw new TypeError('offline') },
    })
    expect(opened.source).toBe('offline')
    expect(opened.manifest.images[0]?.src).toBe('blob:offline-1')
  })

  test('rethrows HTTP errors and invalidates a cache for deleted galleries', async () => {
    const { store } = makeHarness()
    await store.cache(selection, gallery)
    const error = new NativeGalleryHttpError(404, 'Gallery not found')

    await expect(openGalleryNetworkFirst({
      selection,
      store,
      fetchOnline: async () => { throw error },
    })).rejects.toBe(error)
    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
  })

  test('rethrows other HTTP errors without using a stale cache', async () => {
    const { store } = makeHarness()
    await store.cache(selection, gallery)
    const error = new NativeGalleryHttpError(500, 'Server error')

    await expect(openGalleryNetworkFirst({
      selection,
      store,
      fetchOnline: async () => { throw error },
    })).rejects.toBe(error)
    expect(await store.inspect(selection)).toEqual({ status: 'complete', images: 2 })
  })

  test('preserves a calm network error when no complete cache exists', async () => {
    const { store } = makeHarness()
    const opening = openGalleryNetworkFirst({
      selection,
      store,
      fetchOnline: async () => { throw new TypeError('offline') },
    })
    await expect(opening).rejects.toBeInstanceOf(OfflineGalleryUnavailableError)
    await expect(opening).rejects.toThrow('not available offline yet')
  })

  test('returns online first paint before a non-blocking cache fill settles', async () => {
    let releaseCache!: () => void
    const cacheGate = new Promise<void>((resolve) => { releaseCache = resolve })
    let cacheStarted = false
    let cacheFinished = false
    const store: OfflineGalleryStore = {
      async cache() {
        cacheStarted = true
        await cacheGate
        cacheFinished = true
        return { status: 'complete', images: 2 }
      },
      async inspect() { return { status: 'missing', images: 0 } },
      async open() { return undefined },
      async invalidate() {},
      async listGalleries() { return [] },
      async gridGallery() { return undefined },
      async listGridGalleries() { return [] },
      async readThumbnail() { return undefined },
      async purgeGallery() {},
      async purgeAll() {},
    }

    const opened = await openGalleryNetworkFirst({
      selection,
      store,
      fetchOnline: async () => gallery,
    })
    expect(opened.source).toBe('online')
    expect(opened.manifest).toBe(gallery.manifest)
    expect(cacheStarted).toBe(true)
    expect(cacheFinished).toBe(false)
    expect(opened.cacheFill).toBeDefined()
    releaseCache()
    await opened.cacheFill
    expect(cacheFinished).toBe(true)
  })
})

describe('EncryptedOfflineGalleryStore catalog and purge', () => {
  test('lists cached galleries with decrypted identity and count', async () => {
    const { store } = makeHarness()
    await store.cache(selection, gallery)
    const other = { owner: 'photographer', slug: 'second-album' }
    await store.cache(other, {
      ...gallery,
      manifest: { ...manifest, slug: other.slug, title: 'Second album' },
      settings: { ...gallery.settings, title: 'Second album' },
    })

    const summaries = await store.listGalleries()
    expect(summaries).toHaveLength(2)
    const quiet = summaries.find((entry) => entry.status === 'cached' && entry.slug === 'quiet-light')
    expect(quiet).toMatchObject({ status: 'cached', owner: 'photographer', title: 'Quiet light', images: 2 })
    const second = summaries.find((entry) => entry.status === 'cached' && entry.slug === 'second-album')
    expect(second).toMatchObject({ status: 'cached', title: 'Second album', images: 2 })
  })

  test('lists a gallery with missing or unreadable metadata as corrupt', async () => {
    const { store, vault } = makeHarness()
    await store.cache(selection, gallery)
    const galleryId = await offlineGalleryId(selection)
    await vault.write(galleryId, __private__.METADATA_ENTRY_ID, new TextEncoder().encode('{bad json'))

    const summaries = await store.listGalleries()
    expect(summaries).toEqual([{ status: 'corrupt', galleryId }])
    // Listing is a display path: the corrupt record is reported, not deleted.
    expect(await vault.read(galleryId, __private__.METADATA_ENTRY_ID, { touch: false })).toBeDefined()
  })

  test('purgeGallery removes the vault entries and releases live object URLs', async () => {
    const { store, vault, urls } = makeHarness()
    await store.cache(selection, gallery)
    const opened = await store.open(selection)
    expect(opened).toBeDefined()
    const galleryId = await offlineGalleryId(selection)

    await store.purgeGallery(galleryId)

    expect(urls.revoked.sort()).toEqual(['blob:offline-1', 'blob:offline-2'])
    expect(await vault.listGalleryIds()).toEqual([])
    expect(await store.listGalleries()).toEqual([])
    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
  })

  test('purgeAll removes every gallery and every live object URL', async () => {
    const { store, vault, urls } = makeHarness()
    await store.cache(selection, gallery)
    const other = { owner: 'photographer', slug: 'second-album' }
    await store.cache(other, {
      ...gallery,
      manifest: { ...manifest, slug: other.slug },
      settings: { ...gallery.settings },
    })
    await store.open(selection)
    await store.open(other)

    await store.purgeAll()

    expect(urls.revoked).toHaveLength(4)
    expect(await vault.listGalleryIds()).toEqual([])
  })

  test('a purge during a cache fill stops the fill from repopulating the vault', async () => {
    const { store, vault } = makeHarness()
    let releaseFetch!: () => void
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve })
    let calls = 0
    const gated = new EncryptedOfflineGalleryStore({
      vault,
      fetchImage: async () => {
        calls += 1
        if (calls === 1) await gate
        return new Response(firstBytes.slice(), { headers: { 'content-type': 'image/jpeg' } })
      },
    })
    const galleryId = await offlineGalleryId(selection)

    const fill = gated.cache(selection, gallery)
    await Promise.resolve()
    await gated.purgeGallery(galleryId)
    releaseFetch()

    await expect(fill).rejects.toThrow('cleared while this write was in flight')
    expect(await vault.listGalleryIds()).toEqual([])
    expect(await gated.inspect(selection)).toEqual({ status: 'missing', images: 0 })
  })
})

describe('EncryptedOfflineGalleryStore grid catalog', () => {
  test('gridGallery returns manifest-aligned frames without minting URLs', async () => {
    const { store, urls } = makeHarness()
    await store.cache(selection, gallery)
    const galleryId = await offlineGalleryId(selection)

    const grid = await store.gridGallery(galleryId)
    expect(grid).toBeDefined()
    expect(grid).toMatchObject({ owner: 'photographer', slug: 'quiet-light', title: 'Quiet light' })
    expect(grid!.frames).toHaveLength(2)
    expect(grid!.frames[0]).toMatchObject({
      id: 'stable-one',
      entryId: thumbnailEntryId('stable-one'),
      mimeType: 'image/jpeg',
      width: 2400,
      height: 1600,
      index: 0,
    })
    expect(grid!.frames[1]).toMatchObject({ id: 'stable-two', index: 1 })
    // The catalog is metadata-only: no thumbnail URLs are created up front.
    expect(urls.created).toEqual([])
  })

  test('gridGallery is undefined for missing or corrupt metadata', async () => {
    const { store, vault } = makeHarness()
    await store.cache(selection, gallery)
    const galleryId = await offlineGalleryId(selection)

    expect(await store.gridGallery('offline-gallery:v1:unknown')).toBeUndefined()
    await vault.write(galleryId, __private__.METADATA_ENTRY_ID, new TextEncoder().encode('{bad json'))
    expect(await store.gridGallery(galleryId)).toBeUndefined()
  })

  test('listGridGalleries spans cached galleries and skips corrupt ones', async () => {
    const { store, vault } = makeHarness()
    await store.cache(selection, gallery)
    const other = { owner: 'photographer', slug: 'second-album' }
    await store.cache(other, {
      ...gallery,
      manifest: { ...manifest, slug: other.slug, title: 'Second album' },
      settings: { ...gallery.settings },
    })
    const otherId = await offlineGalleryId(other)
    await vault.write(otherId, __private__.METADATA_ENTRY_ID, new TextEncoder().encode('{bad json'))

    const grids = await store.listGridGalleries()
    expect(grids).toHaveLength(1)
    expect(grids[0].slug).toBe('quiet-light')
  })

  test('readThumbnail returns decrypted bytes without touching the LRU', async () => {
    const { store, vault } = makeHarness()
    await store.cache(selection, gallery)
    const galleryId = await offlineGalleryId(selection)
    const entryId = thumbnailEntryId('stable-two')

    const reads: { touch?: boolean }[] = []
    const originalRead = vault.read.bind(vault)
    vault.read = ((g: string, e: string, opts?: { touch?: boolean }) => {
      reads.push(opts ?? {})
      return originalRead(g, e, opts)
    }) as typeof vault.read

    const bytes = await store.readThumbnail(galleryId, entryId)
    expect(bytes).toEqual(secondBytes)
    // Grid reads carry touch:false — scanning every gallery must not shuffle
    // the eviction order a cap decision relies on.
    expect(reads).toEqual([{ touch: false }])
    expect(await store.readThumbnail(galleryId, 'no-such-entry')).toBeUndefined()
  })
})
