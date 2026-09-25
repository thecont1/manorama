import { describe, expect, test } from 'bun:test'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'
import { EncryptedVault, VAULT_INDEX_PATH, VAULT_ROOT, vaultFilePathIdentity, webCryptoProvider, __private__ } from './vault'

class MemoryStorage implements VaultStorageProvider {
  readonly files = new Map<string, Uint8Array>()
  failMoveOnce = false
  failMoveTo: string | null = null
  /** Paths that throw on remove — a real deletion failure, not a missing file. */
  readonly undeletable = new Set<string>()
  /** Paths where remove() silently keeps the file — verifies the post-purge check. */
  readonly sticky = new Set<string>()
  listAvailable = true

  async read(path: string) {
    const value = this.files.get(path)
    return value ? value.slice() : null
  }

  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes.slice())
  }

  async remove(path: string) {
    if (this.undeletable.has(path)) throw new Error(`Injected delete failure: ${path}`)
    if (this.sticky.has(path)) return
    this.files.delete(path)
  }

  async list(root: string) {
    if (!this.listAvailable) throw new Error('Enumeration unavailable')
    return [...this.files.entries()]
      .filter(([path]) => path === root || path.startsWith(`${root}/`))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }))
  }

  async move(from: string, to: string) {
    if (this.failMoveTo === to) {
      this.failMoveTo = null
      throw new Error(`Injected move failure: ${to}`)
    }
    if (this.failMoveOnce) {
      this.failMoveOnce = false
      throw new Error('Injected move failure')
    }
    const value = this.files.get(from)
    if (!value) throw new Error(`Missing temporary file: ${from}`)
    this.files.set(to, value)
    this.files.delete(from)
  }
}

class MemoryKeys implements VaultKeyProvider {
  readonly values = new Map<string, string>()
  /** Keys that throw on remove — deletion failure must be reported, not swallowed. */
  readonly undeletable = new Set<string>()
  /** Keys where remove() silently keeps the value — exercises the read-back check. */
  readonly sticky = new Set<string>()

  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) {
    if (this.undeletable.has(key)) throw new Error(`Injected key removal failure: ${key}`)
    if (this.sticky.has(key)) return
    this.values.delete(key)
  }
}

const deterministicCrypto = {
  ...webCryptoProvider,
  randomBytes(length: number) {
    const bytes = new Uint8Array(length)
    bytes.fill(7)
    return bytes
  },
}

const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array | undefined) => value ? new TextDecoder().decode(value) : undefined

const makeVault = (maxBytes = 256 * 1024 * 1024) => {
  const storage = new MemoryStorage()
  const keys = new MemoryKeys()
  let now = 0
  const vault = new EncryptedVault({
    storage,
    keys,
    crypto: deterministicCrypto,
    maxBytes,
    now: () => ++now,
  })
  return { vault, storage, keys }
}

