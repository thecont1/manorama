import { describe, expect, test } from 'bun:test'
import type {
  DecodedThumbnailSource,
  ProviderImage,
  ThumbnailCodecAdapter,
  ThumbnailDerivative,
  ThumbnailVault,
} from './thumbs'
import {
  MAX_THUMBNAIL_CONCURRENCY,
  OnDeviceThumbnailCache,
  UnsafeThumbnailDerivativeError,
  thumbnailSize,
} from './thumbs'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'
import { EncryptedVault, VAULT_INDEX_PATH, webCryptoProvider } from './vault'

class CopyingVault implements ThumbnailVault {
  readonly writes: { galleryId: string; entryId: string; bytes: Uint8Array }[] = []
  fail = false

  async write(galleryId: string, entryId: string, plaintext: Uint8Array) {
    if (this.fail) throw new Error('Injected vault failure')
    this.writes.push({ galleryId, entryId, bytes: plaintext.slice() })
  }
}

class MemoryStorage implements VaultStorageProvider {
  readonly files = new Map<string, Uint8Array>()
  async read(path: string) { return this.files.get(path)?.slice() ?? null }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes.slice()) }
  async remove(path: string) { this.files.delete(path) }
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

type CodecState = {
  width?: number
  height?: number
  metadata?: DecodedThumbnailSource['metadata']
  integrity?: ThumbnailDerivative['integrity']
  active?: { value: number; maximum: number; wait?: () => Promise<void> }
  closed: number
  deriveCalls: number
  derivedBytes: Uint8Array[]
}

const makeCodec = (state: CodecState): ThumbnailCodecAdapter => ({
  async decode({ contentType }) {
    if (state.active) {
      state.active.value += 1
      state.active.maximum = Math.max(state.active.maximum, state.active.value)
      await state.active.wait?.()
    }
    return {
      width: state.width ?? 4000,
      height: state.height ?? 3000,
      mimeType: contentType ?? 'image/jpeg',
      metadata: state.metadata ?? { icc: 'present', c2pa: 'absent' },
      close: () => {
        state.closed += 1
        if (state.active) state.active.value -= 1
      },
    }
  },
  async derive({ width, height }) {
    state.deriveCalls += 1
    const bytes = new Uint8Array([width & 0xff, height & 0xff, 0xa5])
    state.derivedBytes.push(bytes)
    return {
      bytes,
      width,
      height,
      mimeType: 'image/jpeg',
      integrity: state.integrity ?? {
        originalFormat: true,
        icc: 'preserved',
        c2pa: 'not-present',
      },
    }
  },
})

const providerImage = (
  id: string,
  sourceBytes: Uint8Array,
  released: string[],
): ProviderImage => ({
  id,
  contentType: 'image/jpeg',
  async read() {
    return {
      bytes: sourceBytes,
      release: () => { released.push(id) },
    }
  },
})

describe('thumbnailSize', () => {
  test('fits both axes without ever inventing pixels', () => {
    expect(thumbnailSize({ sourceWidth: 4000, sourceHeight: 3000, maxWidth: 1000, maxHeight: 1000 })).toEqual({ width: 1000, height: 750 })
    expect(thumbnailSize({ sourceWidth: 3000, sourceHeight: 4000, maxWidth: 1000, maxHeight: 1000 })).toEqual({ width: 750, height: 1000 })
    expect(thumbnailSize({ sourceWidth: 401, sourceHeight: 301, maxWidth: 200, maxHeight: 200 })).toEqual({ width: 200, height: 150 })
  })

  test('keeps a source short on pixels at its honest original size', () => {
    expect(thumbnailSize({ sourceWidth: 120, sourceHeight: 80, maxWidth: 1024, maxHeight: 1024 })).toEqual({ width: 120, height: 80 })
  })
})

