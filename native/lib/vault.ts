import { Directory, Filesystem } from '@capacitor/filesystem'
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'

export const VAULT_VERSION = 1
export const VAULT_ROOT = 'manorama-vault-v1'
export const VAULT_INDEX_PATH = `${VAULT_ROOT}/index.json`
export const VAULT_DIRECTORY = Directory.LibraryNoCloud

const MAGIC = new Uint8Array([0x4d, 0x4e, 0x56, 0x31])
const HEADER_BYTES = 12
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const ALGORITHM = 1
const MAX_ID_BYTES = 1024

export interface VaultStorageProvider {
  read(path: string): Promise<Uint8Array | null>
  write(path: string, bytes: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  move?(from: string, to: string): Promise<void>
}
export interface VaultKeyProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
export interface VaultCryptoProvider {
  randomBytes(length: number): Uint8Array
  encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}
export interface VaultOptions {
  maxBytes?: number
  storage?: VaultStorageProvider
  keys?: VaultKeyProvider
  crypto?: VaultCryptoProvider
  now?: () => number
}

type Entry = { galleryId: string; entryId: string; path: string; bytes: number; lastAccess: number }
type Index = { version: typeof VAULT_VERSION; entries: Record<string, Entry> }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const arrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer
const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
const encodeId = (value: string): string => {
  if (!value || encoder.encode(value).length > MAX_ID_BYTES) throw new Error('Invalid vault identifier')
  return toBase64(encoder.encode(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
const entryKey = (galleryId: string, entryId: string): string => `${galleryId}\u0000${entryId}`
const galleryKey = (galleryId: string): string => `manorama-vault-key-v1:${encodeId(galleryId)}`
const entryPath = (galleryId: string, entryId: string): string => `${VAULT_ROOT}/g.${encodeId(galleryId)}.e.${encodeId(entryId)}.bin`
const readU32 = (bytes: Uint8Array): number => ((bytes[8] << 24) >>> 0) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]
const writeU32 = (bytes: Uint8Array, value: number): void => { bytes[8] = value >>> 24; bytes[9] = value >>> 16; bytes[10] = value >>> 8; bytes[11] = value }
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i])
const associatedData = (header: Uint8Array, galleryId: string, entryId: string): Uint8Array => {
  const identity = encoder.encode(`${galleryId}\u0000${entryId}`)
  const aad = new Uint8Array(header.length + identity.length)
  aad.set(header); aad.set(identity, header.length)
  return aad
}

/** Binary record: magic[4], version[1], algorithm[1], nonce length[1], tag length[1], ciphertext length[4], nonce[12], ciphertext+tag. */
export const webCryptoProvider: VaultCryptoProvider = {
  randomBytes(length) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes },
  async encrypt(key, nonce, plaintext, aad) {
    const cryptoKey = await crypto.subtle.importKey('raw', arrayBuffer(key), 'AES-GCM', false, ['encrypt'])
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(aad), tagLength: TAG_BYTES * 8 }, cryptoKey, arrayBuffer(plaintext)))
  },
  async decrypt(key, nonce, ciphertext, aad) {
    const cryptoKey = await crypto.subtle.importKey('raw', arrayBuffer(key), 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: arrayBuffer(nonce), additionalData: arrayBuffer(aad), tagLength: TAG_BYTES * 8 }, cryptoKey, arrayBuffer(ciphertext)))
  },
}