describe('EncryptedVault', () => {
  test('round-trips encrypted gallery entries without storing plaintext', async () => {
    const { vault, storage, keys } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('private photograph'))

    const result = await vault.read('gallery-a', 'frame-1')
    expect(text(result)).toBe('private photograph')
    expect(storage.files.has(VAULT_INDEX_PATH)).toBe(true)
    expect([...storage.files.values()].some((value) => text(value) === 'private photograph')).toBe(false)
    expect(keys.values.size).toBe(1)
  })

  test('binds ciphertext to the gallery and entry identity', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('same bytes'))
    const index = JSON.parse(new TextDecoder().decode((await storage.read(VAULT_INDEX_PATH))!)) as { entries: Record<string, { path: string }> }
    const path = index.entries['gallery-a\u0000frame-1'].path
    const record = (await storage.read(path))!
    record[record.length - 1] ^= 0xff
    await storage.write(path, record)

    expect(await vault.read('gallery-a', 'frame-1')).toBeUndefined()
    expect((await vault.usage()).indexedBytes).toBe(0)
    expect(storage.files.has(path)).toBe(false)
  })

  test('publishes a replacement before removing the old entry', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('original'))
    const before = JSON.parse(new TextDecoder().decode((await storage.read(VAULT_INDEX_PATH))!)) as { entries: Record<string, { path: string }> }
    const oldPath = before.entries['gallery-a\u0000frame-1'].path

    storage.failMoveOnce = true
    await expect(vault.write('gallery-a', 'frame-1', bytes('replacement'))).rejects.toThrow('Injected move failure')

    expect(text(await vault.read('gallery-a', 'frame-1'))).toBe('original')
    expect(storage.files.has(oldPath)).toBe(true)
    expect([...storage.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
  })

  test('removes the old ciphertext only after a replacement is committed', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('original'))
    const before = JSON.parse(new TextDecoder().decode((await storage.read(VAULT_INDEX_PATH))!)) as { entries: Record<string, { path: string }> }
    const oldPath = before.entries['gallery-a\u0000frame-1'].path

    await vault.write('gallery-a', 'frame-1', bytes('replacement'))

    expect(text(await vault.read('gallery-a', 'frame-1'))).toBe('replacement')
    expect(storage.files.has(oldPath)).toBe(false)
    expect([...storage.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
  })

  test('cleans a temporary index after index promotion fails', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('original'))
    const before = JSON.parse(new TextDecoder().decode((await storage.read(VAULT_INDEX_PATH))!)) as { entries: Record<string, { path: string }> }
    const oldPath = before.entries['gallery-a\u0000frame-1'].path

    storage.failMoveTo = VAULT_INDEX_PATH
    await expect(vault.write('gallery-a', 'frame-1', bytes('replacement'))).rejects.toThrow('Injected move failure')

    expect(storage.files.has(VAULT_INDEX_PATH)).toBe(true)
    expect(storage.files.has(oldPath)).toBe(true)
    expect([...storage.files.keys()].some((path) => path.endsWith('.tmp'))).toBe(false)
    expect([...storage.files.keys()].some((path) => path.includes('.r'))).toBe(false)
    expect(text(await vault.read('gallery-a', 'frame-1'))).toBe('original')
  })

  test('evicts the least recently used entries at the configured cap', async () => {
    const { vault, keys } = makeVault(90)
    await vault.write('gallery-a', 'a', bytes('one'))
    await vault.write('gallery-b', 'b', bytes('two'))
    expect(await vault.read('gallery-a', 'a')).toBeDefined()

    await vault.write('gallery-c', 'c', bytes('three'))

    expect(await vault.read('gallery-a', 'a')).toBeDefined()
    expect(await vault.read('gallery-b', 'b')).toBeUndefined()
    expect(await vault.read('gallery-c', 'c')).toBeDefined()
    expect(keys.values.has('manorama-vault-key-v1:Z2FsbGVyeS1i')).toBe(false)
  })

  test('treats a missing gallery key as a recoverable cache miss', async () => {
    const { vault, keys, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('private photograph'))
    keys.values.clear()

    expect(await vault.read('gallery-a', 'frame-1')).toBeUndefined()
    expect((await vault.usage()).indexedBytes).toBe(0)
    expect([...storage.files.keys()]).toEqual([VAULT_INDEX_PATH])
  })

  test('rejects an entry larger than the vault cap without leaving a file', async () => {
    const { vault, storage, keys } = makeVault(40)

    await expect(vault.write('gallery-a', 'frame-1', bytes('too large'))).rejects.toThrow('exceeds the configured size cap')
    expect((await vault.usage()).indexedBytes).toBe(0)
    expect([...storage.files.keys()]).toEqual([])
    // Size is known before encryption, so a rejected write never mints a key
    // the index could not enumerate later.
    expect(keys.values.size).toBe(0)
  })
})

