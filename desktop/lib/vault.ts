import { invoke } from '@tauri-apps/api/core'
import { EncryptedVault, webCryptoProvider, type VaultFileStat, type VaultKeyProvider, type VaultStorageProvider } from '../../native/lib/vault'

/** Ciphertext files live under the app's own Application Support directory.
 *  Rust resolves and validates every logical path — nothing the webview
 *  supplies can escape the vault root, and the fs capability keeps its
 *  read-only posture for everything else. Binary payloads travel as raw IPC
 *  bytes; nothing is re-encoded on the way. */
const tauriVaultStorage: VaultStorageProvider = {
  async read(path) {
    const bytes = await invoke<number[] | null>('vault_read', { path })
    return bytes === null ? null : new Uint8Array(bytes)
  },
  // Uint8Array JSON-serializes as an object, not an array — the Rust
  // Vec<u8> arg needs a plain number array or the call rejects.
  write: (path, bytes) => invoke<void>('vault_write', { path, bytes: Array.from(bytes) }),
  move: (from, to) => invoke<void>('vault_move', { from, to }),
  remove: (path) => invoke<void>('vault_remove', { path }),
  list: async () => (await invoke<VaultFileStat[] | null>('vault_list')) ?? [],
}

/** Per-gallery AES-256 keys live in the login Keychain, written and read only
 *  through Rust — ciphertext without them is dead bytes, which is what keeps
 *  the vault viewable solely inside this app. */
const keychainVaultKeys: VaultKeyProvider = {
  get: (name) => invoke<string | null>('vault_key_get', { name }),
  set: (name, value) => invoke<void>('vault_key_set', { name, value }),
  remove: (name) => invoke<void>('vault_key_remove', { name }),
}

/** The desktop's encrypted media vault — same record format and crypto as
 *  the iOS one, so the behaviours (LRU cap, crypto-erasure, verified purge)
 *  are shared, not re-implemented. */
export const desktopVault = new EncryptedVault({
  storage: tauriVaultStorage,
  keys: keychainVaultKeys,
  crypto: webCryptoProvider,
})