const pack = async (key: Uint8Array, galleryId: string, entryId: string, plaintext: Uint8Array, provider: VaultCryptoProvider): Promise<Uint8Array> => {
  if (key.length !== KEY_BYTES) throw new Error('Vault key must be 256 bits')
  const nonce = provider.randomBytes(NONCE_BYTES)
  if (nonce.length !== NONCE_BYTES) throw new Error('Invalid nonce')
  const header = new Uint8Array(HEADER_BYTES)
  header.set(MAGIC); header[4] = VAULT_VERSION; header[5] = ALGORITHM; header[6] = NONCE_BYTES; header[7] = TAG_BYTES
  writeU32(header, plaintext.length + TAG_BYTES)
  const ciphertext = await provider.encrypt(key, nonce, plaintext, associatedData(header, galleryId, entryId))
  if (ciphertext.length !== plaintext.length + TAG_BYTES) throw new Error('Invalid ciphertext')
  const record = new Uint8Array(HEADER_BYTES + NONCE_BYTES + ciphertext.length)
  record.set(header); record.set(nonce, HEADER_BYTES); record.set(ciphertext, HEADER_BYTES + NONCE_BYTES)
  return record
}
const unpack = async (record: Uint8Array, key: Uint8Array, galleryId: string, entryId: string, provider: VaultCryptoProvider): Promise<Uint8Array> => {
  if (record.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) throw new Error('Truncated vault record')
  const header = record.subarray(0, HEADER_BYTES)
  if (!same(header.subarray(0, 4), MAGIC) || header[4] !== VAULT_VERSION || header[5] !== ALGORITHM || header[6] !== NONCE_BYTES || header[7] !== TAG_BYTES) throw new Error('Unsupported vault record')
  const ciphertextLength = readU32(header)
  if (ciphertextLength < TAG_BYTES || record.length !== HEADER_BYTES + NONCE_BYTES + ciphertextLength) throw new Error('Invalid vault record length')
  return provider.decrypt(key, record.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES), record.subarray(HEADER_BYTES + NONCE_BYTES), associatedData(header, galleryId, entryId))
}

const nativeStorage: VaultStorageProvider = {
  async read(path) {
    try { const result = await Filesystem.readFile({ path, directory: VAULT_DIRECTORY }); return typeof result.data === 'string' ? fromBase64(result.data) : new Uint8Array(await result.data.arrayBuffer()) } catch { return null }
  },
  async write(path, bytes) { await Filesystem.writeFile({ path, data: toBase64(bytes), directory: VAULT_DIRECTORY, recursive: true }) },
  async move(from, to) { await Filesystem.rename({ from, to, directory: VAULT_DIRECTORY }) },
  async remove(path) { try { await Filesystem.deleteFile({ path, directory: VAULT_DIRECTORY }) } catch { /* Missing is already removed. */ } },
}
const nativeKeys: VaultKeyProvider = {
  get: (key) => SecureStorage.getItem(key),
  async set(key, value) { await SecureStorage.setSynchronize(false); await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly); await SecureStorage.setItem(key, value) },
  async remove(key) { try { await SecureStorage.removeItem(key) } catch { /* Missing is already removed. */ } },
}
const emptyIndex = (): Index => ({ version: VAULT_VERSION, entries: {} })
const validIndex = (value: unknown): value is Index => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Index>
  return candidate.version === VAULT_VERSION && !!candidate.entries && typeof candidate.entries === 'object'
}