describe('OnDeviceThumbnailCache', () => {
  test('retains undersized provider bytes byte-for-byte and writes them through the vault seam', async () => {
    const sourceBytes = new Uint8Array([0xff, 0xd8, 0x49, 0x43, 0x43, 0x43, 0x32, 0x50, 0x41])
    const original = sourceBytes.slice()
    const released: string[] = []
    const vault = new CopyingVault()
    const state: CodecState = { width: 120, height: 80, closed: 0, deriveCalls: 0, derivedBytes: [] }
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault })

    const stored = await cache.cacheOne('gallery-a', providerImage('small', sourceBytes, released))

    expect(stored).toEqual({
      id: 'small',
      entryId: 'thumb:small',
      width: 120,
      height: 80,
      mimeType: 'image/jpeg',
      byteLength: original.length,
      disposition: 'retained-source',
    })
    expect(vault.writes).toEqual([{ galleryId: 'gallery-a', entryId: 'thumb:small', bytes: original }])
    expect(state.deriveCalls).toBe(0)
    expect(sourceBytes.every((value) => value === 0)).toBe(true)
    expect(state.closed).toBe(1)
    expect(released).toEqual(['small'])
  })

  test('stores a same-format ICC-preserving derivative, then wipes all plaintext buffers', async () => {
    const sourceBytes = new Uint8Array([1, 2, 3, 4, 5])
    const released: string[] = []
    const vault = new CopyingVault()
    const state: CodecState = { closed: 0, deriveCalls: 0, derivedBytes: [] }
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault, maxWidth: 1000, maxHeight: 1000 })

    const stored = await cache.cacheOne('gallery-a', providerImage('large', sourceBytes, released))

    expect(stored.width).toBe(1000)
    expect(stored.height).toBe(750)
    expect(stored.disposition).toBe('derived')
    expect(vault.writes).toEqual([{ galleryId: 'gallery-a', entryId: 'thumb:large', bytes: new Uint8Array([232, 238, 165]) }])
    expect(sourceBytes.every((value) => value === 0)).toBe(true)
    expect(state.derivedBytes[0]!.every((value) => value === 0)).toBe(true)
    expect(state.closed).toBe(1)
    expect(released).toEqual(['large'])
  })

  test('integrates with EncryptedVault without leaving derived plaintext in its storage provider', async () => {
    const released: string[] = []
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
    const state: CodecState = { closed: 0, deriveCalls: 0, derivedBytes: [] }
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault })

    await cache.cacheOne('gallery-a', providerImage('encrypted', new Uint8Array([1, 2, 3]), released))

    const decrypted = await vault.read('gallery-a', 'thumb:encrypted')
    expect(decrypted).toEqual(new Uint8Array([0, 0, 0xa5]))
    expect(storage.files.has(VAULT_INDEX_PATH)).toBe(true)
    expect([...storage.files.values()].some((bytes) => bytes.length === 3 && bytes[2] === 0xa5)).toBe(false)
    expect(keys.values.size).toBe(1)
    expect(released).toEqual(['encrypted'])
  })

  test('fails closed instead of persisting a derivative that drops ICC or valid C2PA', async () => {
    const released: string[] = []
    const vault = new CopyingVault()
    const state: CodecState = {
      metadata: { icc: 'present', c2pa: 'present' },
      integrity: { originalFormat: true, icc: 'discarded', c2pa: 'discarded' },
      closed: 0,
      deriveCalls: 0,
      derivedBytes: [],
    }
    const sourceBytes = new Uint8Array([9, 8, 7])
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault })

    await expect(cache.cacheOne('gallery-a', providerImage('credentialed', sourceBytes, released)))
      .rejects.toBeInstanceOf(UnsafeThumbnailDerivativeError)
    expect(vault.writes).toEqual([])
    expect(sourceBytes.every((value) => value === 0)).toBe(true)
    expect(state.derivedBytes[0]!.every((value) => value === 0)).toBe(true)
    expect(state.closed).toBe(1)
    expect(released).toEqual(['credentialed'])
  })

  test('can explicitly retain original bytes when the installed policy rejects runtime re-encoding', async () => {
    const released: string[] = []
    const vault = new CopyingVault()
    const sourceBytes = new Uint8Array([0xff, 0xd8, 0x49, 0x43, 0x43, 0x43, 0x32, 0x50, 0x41])
    const original = sourceBytes.slice()
    const state: CodecState = {
      metadata: { icc: 'present', c2pa: 'present' },
      integrity: { originalFormat: true, icc: 'discarded', c2pa: 'discarded' },
      closed: 0,
      deriveCalls: 0,
      derivedBytes: [],
    }
    const cache = new OnDeviceThumbnailCache({
      codec: makeCodec(state),
      vault,
      policy: { decide: () => ({ action: 'retain-source', reason: 'native codec cannot preserve credentials' }) },
    })

    const stored = await cache.cacheOne('gallery-a', providerImage('credentialed', sourceBytes, released))

    expect(stored.disposition).toBe('retained-source')
    expect(stored.width).toBe(4000)
    expect(stored.height).toBe(3000)
    expect(vault.writes[0]?.bytes).toEqual(original)
    expect(sourceBytes.every((value) => value === 0)).toBe(true)
    expect(state.derivedBytes[0]!.every((value) => value === 0)).toBe(true)
    expect(state.closed).toBe(1)
    expect(released).toEqual(['credentialed'])
  })

  test('bounds a 200-item provider stream to the configured number of live decodes', async () => {
    const released: string[] = []
    const vault = new CopyingVault()
    let releaseFirstWave!: () => void
    let blocked = true
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve })
    const active = { value: 0, maximum: 0, wait: () => blocked ? firstWave : Promise.resolve() }
    const state: CodecState = { active, closed: 0, deriveCalls: 0, derivedBytes: [] }
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault, maxConcurrent: 3 })

    async function* gallery() {
      for (let index = 0; index < 200; index += 1) {
        yield providerImage(`image-${index}`, new Uint8Array([index & 0xff, 1, 2]), released)
      }
    }

    const caching = cache.cacheGallery('gallery-200', gallery())
    while (active.value < 3) await Promise.resolve()
    expect(active.maximum).toBe(3)
    blocked = false
    releaseFirstWave()
    const summary = await caching

    expect(summary).toEqual({ stored: 200, retainedSources: 0, derived: 200 })
    expect(active.maximum).toBeLessThanOrEqual(3)
    expect(active.value).toBe(0)
    expect(state.closed).toBe(200)
    expect(released).toHaveLength(200)
    expect(vault.writes).toHaveLength(200)
    expect(state.derivedBytes.every((bytes) => bytes.every((value) => value === 0))).toBe(true)
  })

  test('cleans decoded, source, and derivative memory when encrypted vault storage fails', async () => {
    const released: string[] = []
    const vault = new CopyingVault()
    vault.fail = true
    const state: CodecState = { closed: 0, deriveCalls: 0, derivedBytes: [] }
    const sourceBytes = new Uint8Array([4, 3, 2, 1])
    const cache = new OnDeviceThumbnailCache({ codec: makeCodec(state), vault })

    await expect(cache.cacheOne('gallery-a', providerImage('failure', sourceBytes, released)))
      .rejects.toThrow('Injected vault failure')
    expect(sourceBytes.every((value) => value === 0)).toBe(true)
    expect(state.derivedBytes[0]!.every((value) => value === 0)).toBe(true)
    expect(state.closed).toBe(1)
    expect(released).toEqual(['failure'])
  })

  test('rejects concurrency above the hard memory bound', () => {
    const state: CodecState = { closed: 0, deriveCalls: 0, derivedBytes: [] }
    expect(() => new OnDeviceThumbnailCache({
      codec: makeCodec(state),
      vault: new CopyingVault(),
      maxConcurrent: MAX_THUMBNAIL_CONCURRENCY + 1,
    })).toThrow(`maxConcurrent cannot exceed ${MAX_THUMBNAIL_CONCURRENCY}`)
  })
})
