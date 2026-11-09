import { invoke } from '@tauri-apps/api/core'
import { WebGalleryKeyStore } from '../../app/lib/key-store'
import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl } from '../../packages/core/encrypted-source'

/** What every custody caller on the desktop actually uses. */
export type GalleryKeyCustody = Pick<WebGalleryKeyStore, 'get' | 'put' | 'remove'>

/** The account names mirror the old localStorage keys so a dump of the
 *  keychain reads identically to the storage it replaces. */
const PREFIX = 'manorama.gallery-key.v1.'

const normalizeSource = (value: string | null): string | null => {
  if (!value) return null
  try {
    return encryptedSourceFromGalleryHash(galleryHashForSource(value))
  } catch {
    return null
  }
}

/** Custody the whole Mac shares: the login Keychain, reached through the
 *  same `vault_key_*` bridge the encrypted-copy vault already uses, so a
 *  key adopted in one shell unlocks the gallery in the other — "the key
 *  is not on this Mac" can finally mean it. Custody used to live in
 *  localStorage, which is per-webview: keys adopted under the Tauri
 *  shell were invisible to the SwiftUI one. The first read of a legacy
 *  entry moves it into the Keychain and drops the copy. When the bridge
 *  is unreachable (plain browser, tests without a stub) the store
 *  degrades to the localStorage behaviour it replaces. */
class KeychainGalleryKeyStore implements GalleryKeyCustody {
  private readonly legacy = () => new WebGalleryKeyStore(localStorage)

  async get(galleryId: string): Promise<string | null> {
    const name = `${PREFIX}${galleryId}`
    let bridge = true
    const stored = await invoke<string | null>('vault_key_get', { name })
      .then((value) => value ?? null)
      .catch(() => { bridge = false; return null })
    const normalized = normalizeSource(stored)
    if (normalized) return normalized
    const legacy = await this.legacy().get(galleryId)
    if (legacy && bridge) {
      // One-way migration: custody moves to the shared Keychain on first
      // touch so the other shell sees it without a re-adopt.
      void invoke('vault_key_set', { name, value: legacy })
        .then(() => localStorage.removeItem(name))
        .catch(() => {})
    }
    return legacy
  }

  async put(galleryId: string, sourceUrl: string): Promise<void> {
    // Same admission rule as the web store — the fragment is the key, so
    // only a complete link earns custody.
    if (!/^[0-9A-Za-z-]{16,64}$/.test(galleryId)) throw new Error('Gallery id is invalid')
    const parsed = new URL(sourceUrl)
    if (!isEncryptedSourceUrl(sourceUrl) || !encryptedSourceFromGalleryHash(galleryHashForSource(sourceUrl)) || !parsed.hash) {
      throw new Error('A complete encrypted source link is required')
    }
    const name = `${PREFIX}${galleryId}`
    try {
      await invoke('vault_key_set', { name, value: sourceUrl })
      localStorage.removeItem(name)
    } catch {
      await this.legacy().put(galleryId, sourceUrl)
    }
  }

  async remove(galleryId: string): Promise<void> {
    const name = `${PREFIX}${galleryId}`
    await invoke('vault_key_remove', { name }).catch(() => {})
    localStorage.removeItem(name)
  }
}

/** Encrypted-gallery key custody on the desktop: durable and shared
 *  between shells — an app is not a tab, and a Mac is not a webview. */
export const desktopKeyStore = (): GalleryKeyCustody => new KeychainGalleryKeyStore()
