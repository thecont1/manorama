/** Local base64url helpers — app/lib files must not import the client
 *  decryptor family (mega-crypto) per the architecture guard, and the vault
 *  needs nothing from it but these six lines. */
const b64uEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uDecode = (input: string) => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Zero-knowledge gallery-key escrow. An owner's encrypted galleries unlock
 * on any signed-in device without moving plaintext keys: a random per-account
 * vault key (VK) wraps each gallery's complete source link, and the VK itself
 * is wrapped by a key derived from the owner's sync passphrase. The API moves
 * ciphertext only — the passphrase, the VK, and source links never leave the
 * client's own crypto context, so a server-side reader holds undecryptable
 * blobs gated by a memory-hard KDF. */

const PBKDF2_ITERATIONS = 600_000
const KEY_LENGTH = 256
const VAULT_SESSION_SLOT = 'manorama.vault-key.v1'

export type OwnerVaultRecord = {
  version: 1
  /** Base64url 16-byte PBKDF2 salt. */
  kdfSalt: string
  kdfIterations: number
  /** AES-GCM wrap of the vault key under the passphrase-derived KEK. */
  wrappedVk: string
  vkNonce: string
}
export type WrappedGalleryKey = { wrappedSource: string; nonce: string }

const subtle = () => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('This browser cannot protect gallery keys')
  return subtle
}

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length))

const deriveKek = (passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> =>
  subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
    .then((material) => subtle().deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['wrapKey', 'unwrapKey'],
    ))

const generateVaultKey = (): Promise<CryptoKey> =>
  subtle().generateKey({ name: 'AES-GCM', length: KEY_LENGTH }, true, ['encrypt', 'decrypt'])

/** First-device setup: a fresh VK wrapped under a fresh passphrase-derived
 *  KEK. The record is safe to hand to the server — nothing in it decrypts
 *  without the passphrase. */
export const createVault = async (passphrase: string): Promise<{ vaultKey: CryptoKey; record: OwnerVaultRecord }> => {
  const vaultKey = await generateVaultKey()
  const kdfSalt = randomBytes(16)
  const kek = await deriveKek(passphrase, kdfSalt, PBKDF2_ITERATIONS)
  const vkNonce = randomBytes(12)
  const wrapped = await subtle().wrapKey('raw', vaultKey, kek, { name: 'AES-GCM', iv: vkNonce as BufferSource })
  return {
    vaultKey,
    record: {
      version: 1,
      kdfSalt: b64uEncode(kdfSalt),
      kdfIterations: PBKDF2_ITERATIONS,
      wrappedVk: b64uEncode(new Uint8Array(wrapped)),
      vkNonce: b64uEncode(vkNonce),
    },
  }
}

/** Rejects with a WebCrypto error on a wrong passphrase — GCM's auth tag is
 *  the verification, no separate password hash is stored. */
export const openVault = async (passphrase: string, record: OwnerVaultRecord): Promise<CryptoKey> => {
  const kek = await deriveKek(passphrase, b64uDecode(record.kdfSalt), record.kdfIterations)
  return subtle().unwrapKey(
    'raw', b64uDecode(record.wrappedVk) as BufferSource, kek,
    { name: 'AES-GCM', iv: b64uDecode(record.vkNonce) as BufferSource },
    { name: 'AES-GCM', length: KEY_LENGTH }, true, ['encrypt', 'decrypt'],
  )
}

/** The gallery identity wrapped into every new escrow as AES-GCM
 *  additional data: a record copied to a different gallery's row can no
 *  longer authenticate there. */
const aadFor = (galleryId: string) => new TextEncoder().encode(`manorama:gallery:${galleryId}`)

export const wrapSourceForVault = async (
  vaultKey: CryptoKey,
  sourceUrl: string,
  galleryId?: string,
): Promise<WrappedGalleryKey> => {
  const nonce = randomBytes(12)
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, ...(galleryId ? { additionalData: aadFor(galleryId) } : {}) },
    vaultKey, new TextEncoder().encode(sourceUrl),
  )
  return { wrappedSource: b64uEncode(new Uint8Array(data)), nonce: b64uEncode(nonce) }
}

export const unwrapSourceForVault = async (
  vaultKey: CryptoKey,
  wrapped: WrappedGalleryKey,
  galleryId?: string,
): Promise<string> => {
  if (galleryId) {
    // New records bind the gallery in the GCM tag — a row swapped to the
    // wrong gallery fails right here instead of answering a wrong source.
    try {
      const bound = await subtle().decrypt(
        { name: 'AES-GCM', iv: b64uDecode(wrapped.nonce) as BufferSource, additionalData: aadFor(galleryId) },
        vaultKey, b64uDecode(wrapped.wrappedSource) as BufferSource,
      )
      return new TextDecoder().decode(bound)
    } catch {
      // Pre-AAD records still open unauthenticated; the caller's
      // source-album comparison is the backstop for those.
    }
  }
  const data = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64uDecode(wrapped.nonce) as BufferSource },
    vaultKey, b64uDecode(wrapped.wrappedSource) as BufferSource,
  )
  return new TextDecoder().decode(data)
}

/** The VK sits in sessionStorage like the gallery keys themselves — same
 *  tab-scoped custody, so a new tab asks for the passphrase once and then
 *  unlocks every synced gallery for the rest of that session. */
export const cachedVaultKey = async (): Promise<CryptoKey | null> => {
  try {
    const raw = sessionStorage.getItem(VAULT_SESSION_SLOT)
    if (!raw) return null
    return await subtle().importKey('raw', b64uDecode(raw) as BufferSource, { name: 'AES-GCM', length: KEY_LENGTH }, true, ['encrypt', 'decrypt'])
  } catch {
    return null
  }
}

