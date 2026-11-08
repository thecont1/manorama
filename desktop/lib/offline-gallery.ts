import type { EncryptedClientSession } from '../../app/lib/encrypted-resolver'
import { EncryptedSourceLockedError, EncryptedSourceMismatchError } from '../../native/lib/encrypted-gallery'
import { EncryptedOfflineGalleryStore, type GallerySelection } from '../../native/lib/offline-gallery'
import { createVaultSettingsController, type VaultCapPersistence } from '../../native/lib/vault-settings'
import { keylessSourceUrl } from '../../packages/core/encrypted-source'
import { desktopKeyStore } from './key-store'
import { desktopVault } from './vault'

/** Non-secret vault preferences (cap choice, load policy, stream-only flags)
 *  live in ordinary localStorage — never in the vault, never on the server. */
export const desktopVaultPersistence: VaultCapPersistence = {
  get: async (key) => localStorage.getItem(key),
  set: async (key, value) => {
    localStorage.setItem(key, value)
  },
}

/** Mirrors `openNativeEncryptedSession` but reads custody from this device's
 *  localStorage key store. Custody order matters: the Mac's stored key is
 *  checked FIRST — a gallery's stored sourceUrl is keyless by design, so it
 *  can only identify which key to open, never supply the secret itself.
 *  The fragment/identity guard is identical — a link naming a different
 *  album is never adopted into the gallery's custody. */
export const openDesktopEncryptedSession = async (
  selection: GallerySelection,
  compareWith?: string,
): Promise<EncryptedClientSession> => {
  let sourceUrl: string | null = null
  if (selection.galleryId) {
    sourceUrl = await desktopKeyStore().get(selection.galleryId).catch(() => null)
  }
  if (!sourceUrl && selection.sourceUrl) {
    // Only a link that still carries its secret fragment can stand in —
    // a keyless identity without custody means the unlock form, not a guess.
    const hasSecret = (() => { try { return Boolean(new URL(selection.sourceUrl!).hash) } catch { return false } })()
    if (hasSecret) sourceUrl = selection.sourceUrl
  }
  if (!sourceUrl) throw new EncryptedSourceLockedError()
  if (compareWith !== undefined && keylessSourceUrl(sourceUrl) !== keylessSourceUrl(compareWith)) {
    throw new EncryptedSourceMismatchError()
  }
  const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
  const session = await openEncryptedSource(sourceUrl)
  // Adopt custody: a link that arrived WITH the secret gets stored under the
  // gallery id so the next open — and the thumbnail resolver — never ask again.
  if (selection.galleryId && selection.sourceUrl === sourceUrl) {
    await desktopKeyStore().put(selection.galleryId, sourceUrl).catch(() => undefined)
  }
  return session
}

/** The desktop's offline gallery store — the shared iOS implementation
 *  driven by the Tauri vault and this device's key custody. */
export const desktopOfflineStore = new EncryptedOfflineGalleryStore({
  vault: desktopVault,
  openEncryptedSession: openDesktopEncryptedSession,
})

/** Vault settings bound to the live account tier at call time — a tier
 *  change on the web takes effect without relaunching. */
export const createDesktopVaultSettings = (tier: () => 'free' | 'pro' | undefined) =>
  createVaultSettingsController({
    vault: desktopVault,
    store: desktopOfflineStore,
    tier,
    persistence: desktopVaultPersistence,
  })
