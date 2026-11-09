import { invoke } from '@tauri-apps/api/core'
import { EncryptedVault, webCryptoProvider, type VaultFileStat, type VaultKeyProvider, type VaultStorageProvider } from '../../native/lib/vault'

/** Ciphertext files live under the app's own Application Support directory.
 *  Rust resolves and validates every logical path — nothing the webview
 *  supplies can escape the vault root, and the fs capability keeps its
 *  read-only posture for everything else. Binary payloads travel as raw IPC
 *  bytes; nothing is re-encoded on the way. */
const tauriVaultStorage: VaultStorageProvider = {
  async read(path) {
    // The Rust side answers raw IPC bytes — an empty body (or a test
    // double's null) means absent.
    const buffer = await invoke<ArrayBuffer | null>('vault_read', { path })
    return !buffer || buffer.byteLength === 0 ? null : new Uint8Array(buffer)
  },
  // Multi-megabyte records travel as the raw request body — a JSON number
  // array would carry each byte four times over. The path rides as request
  // metadata so the body stays pure ciphertext.
  write: (path, bytes) => invoke<void>('vault_write', bytes, { headers: { 'x-vault-path': path } }),
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

/** Diagnostics are strictly opt-in: the debug file records gallery and entry
 *  identities, so it exists only while a user (or support) has it enabled to
 *  chase a failing sync — and a vault clear sweeps it with the records. */
const VAULT_DIAGNOSTICS_KEY = 'manorama.vault.diagnostics'
/** Whether vault diagnostics are on — read per event so toggling the flag
 *  in the webview's storage takes effect without a reload. */
const diagnosticsEnabled = (): boolean => {
  try { return localStorage.getItem(VAULT_DIAGNOSTICS_KEY) === '1' } catch { return false }
}

/** The desktop's encrypted media vault — same record format and crypto as
 *  the iOS one, so the behaviours (LRU cap, crypto-erasure, verified purge)
 *  are shared, not re-implemented. */
export const desktopVault = new EncryptedVault({
  storage: tauriVaultStorage,
  keys: keychainVaultKeys,
  crypto: webCryptoProvider,
  // Diagnostics ride the debug file, not the JS console — the renderer's
  // serialized internals report which leg of a read/write actually failed.
  diagnose: (event, detail) => {
    if (!diagnosticsEnabled()) return
    void invoke<void>('vault_log', { line: `${event}${detail ? ` ${detail}` : ''}` }).catch(() => {})
  },
})