export const cacheVaultKey = async (vaultKey: CryptoKey): Promise<void> => {
  try {
    const raw = await subtle().exportKey('raw', vaultKey)
    sessionStorage.setItem(VAULT_SESSION_SLOT, b64uEncode(new Uint8Array(raw)))
  } catch {
    // Quota or private-mode failure only means the passphrase is asked again.
  }
}

// --- API glue: ciphertext and KDF parameters only, never plaintext. ---

/** A stored vault plus the updatedAt token the next write must present —
 *  the server's compare-and-swap turns a second "create" into a conflict
 *  the caller resolves by adopting the surviving record. */
export type VaultRecordRead = { record: OwnerVaultRecord; updatedAt: string }
export type GalleryKeyRead = { wrapped: WrappedGalleryKey; updatedAt: string }
export type PutOutcome = 'stored' | 'conflict'

const vaultReadFrom = (vault: (OwnerVaultRecord & { updatedAt?: unknown }) | null | undefined): VaultRecordRead => {
  if (!vault || vault.version !== 1
    || typeof vault.kdfSalt !== 'string' || typeof vault.kdfIterations !== 'number'
    || typeof vault.wrappedVk !== 'string' || typeof vault.vkNonce !== 'string'
    || typeof vault.updatedAt !== 'string') {
    throw new Error('The key vault response was not valid')
  }
  const { updatedAt, ...record } = vault
  return { record, updatedAt }
}

export const fetchVaultRecord = async (): Promise<VaultRecordRead | null> => {
  const response = await fetch('/api/account/key-vault')
  if (!response.ok) throw new Error('The key vault could not be read')
  const payload = await response.json() as { vault?: (OwnerVaultRecord & { updatedAt?: unknown }) | null }
  // An explicit null is "no vault" — anything else malformed is an error,
  // since ensureVaultKey would treat a misread record as license to create
  // a fresh vault and orphan every previously synced key.
  if (payload.vault === null) return null
  return vaultReadFrom(payload.vault)
}

export const putVaultRecord = async (
  record: OwnerVaultRecord,
  expectedUpdatedAt: string | null,
): Promise<'stored' | { conflict: VaultRecordRead | null }> => {
  const response = await fetch('/api/account/key-vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...record, expectedUpdatedAt }),
  })
  if (response.status === 409) {
    // The 409 carries the surviving record — adopt it without a second
    // round-trip that could race a third writer.
    const payload = await response.json() as { vault?: (OwnerVaultRecord & { updatedAt?: unknown }) | null }
    return { conflict: payload.vault ? vaultReadFrom(payload.vault) : null }
  }
  if (!response.ok) throw new Error('The key vault could not be saved')
  return 'stored'
}

/** Read the escrowed key for a gallery. `null` means the read succeeded
 *  and nothing is stored — a non-OK response is a failed read and throws,
 *  so callers can never mistake 'unavailable' for 'not escrowed'. */
export const fetchGalleryKey = async (slug: string): Promise<GalleryKeyRead | null> => {
  const response = await fetch(`/api/galleries/${encodeURIComponent(slug)}/key`)
  if (!response.ok) throw new Error('The gallery key could not be read')
  const payload = await response.json() as { key?: (WrappedGalleryKey & { updatedAt?: unknown }) | null }
  if (!payload.key) return null
  const { wrappedSource, nonce, updatedAt } = payload.key
  if (typeof wrappedSource !== 'string' || typeof nonce !== 'string' || typeof updatedAt !== 'string') {
    throw new Error('The gallery key response was not valid')
  }
  return { wrapped: { wrappedSource, nonce }, updatedAt }
}

export const putGalleryKey = async (slug: string, wrapped: WrappedGalleryKey, expectedUpdatedAt: string | null): Promise<PutOutcome> => {
  const response = await fetch(`/api/galleries/${encodeURIComponent(slug)}/key`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...wrapped, expectedUpdatedAt }),
  })
  if (response.status === 409) return 'conflict'
  if (!response.ok) throw new Error('The gallery key could not be synced')
  return 'stored'
}

/** One passphrase entry unlocks or creates the vault and leaves the VK
 *  session-cached — the only call the gate and the sync card need. A
 *  create race resolves by adopting the surviving record: the winner's
 *  wrapped keys then unwrap on every device. */
export const ensureVaultKey = async (passphrase: string): Promise<CryptoKey> => {
  const current = await fetchVaultRecord()
  if (current) {
    const vaultKey = await openVault(passphrase, current.record)
    await cacheVaultKey(vaultKey)
    return vaultKey
  }
  const created = await createVault(passphrase)
  const outcome = await putVaultRecord(created.record, null)
  if (outcome !== 'stored') {
    // Another device minted a vault between our read and write — adopt
    // the survivor instead of overwriting it. The passphrase still has
    // to open it: a record that rejects this device surfaces the failure
    // rather than silently orphaning keys under a third vault.
    const winner = outcome.conflict ?? await fetchVaultRecord()
    if (!winner) throw new Error('The key vault could not be read')
    const vaultKey = await openVault(passphrase, winner.record)
    await cacheVaultKey(vaultKey)
    return vaultKey
  }
  await cacheVaultKey(created.vaultKey)
  return created.vaultKey
}

/** Whether the passphrase card should surface for a gallery at all. The
 *  card exists to escrow a key this device holds — with no vault it asks
 *  for account setup mid-gallery (too big an ask to interrupt for), with
 *  the key already wrapped it has nothing to do, and a dismissal is the
 *  owner saying the deferred convenience is not worth a prompt. In every
 *  other state it still asks, since the key may never be held here again. */
export const keySyncShouldPrompt = (input: { vaultExists: boolean; alreadyEscrowed: boolean; dismissed: boolean }): boolean =>
  input.vaultExists && !input.alreadyEscrowed && !input.dismissed
