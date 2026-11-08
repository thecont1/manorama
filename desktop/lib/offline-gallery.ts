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
 *  localStorage key store. The fragment/identity guard is identical — a link
 *  naming a different album is never adopted into the gallery's custody. */
export const openDesktopEncryptedSession = async (
  selection: GallerySelection,
  compareWith?: string,
): Promise<EncryptedClientSession> => {
  const sourceUrl = selection.sourceUrl ?? (selection.galleryId ? await desktopKeyStore().get(selection.galleryId) : null)
  if (!sourceUrl) throw new EncryptedSourceLockedError()
  if (compareWith !== undefined && keylessSourceUrl(sourceUrl) !== keylessSourceUrl(compareWith)) {
    throw new EncryptedSourceMismatchError()
  }
  const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
  const session = await openEncryptedSource(sourceUrl)
  if (selection.sourceUrl && selection.galleryId) {
    await desktopKeyStore().put(selection.galleryId, selection.sourceUrl).catch(() => undefined)
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
