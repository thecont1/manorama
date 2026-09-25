import { Directory, Filesystem } from '@capacitor/filesystem'
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'

export const VAULT_VERSION = 1
export const VAULT_ROOT = 'manorama-vault-v1'
export const VAULT_INDEX_PATH = `${VAULT_ROOT}/index.json`
export const VAULT_DIRECTORY = Directory.LibraryNoCloud
/** Default cap, and the Free-plan ceiling: 256 MiB of index-recorded entry bytes. */
export const DEFAULT_VAULT_CAP_BYTES = 256 * 1024 * 1024
export const VAULT_KEY_PREFIX = 'manorama-vault-key-v1'

const MAGIC = new Uint8Array([0x4d, 0x4e, 0x56, 0x31])
const HEADER_BYTES = 12
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const ALGORITHM = 1
const MAX_ID_BYTES = 1024

export type VaultFileStat = { path: string; bytes: number }
export interface VaultStorageProvider {
  read(path: string): Promise<Uint8Array | null>
  write(path: string, bytes: Uint8Array): Promise<void>
  /** Throws when a real file survives the deletion. "Already missing" is success. */
  remove(path: string): Promise<void>
  move?(from: string, to: string): Promise<void>
  /** Every file under `root` with its logical byte length. Absent means enumeration is unavailable. */
  list?(root: string): Promise<VaultFileStat[]>
}
export interface VaultKeyProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  /** Throws when the key survives the removal. "Already missing" is success. */
  remove(key: string): Promise<void>
}
export interface VaultCryptoProvider {
  randomBytes(length: number): Uint8Array
  encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  decrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}
export interface VaultOptions {
  /** Byte ceiling for index-recorded entry bytes; `null` means unlimited. */
  maxBytes?: number | null
  storage?: VaultStorageProvider
  keys?: VaultKeyProvider
  crypto?: VaultCryptoProvider
  now?: () => number
}

/**
 * A purge advances these counters inside the serialized mutation boundary.
 * A writer that started before the purge hands its epoch to `write`, which
 * refuses to commit once the epoch moved — otherwise a background cache fill
 * could repopulate the vault after the purge confirmed. `mutation` moves on
 * every destructive operation so a caller can mark itself in-flight before it
 * even knows which gallery it will write to.
 */
export type VaultEpoch = { clear: number; mutation: number }
export type VaultWriteGuard = { since: VaultEpoch }

type Entry = { galleryId: string; entryId: string; path: string; bytes: number; lastAccess: number }
type Index = { version: typeof VAULT_VERSION; entries: Record<string, Entry> }

export type VaultGalleryUsage = {
  galleryId: string
  /** Entries the index claims (their files may be missing). */
  entries: number
  /** Index-recorded ciphertext lengths — the bytes the size cap bounds. */
  indexedBytes: number
  /** Bytes measured on disk for this gallery, including orphaned files it owns. */
  measuredBytes: number
}
/**
 * Honest accounting: `measuredBytes` is the sum of logical file lengths under
 * the vault root. It is not filesystem allocated-block usage, and it is not an
 * estimate of free space. The size cap bounds `indexedBytes`; index, temp and
 * orphan overhead is reported separately because eviction cannot reclaim it.
 */
