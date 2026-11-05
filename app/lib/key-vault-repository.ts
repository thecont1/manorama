import type { D1Database } from '@cloudflare/workers-types'

/** Gallery-key escrow storage. Every field here is ciphertext or KDF
 *  parameters written by the client — the server stores blobs it cannot
 *  read, so no plaintext key, passphrase, or vault key may ever appear in
 *  these rows. The vault row is per-account; gallery rows hang off the
 *  immutable gallery id that the client's key store already uses.
 *
 *  D1 is the production store; vite dev and tests use the in-memory maps. */

export type KeyVaultEnv = { DB?: D1Database }

export type StoredOwnerVault = {
  kdfSalt: string
  kdfIterations: number
  wrappedVk: string
  vkNonce: string
  version: number
  updatedAt: string
}
export type StoredGalleryKey = { galleryId: string; wrappedSource: string; nonce: string; updatedAt: string }

const d1Configured = (env?: KeyVaultEnv): env is KeyVaultEnv & { DB: D1Database } =>
  Boolean(env?.DB)

const runtimeVaults = new Map<string, StoredOwnerVault>()
const runtimeKeys = new Map<string, StoredGalleryKey>()
const runtimeKeyId = (ownerId: string, galleryId: string) => `${ownerId}${galleryId}`

type VaultRow = {
  kdf_salt: string
  kdf_iterations: number
  wrapped_vk: string
  vk_nonce: string
  version: number
  updated_at: string
}

const rowToVault = (row: VaultRow | null): StoredOwnerVault | null =>
  row ? {
    kdfSalt: row.kdf_salt,
    kdfIterations: row.kdf_iterations,
    wrappedVk: row.wrapped_vk,
    vkNonce: row.vk_nonce,
    version: row.version,
    updatedAt: row.updated_at,
  } : null

export const getOwnerVault = async (ownerId: string, env?: KeyVaultEnv): Promise<StoredOwnerVault | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT kdf_salt, kdf_iterations, wrapped_vk, vk_nonce, version, updated_at FROM owner_key_vault WHERE owner_id = ?')
      .bind(ownerId)
      .first<VaultRow>()
    return rowToVault(row)
  }
  return runtimeVaults.get(ownerId) ?? null
}

export const putOwnerVault = async (ownerId: string, vault: Omit<StoredOwnerVault, 'updatedAt'>, env?: KeyVaultEnv): Promise<StoredOwnerVault> => {
  const stored: StoredOwnerVault = { ...vault, updatedAt: new Date().toISOString() }
  if (d1Configured(env)) {
    await env.DB
      .prepare(`INSERT INTO owner_key_vault (owner_id, kdf_salt, kdf_iterations, wrapped_vk, vk_nonce, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id) DO UPDATE SET kdf_salt = excluded.kdf_salt, kdf_iterations = excluded.kdf_iterations,
          wrapped_vk = excluded.wrapped_vk, vk_nonce = excluded.vk_nonce, version = excluded.version, updated_at = excluded.updated_at`)
      .bind(ownerId, stored.kdfSalt, stored.kdfIterations, stored.wrappedVk, stored.vkNonce, stored.version, stored.updatedAt)
      .run()
    return stored
  }
  runtimeVaults.set(ownerId, stored)
  return stored
}

export const getGalleryKey = async (ownerId: string, galleryId: string, env?: KeyVaultEnv): Promise<StoredGalleryKey | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT gallery_id, wrapped_source, nonce, updated_at FROM gallery_keys WHERE owner_id = ? AND gallery_id = ?')
      .bind(ownerId, galleryId)
      .first<{ gallery_id: string; wrapped_source: string; nonce: string; updated_at: string }>()
    return row ? { galleryId: row.gallery_id, wrappedSource: row.wrapped_source, nonce: row.nonce, updatedAt: row.updated_at } : null
  }
  return runtimeKeys.get(runtimeKeyId(ownerId, galleryId)) ?? null
}

export const putGalleryKey = async (ownerId: string, galleryId: string, key: { wrappedSource: string; nonce: string }, env?: KeyVaultEnv): Promise<StoredGalleryKey> => {
  const stored: StoredGalleryKey = { galleryId, ...key, updatedAt: new Date().toISOString() }
  if (d1Configured(env)) {
    await env.DB
      .prepare(`INSERT INTO gallery_keys (owner_id, gallery_id, wrapped_source, nonce, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, gallery_id) DO UPDATE SET wrapped_source = excluded.wrapped_source,
          nonce = excluded.nonce, updated_at = excluded.updated_at`)
      .bind(ownerId, stored.galleryId, stored.wrappedSource, stored.nonce, stored.updatedAt)
      .run()
    return stored
  }
  runtimeKeys.set(runtimeKeyId(ownerId, galleryId), stored)
  return stored
}

/** Account deletion sweeps the whole vault — every wrapped key and the
 *  vault record itself. Ciphertext is still data about the owner. */
export const dropOwnerKeyVault = async (ownerId: string, env?: KeyVaultEnv): Promise<void> => {
  if (d1Configured(env)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM gallery_keys WHERE owner_id = ?').bind(ownerId),
      env.DB.prepare('DELETE FROM owner_key_vault WHERE owner_id = ?').bind(ownerId),
    ])
    return
  }
  runtimeVaults.delete(ownerId)
  for (const key of [...runtimeKeys.keys()]) if (key.startsWith(`${ownerId}`)) runtimeKeys.delete(key)
}

/** A deleted gallery's wrapped key is dead weight — ciphertext nobody can
 *  open for a row that no longer exists. */
export const deleteGalleryKey = async (ownerId: string, galleryId: string, env?: KeyVaultEnv): Promise<void> => {
  if (d1Configured(env)) {
    await env.DB
      .prepare('DELETE FROM gallery_keys WHERE owner_id = ? AND gallery_id = ?')
      .bind(ownerId, galleryId)
      .run()
    return
  }
  runtimeKeys.delete(runtimeKeyId(ownerId, galleryId))
}
