/**
 * Adversarial-review probe for PR #264 (iOS Liquid Glass renewal).
 * Scratch file — not part of the shipped suite. Exercises the vault's video
 * entry, the byte-bounded video read, the revalidation predicate, and the
 * local-folder root guard this PR changed.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import type { GalleryManifest, VideoItem } from '../../app/lib/imagesource'
import { EncryptedOfflineGalleryStore, offlineManifestMatches, openGalleryNetworkFirst } from './offline-gallery'
import type { OfflineObjectUrlProvider } from './offline-gallery'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'
import { EncryptedVault, webCryptoProvider } from './vault'
import { scanLocalFolder, serveLocalMedia } from '../../app/lib/local-source'

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
    if (!bytes) throw new Error(`missing temp ${from}`)
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
  create(bytes: Uint8Array, mimeType: string) {
    const url = `blob:probe-${this.created.length + 1}`
    this.created.push({ url, bytes: bytes.slice(), mimeType })
    return url
  }
  revoke() {}
}

const MP4 = new TextEncoder().encode('MP4-PLAINTEXT-MARKER-0123456789')
const POSTER = new TextEncoder().encode('POSTER-PLAINTEXT-MARKER')

const selection = { owner: 'owner', slug: 'mixed' }

const video = (mp4Url: string, posterUrl = 'https://provider.test/poster.jpg'): VideoItem => ({
  type: 'video',
  id: 'video-one',
  filename: 'clip.mp4',
  src: mp4Url,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  poster: { src: posterUrl, width: 640, height: 360 },
  alt: 'clip',
  c2pa: false,
  placeholder: 'data:image/svg+xml,v',
  variants: [{ width: 640, src: posterUrl, format: 'jpeg' }],
})

const harness = (maxBytes?: number) => {
  const storage = new MemoryStorage()
  const vault = new EncryptedVault({
    storage,
    keys: new MemoryKeys(),
    maxBytes,
    crypto: { ...webCryptoProvider, randomBytes: (n: number) => new Uint8Array(n).fill(3) },
  })
  const urls = new FakeObjectUrls()
  const requested: string[] = []
  const responses = new Map<string, Uint8Array>([
    ['https://provider.test/poster.jpg', POSTER],
    ['https://provider.test/clip-a.mp4', MP4],
    ['https://provider.test/clip-b.mp4', new TextEncoder().encode('SECOND-MP4-BYTES')],
    ['https://provider.test/clip-big.mp4', new Uint8Array(2048).fill(77)],
  ])
  const store = new EncryptedOfflineGalleryStore({
    vault,
    objectUrls: urls,
    fetchImage: async (url) => {
      requested.push(url)
      const bytes = responses.get(url)
      if (!bytes) return new Response('missing', { status: 404 })
      const type = url.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg'
      return new Response(bytes.slice(), { headers: { 'content-type': type } })
    },
  })
  return { storage, vault, urls, requested, store }
}

const manifestWith = (item: VideoItem): GalleryManifest => ({
  slug: selection.slug,
  title: 'Mixed',
  caption: '',
  date: '2026-11-20',
  images: [item],
})

const contains = (storage: MemoryStorage, needle: Uint8Array): boolean =>
  [...storage.files.values()].some((haystack) => {
    for (let start = 0; start + needle.length <= haystack.length; start += 1) {
      if (needle.every((byte, offset) => haystack[start + offset] === byte)) return true
    }
    return false
  })

describe('PR #264 probe: vaulted video bytes', () => {
  test('the MP4 and its poster are ciphertext at rest and decrypt on open', async () => {
    const { store, storage, urls } = harness()
    const manifest = manifestWith(video('https://provider.test/clip-a.mp4'))
    expect(await store.cache(selection, { manifest, settings: defaultGallerySettings(manifest) })).toEqual({ status: 'complete', images: 1 })

    expect(contains(storage, MP4)).toBe(false)
    expect(contains(storage, POSTER)).toBe(false)

    const opened = await store.open(selection)
    expect(opened?.manifest.images[0]?.src).toMatch(/^blob:/)
    const videoBlob = urls.created.find((entry) => entry.mimeType === 'video/mp4')
    console.log('[probe] video blob mime/bytes:', videoBlob?.mimeType, videoBlob?.bytes.length)
    expect(videoBlob?.bytes).toEqual(MP4)
    opened?.dispose()
  })

  test('an oversize MP4 fails before it is buffered whole and leaves no commit record', async () => {
    const { store } = harness(1024)
    const manifest = manifestWith(video('https://provider.test/clip-big.mp4'))
    const result = await store.cache(selection, { manifest, settings: defaultGallerySettings(manifest) }).catch((error: Error) => error)
    console.log('[probe] oversize result:', result instanceof Error ? result.message : JSON.stringify(result))
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain('larger than one vault entry')
    expect(await store.inspect(selection)).toEqual({ status: 'missing', images: 0 })
  })

  test('a changed MP4 URL re-downloads; an unchanged one reuses', async () => {
    const { store, requested } = harness()
    const a = manifestWith(video('https://provider.test/clip-a.mp4'))
    await store.cache(selection, { manifest: a, settings: defaultGallerySettings(a) })
    const afterFirst = requested.filter((url) => url.endsWith('.mp4')).length
    await store.cache(selection, { manifest: a, settings: defaultGallerySettings(a) })
    const afterSame = requested.filter((url) => url.endsWith('.mp4')).length
    const b = manifestWith(video('https://provider.test/clip-b.mp4'))
    await store.cache(selection, { manifest: b, settings: defaultGallerySettings(b) })
    const afterChanged = requested.filter((url) => url.endsWith('.mp4')).length
    console.log('[probe] mp4 fetches:', { afterFirst, afterSame, afterChanged })
    expect(afterSame).toBe(afterFirst)
    expect(afterChanged).toBe(afterFirst + 1)
  })

  test('preferVault serves the kept copy without fetching media bytes again', async () => {
    const { store, requested } = harness()
    const manifest = manifestWith(video('https://provider.test/clip-a.mp4'))
    const gallery = { manifest, settings: defaultGallerySettings(manifest) }
    await store.cache(selection, gallery)
    const afterCache = requested.length
    const opened = await openGalleryNetworkFirst({
      selection,
      store,
      cachePolicy: 'vault',
      preferVault: true,
      fetchOnline: async () => gallery,
    })
    const fresh = await opened.revalidate
    console.log('[probe] media fetches during vault-first open + revalidate:', requested.length - afterCache)
    expect(opened.source).toBe('offline')
    expect(requested.length).toBe(afterCache)
    expect(fresh?.source).toBe('online')
    await fresh?.cacheFill
    expect(requested.length).toBe(afterCache)
    opened.dispose?.()
    fresh?.dispose?.()
  })
})

describe('PR #264 probe: local-folder root guard', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )

  test('the filesystem root is refused instead of being scanned as the cwd', async () => {
    const error = await scanLocalFolder('/').catch((reason: Error) => reason)
    console.log('[probe] scanLocalFolder("/") ->', error instanceof Error ? error.message : String(error))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('filesystem root')
  })

  test('media delivery stays confined to a scanned folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr264-album-'))
    const sibling = await mkdtemp(join(tmpdir(), 'pr264-other-'))
    try {
      await writeFile(join(root, 'one.png'), png)
      await writeFile(join(sibling, 'sentinel.png'), png)
      const scanned = await scanLocalFolder(root)
      expect(scanned.images.length).toBe(1)

      const inside = await serveLocalMedia(new URL(`http://x/api/local/file?path=${encodeURIComponent(join(root, 'one.png'))}`), null)
      const outside = await serveLocalMedia(new URL(`http://x/api/local/file?path=${encodeURIComponent(join(sibling, 'sentinel.png'))}`), null)
      console.log('[probe] local media status:', { inside: inside.status, outside: outside.status })
      expect(inside.status).toBe(200)
      expect(outside.status).toBe(404)

      // Cheapest bypasses: a symlink planted inside the root, a dotted path
      // that resolves out, an empty path, and the Range code path.
      await symlink(join(sibling, 'sentinel.png'), join(root, 'link.png'))
      const viaLink = await serveLocalMedia(new URL(`http://x/api/local/file?path=${encodeURIComponent(join(root, 'link.png'))}`), null)
      const traversal = await serveLocalMedia(new URL(`http://x/api/local/file?path=${encodeURIComponent(`${root}/../${sibling.split('/').pop()}/sentinel.png`)}`), null)
      const empty = await serveLocalMedia(new URL('http://x/api/local/file'), null)
      const ranged = await serveLocalMedia(new URL(`http://x/api/local/file?path=${encodeURIComponent(join(root, 'one.png'))}`), 'bytes=0-0')
      console.log('[probe] local media bypasses:', { viaLink: viaLink.status, traversal: traversal.status, empty: empty.status, ranged: ranged.status, contentRange: ranged.headers.get('content-range') })
      expect(viaLink.status).toBe(404)
      expect(traversal.status).toBe(404)
      expect(empty.status).toBe(404)
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-range')).toBe(`bytes 0-0/${png.length}`)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(sibling, { recursive: true, force: true })
    }
  })
})

describe('PR #264 probe: revalidation drift predicate', () => {
  const still = (patch: Record<string, unknown> = {}) => ({
    id: 'one',
    filename: 'one.jpg',
    src: 'https://provider.test/one.jpg',
    width: 2400,
    height: 1600,
    alt: 'one',
    c2pa: false as const,
    placeholder: 'data:image/svg+xml,one',
    caption: 'owner caption',
    exif: { camera: 'Camera A' },
    ...patch,
  })
  const manifest = (image: Record<string, unknown>): GalleryManifest => ({
    slug: 'quiet-light', title: 'Quiet', caption: '', date: '2026-11-20', images: [image as never],
  })

  test('caption/exif edits are drift; settings known to one side only is drift', () => {
    const base = manifest(still())
    expect(offlineManifestMatches(base, manifest(still({ caption: 'edited caption' })))).toBe(false)
    expect(offlineManifestMatches(base, manifest(still({ exif: { camera: 'Camera B' } })))).toBe(false)
    expect(offlineManifestMatches(base, manifest(still({ alt: 'other alt' })))).toBe(false)
    expect(offlineManifestMatches(base, manifest(still()))).toBe(true)
    const settings = defaultGallerySettings(base)
    expect(offlineManifestMatches(base, base, settings, settings)).toBe(true)
    expect(offlineManifestMatches(base, base, settings, undefined)).toBe(false)
    console.log('[probe] caption/exif/settings drift matches the current predicate')
  })
})

describe('PR #264 probe: memory profile of a vault-first open', () => {
  test('opening a kept gallery materialises the whole gallery in memory', async () => {
    const CHUNK = 4 * 1024 * 1024
    const COUNT = 16
    const storage = new MemoryStorage()
    const vault = new EncryptedVault({ storage, keys: new MemoryKeys(), crypto: webCryptoProvider })
    const store = new EncryptedOfflineGalleryStore({
      vault,
      objectUrls: new FakeObjectUrls(),
      fetchImage: async (url) => {
        const index = Number(/(\d+)\.jpg$/.exec(url)?.[1] ?? 0)
        const bytes = new Uint8Array(CHUNK)
        bytes[0] = index
        return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })
      },
    })
    const images = Array.from({ length: COUNT }, (_, index) => ({
      id: `p${index}`,
      filename: `p${index}.jpg`,
      src: `https://provider.test/p${index}.jpg`,
      width: 4000,
      height: 3000,
      alt: '',
      c2pa: false as const,
      placeholder: 'data:image/svg+xml,p',
    }))
    const manifest: GalleryManifest = { slug: 'big', title: 'Big', caption: '', date: '2026-11-20', images }
    await store.cache({ owner: 'owner', slug: 'big' }, { manifest, settings: defaultGallerySettings(manifest) })

    const gc = (globalThis as { Bun?: { gc: (force: boolean) => void } }).Bun?.gc
    gc?.(true)
    const before = process.memoryUsage().heapUsed
    const opened = await store.open({ owner: 'owner', slug: 'big' })
    const peak = process.memoryUsage().heapUsed
    console.log('[probe] open() memory:', {
      galleryMiB: (CHUNK * COUNT) / 1024 / 1024,
      heapDeltaMiB: +((peak - before) / 1024 / 1024).toFixed(1),
      urls: opened?.manifest.images.length,
    })
    expect(opened?.manifest.images.length).toBe(COUNT)
    opened?.dispose()
  })
})