export type VaultUsage = {
  measuredBytes: number
  indexedBytes: number
  entryBytes: number
  indexBytes: number
  tempBytes: number
  orphanBytes: number
  galleries: VaultGalleryUsage[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
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
/** Reverses `encodeId`; the canonical round trip rejects arbitrary file names. */
const decodeId = (value: string): string | undefined => {
  if (!value) return undefined
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const bytes = fromBase64(padded)
    const text = strictDecoder.decode(bytes)
    return encodeId(text) === value ? text : undefined
  } catch {
    return undefined
  }
}
const entryKey = (galleryId: string, entryId: string): string => `${galleryId}\u0000${entryId}`
const galleryKey = (galleryId: string): string => `${VAULT_KEY_PREFIX}:${encodeId(galleryId)}`
const entryPath = (galleryId: string, entryId: string): string => `${VAULT_ROOT}/g.${encodeId(galleryId)}.e.${encodeId(entryId)}.bin`
/** Filenames carry the gallery identity, so orphaned files can still be owned and purged. */
export const vaultFilePathIdentity = (path: string): { galleryId?: string; entryId?: string } => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!name.startsWith('g.')) return {}
  const parts = name.split('.')
  if (parts.length < 5 || parts[0] !== 'g' || parts[2] !== 'e' || parts[4] !== 'bin') return {}
  const galleryId = decodeId(parts[1])
  if (!galleryId) return {}
  const entryId = decodeId(parts[3])
  return entryId ? { galleryId, entryId } : { galleryId }
}
const isTemporaryPath = (path: string): boolean => path.endsWith('.tmp')
const readU32 = (bytes: Uint8Array): number => ((bytes[8] << 24) >>> 0) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]
const writeU32 = (bytes: Uint8Array, value: number): void => { bytes[8] = value >>> 24; bytes[9] = value >>> 16; bytes[10] = value >>> 8; bytes[11] = value }
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((value, i) => value === b[i])
const associatedData = (header: Uint8Array, galleryId: string, entryId: string): Uint8Array => {
  const identity = encoder.encode(`${galleryId}\u0000${entryId}`)
  const aad = new Uint8Array(header.length + identity.length)
  aad.set(header); aad.set(identity, header.length)
  return aad
}
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

const fileExists = async (path: string): Promise<boolean> => {
  try { await Filesystem.stat({ path, directory: VAULT_DIRECTORY }); return true } catch { return false }
}

const nativeStorage: VaultStorageProvider = {
  async read(path) {
    try { const result = await Filesystem.readFile({ path, directory: VAULT_DIRECTORY }); return typeof result.data === 'string' ? fromBase64(result.data) : new Uint8Array(await result.data.arrayBuffer()) } catch { return null }
  },
  async write(path, bytes) { await Filesystem.writeFile({ path, data: toBase64(bytes), directory: VAULT_DIRECTORY, recursive: true }) },
  async move(from, to) { await Filesystem.rename({ from, to, directory: VAULT_DIRECTORY }) },
  async remove(path) {
    try { await Filesystem.deleteFile({ path, directory: VAULT_DIRECTORY }) } catch (error) {
      // A resolved delete is not proof of deletion; "already gone" is the only
      // failure this adapter may absorb.
      if (await fileExists(path)) throw error
    }
  },
  async list(root) {
    const files: VaultFileStat[] = []
    const walk = async (directory: string): Promise<void> => {
      let listing: Awaited<ReturnType<typeof Filesystem.readdir>> | undefined
      try { listing = await Filesystem.readdir({ path: directory, directory: VAULT_DIRECTORY }) } catch { return }
      for (const entry of listing.files) {
        const path = `${directory}/${entry.name}`
        if (entry.type === 'directory') { await walk(path); continue }
        let bytes = entry.size
        if (!Number.isFinite(bytes) || bytes < 0) {
          // Deletion coverage beats accounting here: an unstattable file must
          // still be listed so purge can reach it.
          try { bytes = (await Filesystem.stat({ path, directory: VAULT_DIRECTORY })).size } catch { bytes = 0 }
        }
        files.push({ path, bytes })
      }
    }
    await walk(root)
    return files
  },
}
const nativeKeys: VaultKeyProvider = {
  get: (key) => SecureStorage.getItem(key),
  async set(key, value) { await SecureStorage.setSynchronize(false); await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly); await SecureStorage.setItem(key, value) },
  async remove(key) {
    try { await SecureStorage.removeItem(key) } catch (error) {
      // Absorb only "already absent"; a key that survives must fail loudly.
      try { if (await SecureStorage.getItem(key) === null) return } catch { /* Unverifiable: report the original failure. */ }
      throw error
    }
  },
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
export class VaultStaleWriteError extends Error {
  constructor() { super('The vault was cleared while this write was in flight'); this.name = 'VaultStaleWriteError' }
}
export class VaultUsageUnavailableError extends Error {
  constructor() { super('Vault usage requires filesystem enumeration'); this.name = 'VaultUsageUnavailableError' }
}
/** Never swallowed: purge reports every resource it could not prove deleted. */
export class VaultDeletionError extends Error {
  constructor(readonly failures: string[]) {
    super(`Vault cleanup could not verify ${failures.length} removal(s): ${failures[0] ?? 'unknown resource'}`)
    this.name = 'VaultDeletionError'
  }
}