export class VaultEntryTooLargeError extends Error {
  constructor() { super('Vault entry exceeds the configured size cap'); this.name = 'VaultEntryTooLargeError' }
}
export class EncryptedVault {
  private readonly storage: VaultStorageProvider
  private readonly keys: VaultKeyProvider
  private readonly crypto: VaultCryptoProvider
  private readonly maxBytes: number
  private readonly now: () => number
  private tail: Promise<void> = Promise.resolve()
  constructor(options: VaultOptions = {}) {
    this.storage = options.storage ?? nativeStorage; this.keys = options.keys ?? nativeKeys; this.crypto = options.crypto ?? webCryptoProvider
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('Invalid vault size cap')
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const previous = this.tail; let release!: () => void; this.tail = new Promise((resolve) => { release = resolve }); await previous; try { return await operation() } finally { release() } }
  private async loadIndex(): Promise<Index> { const raw = await this.storage.read(VAULT_INDEX_PATH); if (!raw) return emptyIndex(); try { const value: unknown = JSON.parse(decoder.decode(raw)); return validIndex(value) ? value : emptyIndex() } catch { return emptyIndex() } }
  private async saveIndex(index: Index): Promise<void> {
    const bytes = encoder.encode(JSON.stringify(index))
    const temporary = `${VAULT_INDEX_PATH}.tmp`
    await this.storage.write(temporary, bytes)
    if (this.storage.move) await this.storage.move(temporary, VAULT_INDEX_PATH)
    else { await this.storage.write(VAULT_INDEX_PATH, bytes); await this.storage.remove(temporary) }
  }
  private async loadKey(galleryId: string, create: boolean): Promise<Uint8Array | null> {
    const name = galleryKey(galleryId); const value = await this.keys.get(name)
    if (value) { try { const key = fromBase64(value); if (key.length === KEY_BYTES) return key } catch { /* Corrupt key is discarded. */ } await this.keys.remove(name) }
    if (!create) return null
    const key = this.crypto.randomBytes(KEY_BYTES); if (key.length !== KEY_BYTES) throw new Error('Invalid key')
    await this.keys.set(name, toBase64(key)); return key
  }
  private async removeEntry(index: Index, entry: Entry): Promise<void> {
    delete index.entries[entryKey(entry.galleryId, entry.entryId)]; await this.storage.remove(entry.path)
    if (!Object.values(index.entries).some((candidate) => candidate.galleryId === entry.galleryId)) await this.keys.remove(galleryKey(entry.galleryId))
  }
  private async evict(index: Index): Promise<void> {
    let total = Object.values(index.entries).reduce((sum, entry) => sum + entry.bytes, 0)
    while (total > this.maxBytes) { const oldest = Object.values(index.entries).sort((a, b) => a.lastAccess - b.lastAccess)[0]; if (!oldest) break; total -= oldest.bytes; await this.removeEntry(index, oldest) }
  }
  async write(galleryId: string, entryId: string, plaintext: Uint8Array): Promise<void> {
    return this.serial(async () => {
      const key = await this.loadKey(galleryId, true); if (!key) throw new Error('Missing vault key')
      const record = await pack(key, galleryId, entryId, plaintext, this.crypto); if (record.length > this.maxBytes) throw new VaultEntryTooLargeError()
      const index = await this.loadIndex(); const id = entryKey(galleryId, entryId); const old = index.entries[id]; if (old) await this.storage.remove(old.path)
      const path = entryPath(galleryId, entryId); const temporary = `${path}.tmp`; await this.storage.write(temporary, record)
      if (this.storage.move) await this.storage.move(temporary, path)
      else { await this.storage.write(path, record); await this.storage.remove(temporary) }
      index.entries[id] = { galleryId, entryId, path, bytes: record.length, lastAccess: this.now() }; await this.evict(index); await this.saveIndex(index)
    })
  }
  async read(galleryId: string, entryId: string): Promise<Uint8Array | undefined> {
    return this.serial(async () => {
      const index = await this.loadIndex(); const entry = index.entries[entryKey(galleryId, entryId)]; if (!entry) return undefined
      const record = await this.storage.read(entry.path); const key = await this.loadKey(galleryId, false)
      if (!record || !key) { await this.removeEntry(index, entry); await this.saveIndex(index); return undefined }
      try { const plaintext = await unpack(record, key, galleryId, entryId, this.crypto); entry.lastAccess = this.now(); await this.saveIndex(index); return plaintext } catch { await this.removeEntry(index, entry); await this.saveIndex(index); return undefined }
    })
  }
  async remove(galleryId: string, entryId: string): Promise<void> { return this.serial(async () => { const index = await this.loadIndex(); const entry = index.entries[entryKey(galleryId, entryId)]; if (entry) await this.removeEntry(index, entry); await this.saveIndex(index) }) }
  async clearGallery(galleryId: string): Promise<void> { return this.serial(async () => { const index = await this.loadIndex(); for (const entry of Object.values(index.entries)) if (entry.galleryId === galleryId) await this.storage.remove(entry.path); for (const key of Object.keys(index.entries)) if (index.entries[key].galleryId === galleryId) delete index.entries[key]; await this.keys.remove(galleryKey(galleryId)); await this.saveIndex(index) }) }
  async clear(): Promise<void> { return this.serial(async () => { const index = await this.loadIndex(); for (const entry of Object.values(index.entries)) await this.storage.remove(entry.path); for (const galleryId of new Set(Object.values(index.entries).map((entry) => entry.galleryId))) await this.keys.remove(galleryKey(galleryId)); await this.saveIndex(emptyIndex()) }) }
  async sizeBytes(): Promise<number> { return this.serial(async () => { const index = await this.loadIndex(); return Object.values(index.entries).reduce((sum, entry) => sum + entry.bytes, 0) }) }
}

export const createProductionVault = (options: Omit<VaultOptions, 'storage' | 'keys' | 'crypto'> = {}): EncryptedVault => new EncryptedVault(options)
export const productionVault = createProductionVault()
export const __private__ = { pack, unpack, entryPath, galleryKey, encodeId, HEADER_BYTES, NONCE_BYTES, TAG_BYTES }
export type { Entry, Index }
