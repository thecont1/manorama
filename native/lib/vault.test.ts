import { describe, expect, test } from 'bun:test'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'
import { EncryptedVault, VAULT_INDEX_PATH, webCryptoProvider } from './vault'

class MemoryStorage implements VaultStorageProvider {
  readonly files = new Map<string, Uint8Array>()
  failMoveOnce = false

  async read(path: string) {
    const value = this.files.get(path)
    return value ? value.slice() : null
  }

  async write(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes.slice())
  }

  async remove(path: string) {
    this.files.delete(path)
  }

  async move(from: string, to: string) {
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

  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
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
    expect(await vault.sizeBytes()).toBe(0)
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
    expect(await vault.sizeBytes()).toBe(0)
    expect([...storage.files.keys()]).toEqual([VAULT_INDEX_PATH])
  })

  test('rejects an entry larger than the vault cap without leaving a file', async () => {
    const { vault, storage } = makeVault(40)

    await expect(vault.write('gallery-a', 'frame-1', bytes('too large'))).rejects.toThrow('exceeds the configured size cap')
    expect(await vault.sizeBytes()).toBe(0)
    expect([...storage.files.keys()]).toEqual([])
  })
})