const normalizeCap = (bytes: number | null): number => {
  if (bytes === null) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid vault size cap')
  return bytes
}

export class EncryptedVault {
  private readonly storage: VaultStorageProvider
  private readonly keys: VaultKeyProvider
  private readonly crypto: VaultCryptoProvider
  private capBytes: number
  private readonly now: () => number
  private tail: Promise<void> = Promise.resolve()
  private replacementSequence = 0
  private clearEpoch = 0
  private mutationEpoch = 0
  constructor(options: VaultOptions = {}) {
    this.storage = options.storage ?? nativeStorage; this.keys = options.keys ?? nativeKeys; this.crypto = options.crypto ?? webCryptoProvider
    this.capBytes = normalizeCap(options.maxBytes === undefined ? DEFAULT_VAULT_CAP_BYTES : options.maxBytes)
    this.now = options.now ?? Date.now
  }
  /** `null` means unlimited. Setting a bound never evicts by itself. */
  get cap(): number | null { return Number.isFinite(this.capBytes) ? this.capBytes : null }
  setCap(bytes: number | null): void { this.capBytes = normalizeCap(bytes) }
  epoch(): VaultEpoch {
    return { clear: this.clearEpoch, mutation: this.mutationEpoch }
  }
  private bumpMutationEpoch(): void {
    this.mutationEpoch += 1
  }
  private isStale(since: VaultEpoch): boolean {
    return since.clear !== this.clearEpoch || since.mutation !== this.mutationEpoch
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const previous = this.tail; let release!: () => void; this.tail = new Promise((resolve) => { release = resolve }); await previous; try { return await operation() } finally { release() } }
  private async loadIndex(): Promise<Index> { const raw = await this.storage.read(VAULT_INDEX_PATH); if (!raw) return emptyIndex(); try { const value: unknown = JSON.parse(decoder.decode(raw)); return validIndex(value) ? value : emptyIndex() } catch { return emptyIndex() } }
  private async saveIndex(index: Index): Promise<void> {
    const bytes = encoder.encode(JSON.stringify(index))
    const temporary = `${VAULT_INDEX_PATH}.tmp`
    await this.storage.write(temporary, bytes)
    try {
      if (this.storage.move) await this.storage.move(temporary, VAULT_INDEX_PATH)
      else { await this.storage.write(VAULT_INDEX_PATH, bytes); await this.storage.remove(temporary) }
    } catch (error) {
      await this.storage.remove(temporary)
      throw error
    }
  }
  private async listFiles(): Promise<VaultFileStat[]> {
    if (!this.storage.list) throw new VaultUsageUnavailableError()
    return this.storage.list(VAULT_ROOT)
  }
  private async listFilesIfAvailable(): Promise<VaultFileStat[] | undefined> {
    if (!this.storage.list) return undefined
    return this.storage.list(VAULT_ROOT)
  }
  private async loadKey(galleryId: string, create: boolean): Promise<{ key: Uint8Array; created: boolean } | null> {
    const name = galleryKey(galleryId); const value = await this.keys.get(name)
    if (value) {
      try { const key = fromBase64(value); if (key.length === KEY_BYTES) return { key, created: false } } catch { /* Corrupt key is discarded. */ }
      await this.keys.remove(name)
    }
    if (!create) return null
    const key = this.crypto.randomBytes(KEY_BYTES); if (key.length !== KEY_BYTES) throw new Error('Invalid key')
    await this.keys.set(name, toBase64(key)); return { key, created: true }
  }
  /** A resolved `remove` is not proof: read the key back before claiming it is gone. */
  private async removeGalleryKey(galleryId: string): Promise<void> {
    const name = galleryKey(galleryId)
    await this.keys.remove(name)
    if (await this.keys.get(name) !== null) throw new Error(`Vault key survived removal for ${galleryId}`)
  }
  private async removeEntry(index: Index, entry: Entry): Promise<void> {
    delete index.entries[entryKey(entry.galleryId, entry.entryId)]; await this.storage.remove(entry.path)
    if (!Object.values(index.entries).some((candidate) => candidate.galleryId === entry.galleryId)) await this.removeGalleryKey(entry.galleryId)
  }
  private async evict(index: Index): Promise<number> {
    let total = Object.values(index.entries).reduce((sum, entry) => sum + entry.bytes, 0)
    let removedBytes = 0
    while (total > this.capBytes) { const oldest = Object.values(index.entries).sort((a, b) => a.lastAccess - b.lastAccess)[0]; if (!oldest) break; total -= oldest.bytes; removedBytes += oldest.bytes; await this.removeEntry(index, oldest) }
    return removedBytes
  }
  private replacementPath(galleryId: string, entryId: string): string {
    const entropy = this.crypto.randomBytes(8)
    if (entropy.length !== 8) throw new Error('Invalid replacement nonce')
    this.replacementSequence += 1
    return `${entryPath(galleryId, entryId)}.r${this.replacementSequence}-${toBase64(entropy)}`
  }
  /**
   * Brings index-recorded entry bytes under the current cap by dropping the
   * least recently used entries. `lastAccess` is only written by reads and by
   * this eviction, never by settings display.
   */
  async evictToCap(): Promise<{ removedEntries: number; removedBytes: number }> {
    return this.serial(async () => {
      const index = await this.loadIndex()
      const beforeEntries = Object.keys(index.entries).length
      const removedBytes = await this.evict(index)
      const removedEntries = beforeEntries - Object.keys(index.entries).length
      if (removedEntries > 0) await this.saveIndex(index)
      return { removedEntries, removedBytes }
    })
  }
  async write(galleryId: string, entryId: string, plaintext: Uint8Array, guard?: VaultWriteGuard): Promise<void> {
    return this.serial(async () => {
      if (guard && this.isStale(guard.since)) throw new VaultStaleWriteError()
      // Size is known before encryption: reject before a key is minted, so a
      // rejected oversized write cannot strand an unreachable gallery key.
      if (HEADER_BYTES + NONCE_BYTES + plaintext.length + TAG_BYTES > this.capBytes) throw new VaultEntryTooLargeError()
      const loaded = await this.loadKey(galleryId, true); if (!loaded) throw new Error('Missing vault key')
      let index: Index | undefined
      let committed = false
      try {
        const record = await pack(loaded.key, galleryId, entryId, plaintext, this.crypto); if (record.length > this.capBytes) throw new VaultEntryTooLargeError()
        index = await this.loadIndex(); const id = entryKey(galleryId, entryId); const old = index.entries[id]
        const path = old ? this.replacementPath(galleryId, entryId) : entryPath(galleryId, entryId)
        const temporary = `${path}.tmp`
        await this.storage.write(temporary, record)
        try {
          if (this.storage.move) await this.storage.move(temporary, path)
          else { await this.storage.write(path, record); await this.storage.remove(temporary) }
        } catch (error) {
          await this.storage.remove(temporary)
          await this.storage.remove(path)
          throw error
        }
        const nextIndex = { ...index, entries: { ...index.entries, [id]: { galleryId, entryId, path, bytes: record.length, lastAccess: this.now() } } }
        await this.evict(nextIndex)
        try {
          await this.saveIndex(nextIndex)
        } catch (error) {
          await this.storage.remove(path)
          throw error
        }
        if (old && old.path !== path) await this.storage.remove(old.path)
        committed = true
      } finally {
        if (!committed && loaded.created && index && !Object.values(index.entries).some((entry) => entry.galleryId === galleryId)) {
          // Nothing committed and no earlier entries: a key minted here would
          // never be enumerable again (the keychain has no listing API).
          try { await this.removeGalleryKey(galleryId) } catch { /* The write failure is already being reported. */ }
        }
      }
    })
  }
  /**
   * `touch: false` keeps settings/catalog display from rewriting the index or
   * moving an entry up the LRU order.
   */
  async read(galleryId: string, entryId: string, options: { touch?: boolean } = {}): Promise<Uint8Array | undefined> {
    const touch = options.touch ?? true
    return this.serial(async () => {
      const index = await this.loadIndex(); const entry = index.entries[entryKey(galleryId, entryId)]; if (!entry) return undefined
      const record = await this.storage.read(entry.path); const key = await this.loadKey(galleryId, false)
      if (!record || !key) { await this.removeEntry(index, entry); await this.saveIndex(index); return undefined }
      try {
        const plaintext = await unpack(record, key.key, galleryId, entryId, this.crypto)
        if (touch) { entry.lastAccess = this.now(); await this.saveIndex(index) }
        return plaintext
      } catch { await this.removeEntry(index, entry); await this.saveIndex(index); return undefined }
    })
  }
  async remove(galleryId: string, entryId: string): Promise<void> { return this.serial(async () => { const index = await this.loadIndex(); const entry = index.entries[entryKey(galleryId, entryId)]; if (entry) await this.removeEntry(index, entry); await this.saveIndex(index) }) }
  /** Gallery IDs known to the vault: index entries plus identities decoded from on-disk files. */
  async listGalleryIds(): Promise<string[]> {
    return this.serial(async () => {
      const ids = new Set<string>()
      const index = await this.loadIndex()
      for (const entry of Object.values(index.entries)) ids.add(entry.galleryId)
      const files = await this.listFilesIfAvailable()
      for (const file of files ?? []) { const identity = vaultFilePathIdentity(file.path); if (identity.galleryId) ids.add(identity.galleryId) }
      return [...ids].sort()
    })
  }
  /**
   * Removes every file the gallery owns — indexed, orphaned and temporary —
   * and its vault key. Missing resources are success; anything that cannot be
   * verified raises `VaultDeletionError` instead of pretending the purge worked.
   */
  async clearGallery(galleryId: string): Promise<void> {
    return this.serial(async () => {
      this.bumpMutationEpoch()
      const failures: string[] = []
      const index = await this.loadIndex()
      const indexedPaths = new Set(Object.values(index.entries).filter((entry) => entry.galleryId === galleryId).map((entry) => entry.path))
      let targets: string[]
      try {
        const files = await this.listFiles()
        targets = files
          .filter((file) => file.path !== VAULT_INDEX_PATH && (vaultFilePathIdentity(file.path).galleryId === galleryId || indexedPaths.has(file.path)))
          .map((file) => file.path)
      } catch { targets = [...indexedPaths] }
      const targetSet = new Set(targets)
      for (const path of targets) {
        try { await this.storage.remove(path) } catch (error) { failures.push(`${path}: ${describeError(error)}`) }
      }
      if (this.storage.list) {
        try {
          const files = await this.listFiles()
          for (const file of files) if (targetSet.has(file.path)) failures.push(`${file.path}: still present after removal`)
        } catch (error) { failures.push(`post-purge file verification: ${describeError(error)}`) }
      }
      const nextEntries: Record<string, Entry> = {}
      for (const [key, entry] of Object.entries(index.entries)) if (entry.galleryId !== galleryId) nextEntries[key] = entry
      try { await this.saveIndex({ ...index, entries: nextEntries }) } catch (error) { failures.push(`index: ${describeError(error)}`) }
      try { await this.removeGalleryKey(galleryId) } catch (error) { failures.push(`key ${galleryId}: ${describeError(error)}`) }
      if (failures.length > 0) throw new VaultDeletionError(failures)
    })
  }
  /**
   * Cryptographic erasure of the whole vault: every file under the root and
   * every vault-owned gallery key. Session and billing credentials live under
   * other key names and are never enumerated or touched. This destroys keys
   * and deletes files — it does not overwrite flash blocks, and it cannot
   * erase immutable strings already held by the JavaScript runtime.
   */
  async clear(): Promise<void> {
    return this.serial(async () => {
      this.clearEpoch += 1
      this.mutationEpoch += 1
      const failures: string[] = []
      const index = await this.loadIndex()
      const galleryIds = new Set<string>(Object.values(index.entries).map((entry) => entry.galleryId))
      let files: VaultFileStat[] | undefined
      try {
        files = await this.listFiles()
        for (const file of files) {
          const identity = vaultFilePathIdentity(file.path)
          if (identity.galleryId) galleryIds.add(identity.galleryId)
        }
      } catch (error) {
        // Enumerated or not, the clear proceeds; the enumeration failure is
        // reported rather than silently narrowing what "everything" means.
        failures.push(`file enumeration: ${describeError(error)}`)
      }
      const targets = new Set<string>([VAULT_INDEX_PATH, `${VAULT_INDEX_PATH}.tmp`])
      for (const path of indexedPathsOf(index)) targets.add(path)
      for (const file of files ?? []) targets.add(file.path)
      for (const path of targets) {
        try { await this.storage.remove(path) } catch (error) { failures.push(`${path}: ${describeError(error)}`) }
      }
      if (files) {
        try {
          const remaining = new Set((await this.listFiles()).map((file) => file.path))
          for (const path of targets) if (remaining.has(path)) failures.push(`${path}: still present after removal`)
        } catch (error) { failures.push(`post-clear file verification: ${describeError(error)}`) }
      }
      for (const galleryId of galleryIds) {
        try { await this.removeGalleryKey(galleryId) } catch (error) { failures.push(`key ${galleryId}: ${describeError(error)}`) }
      }
      if (failures.length > 0) throw new VaultDeletionError(failures)
    })
  }
  /**
   * Filesystem truth: logical bytes on disk, split into entry/index/temp/orphan
   * overhead, plus per-gallery totals. Loads the index read-only — no LRU
   * updates, no index rewrites.
   */
  async usage(): Promise<VaultUsage> {
    return this.serial(async () => {
      const files = await this.listFiles()
      const index = await this.loadIndex()
      const byPath = new Map<string, Entry>()
      const galleries = new Map<string, VaultGalleryUsage>()
      const ensure = (galleryId: string): VaultGalleryUsage => {
        let gallery = galleries.get(galleryId)
        if (!gallery) { gallery = { galleryId, entries: 0, indexedBytes: 0, measuredBytes: 0 }; galleries.set(galleryId, gallery) }
        return gallery
      }
      let indexedBytes = 0
      for (const entry of Object.values(index.entries)) {
        byPath.set(entry.path, entry)
        indexedBytes += entry.bytes
        const gallery = ensure(entry.galleryId)
        gallery.entries += 1
        gallery.indexedBytes += entry.bytes
      }
      let measuredBytes = 0
      let entryBytes = 0
      let indexBytes = 0
      let tempBytes = 0
      let orphanBytes = 0
      for (const file of files) {
        measuredBytes += file.bytes
        if (file.path === VAULT_INDEX_PATH) { indexBytes += file.bytes; continue }
        if (isTemporaryPath(file.path)) {
          tempBytes += file.bytes
          // A half-written temp file still belongs to the gallery it names.
          const identity = vaultFilePathIdentity(file.path)
          if (identity.galleryId) ensure(identity.galleryId).measuredBytes += file.bytes
          continue
        }
        const owner = byPath.get(file.path)
        if (owner) {
          entryBytes += file.bytes
          ensure(owner.galleryId).measuredBytes += file.bytes
          continue
        }
        orphanBytes += file.bytes
        const identity = vaultFilePathIdentity(file.path)
        if (identity.galleryId) ensure(identity.galleryId).measuredBytes += file.bytes
      }
      return {
        measuredBytes,
        indexedBytes,
        entryBytes,
        indexBytes,
        tempBytes,
        orphanBytes,
        galleries: [...galleries.values()].sort((a, b) => (a.galleryId < b.galleryId ? -1 : 1)),
      }
    })
  }
}

const indexedPathsOf = (index: Index): string[] => Object.values(index.entries).map((entry) => entry.path)

export const createProductionVault = (options: Omit<VaultOptions, 'storage' | 'keys' | 'crypto'> = {}): EncryptedVault => new EncryptedVault(options)
export const productionVault = createProductionVault()
export const __private__ = { pack, unpack, entryPath, galleryKey, encodeId, decodeId, HEADER_BYTES, NONCE_BYTES, TAG_BYTES }
export type { Entry, Index }