describe('EncryptedVault settings surface', () => {
  test('usage() splits measured bytes into entries, index, temp and orphans', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    await vault.write('gallery-b', 'frame-2', bytes('two'))
    storage.files.set(`${VAULT_ROOT}/g.b3JwaGFu.e.ZmlsZQ.bin`, bytes('orphaned'))
    storage.files.set(`${VAULT_ROOT}/g.b3JwaGFu.e.ZmlsZQ.bin.tmp`, bytes('partial'))

    const usage = await vault.usage()

    expect(usage.indexedBytes).toBeGreaterThan(0)
    expect(usage.entryBytes).toBe(usage.indexedBytes)
    expect(usage.indexBytes).toBe((await storage.read(VAULT_INDEX_PATH))!.length)
    expect(usage.tempBytes).toBe(bytes('partial').length)
    expect(usage.orphanBytes).toBe(bytes('orphaned').length)
    expect(usage.measuredBytes).toBe(usage.entryBytes + usage.indexBytes + usage.tempBytes + usage.orphanBytes)
    const orphan = usage.galleries.find((gallery) => gallery.galleryId === 'orphan')
    expect(orphan?.measuredBytes).toBe(bytes('orphaned').length + bytes('partial').length)
    expect(orphan?.entries).toBe(0)
  })

  test('usage() refuses to guess when enumeration is unavailable', async () => {
    const { vault, storage } = makeVault()
    storage.listAvailable = false
    await vault.write('gallery-a', 'frame-1', bytes('one'))

    await expect(vault.usage()).rejects.toThrow('Enumeration')
  })

  test('listGalleryIds() recovers identities from orphaned files after index loss', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    const stored = [...storage.files.keys()].filter((path) => path !== VAULT_INDEX_PATH)
    storage.files.clear()
    for (const path of stored) storage.files.set(path, bytes('corrupt ciphertext'))
    // A corrupt or absent index must not hide files that are still on disk.
    storage.files.delete(VAULT_INDEX_PATH)

    expect(await vault.listGalleryIds()).toEqual(['gallery-a'])
  })

  test('clearGallery() removes indexed, orphaned and temporary files plus the gallery key', async () => {
    const { vault, storage, keys } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    await vault.write('gallery-b', 'frame-2', bytes('two'))
    const orphanPath = `${VAULT_ROOT}/g.${__private__.encodeId('gallery-a')}.e.${__private__.encodeId('lost')}.bin`
    storage.files.set(orphanPath, bytes('orphaned'))
    storage.files.set(`${orphanPath}.tmp`, bytes('partial'))

    await vault.clearGallery('gallery-a')

    expect(await vault.listGalleryIds()).toEqual(['gallery-b'])
    expect([...storage.files.keys()].some((path) => path.includes(__private__.encodeId('gallery-a')))).toBe(false)
    expect(keys.values.has(__private__.galleryKey('gallery-a'))).toBe(false)
    expect(text(await vault.read('gallery-b', 'frame-2'))).toBe('two')
  })

  test('clearGallery() reports an undeletable file instead of claiming success', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    const path = [...storage.files.keys()].find((candidate) => candidate !== VAULT_INDEX_PATH)!
    storage.undeletable.add(path)

    await expect(vault.clearGallery('gallery-a')).rejects.toThrow('could not verify')
    expect(storage.files.has(path)).toBe(true)
  })

  test('clearGallery() reports a file that silently survives removal', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    const path = [...storage.files.keys()].find((candidate) => candidate !== VAULT_INDEX_PATH)!
    storage.sticky.add(path)

    await expect(vault.clearGallery('gallery-a')).rejects.toThrow('still present')
  })

  test('clearGallery() reports a gallery key that survives removal', async () => {
    const { vault, keys } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    keys.sticky.add(__private__.galleryKey('gallery-a'))

    await expect(vault.clearGallery('gallery-a')).rejects.toThrow('could not verify')
  })

  test('clear() removes every file under the root and every gallery key', async () => {
    const { vault, storage, keys } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    await vault.write('gallery-b', 'frame-2', bytes('two'))
    storage.files.set(`${VAULT_ROOT}/g.${__private__.encodeId('gallery-c')}.e.${__private__.encodeId('lost')}.bin`, bytes('orphan'))

    await vault.clear()

    expect([...storage.files.keys()]).toEqual([])
    expect(keys.values.size).toBe(0)
    expect(await vault.listGalleryIds()).toEqual([])
  })

  test('clear() reports a surviving key without hiding the failure', async () => {
    const { vault, keys } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    keys.undeletable.add(__private__.galleryKey('gallery-a'))

    await expect(vault.clear()).rejects.toThrow('could not verify')
  })

  test('a write captured before a purge cannot repopulate the vault', async () => {
    const { vault } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    const stale = { since: vault.epoch() }

    await vault.clearGallery('gallery-a')

    await expect(vault.write('gallery-a', 'frame-2', bytes('late'), stale)).rejects.toThrow('cleared while this write was in flight')
    expect(await vault.listGalleryIds()).toEqual([])
    await vault.write('gallery-a', 'frame-2', bytes('fresh'), { since: vault.epoch() })
    expect(text(await vault.read('gallery-a', 'frame-2'))).toBe('fresh')
  })

  test('clear() invalidates writes captured for any gallery', async () => {
    const { vault } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    const stale = { since: vault.epoch() }

    await vault.clear()

    await expect(vault.write('gallery-a', 'frame-2', bytes('late'), stale)).rejects.toThrow('cleared while this write was in flight')
  })

  test('setCap validates bounds and evictToCap applies them explicitly', async () => {
    const { vault } = makeVault()
    expect(() => vault.setCap(0)).toThrow('Invalid vault size cap')
    expect(() => vault.setCap(1.5)).toThrow('Invalid vault size cap')
    expect(() => vault.setCap(-4)).toThrow('Invalid vault size cap')

    vault.setCap(null)
    expect(vault.cap).toBeNull()

    await vault.write('gallery-a', 'a', bytes('one'))
    await vault.write('gallery-b', 'b', bytes('two'))
    await vault.write('gallery-c', 'c', bytes('three'))
    const before = (await vault.usage()).indexedBytes
    vault.setCap(before - 1)
    // setCap alone never evicts; only an explicit request does.
    expect((await vault.usage()).indexedBytes).toBe(before)

    const result = await vault.evictToCap()
    expect(result.removedBytes).toBeGreaterThan(0)
    expect((await vault.usage()).indexedBytes).toBeLessThanOrEqual(before - 1)
  })

  test('a settings read does not move an entry up the eviction order', async () => {
    const { vault } = makeVault(90)
    await vault.write('gallery-a', 'a', bytes('one'))
    await vault.write('gallery-b', 'b', bytes('two'))
    expect(await vault.read('gallery-a', 'a', { touch: false })).toBeDefined()

    await vault.write('gallery-c', 'c', bytes('three'))

    // Untouched by the display read, gallery-a is still the oldest and evicts.
    expect(await vault.read('gallery-a', 'a')).toBeUndefined()
    expect(await vault.read('gallery-b', 'b')).toBeDefined()
  })

  test('a corrupt index does not hide measured bytes from usage()', async () => {
    const { vault, storage } = makeVault()
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    storage.files.set(VAULT_INDEX_PATH, bytes('{not json'))

    const usage = await vault.usage()

    expect(usage.indexedBytes).toBe(0)
    expect(usage.orphanBytes).toBeGreaterThan(0)
    expect(usage.measuredBytes).toBeGreaterThan(0)
  })

  test('a rewritten entry keeps a single-segment path with gallery identity', async () => {
    const storage = new MemoryStorage()
    const keys = new MemoryKeys()
    let now = 0
    const vault = new EncryptedVault({
      storage,
      keys,
      // 0xff entropy base64-encodes to '/', which used to split the
      // replacement filename into a subdirectory and strip its identity.
      crypto: { ...webCryptoProvider, randomBytes: (length) => new Uint8Array(length).fill(0xff) },
      now: () => ++now,
    })
    await vault.write('gallery-a', 'frame-1', bytes('one'))
    await vault.write('gallery-a', 'frame-1', bytes('two'))

    const replacements = [...storage.files.keys()].filter((path) => path.includes('.r'))
    expect(replacements).toHaveLength(1)
    const segments = replacements[0].split('/')
    expect(segments.at(-1)).toMatch(/^g\..+\.e\..+\.bin\.r\d+-[A-Za-z0-9_-]+$/)
    expect(vaultFilePathIdentity(replacements[0])).toEqual({ galleryId: 'gallery-a', entryId: 'frame-1' })

    const usage = await vault.usage()
    const gallery = usage.galleries.find((entry) => entry.galleryId === 'gallery-a')
    expect(gallery?.measuredBytes).toBeGreaterThan(0)
  })
})
