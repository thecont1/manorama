import { createGalleryFromManifest, refreshGalleryWithManifest, type KeylessManifest } from './api'
import { nativeGalleryKeyStore } from './gallery-key-store'
import type { EncryptedClientSession } from '../../app/lib/encrypted-resolver'

/**
 * Native orchestration for encrypted sources (MEGA now; Ente later). The
 * client scans and decrypts on-device using the pure client modules
 * (`openEncryptedSource`), the keyed source URL is persisted only in the
 * platform key store, and server requests carry only keyless manifests.
 *
 * The key store is keyed by the immutable server gallery id. Deleting a
 * gallery removes its key, so a reused slug can never inherit a previous key.
 */

export class EncryptedSourceLockedError extends Error {
  constructor() {
    super('This gallery is encrypted and this device has no key for it. Open it from the shared link again.')
    this.name = 'EncryptedSourceLockedError'
  }
}

export class EncryptedSourceMismatchError extends Error {
  constructor() {
    super('That link opens a different encrypted source than this gallery expects.')
    this.name = 'EncryptedSourceMismatchError'
  }
}

const keyStore = () => nativeGalleryKeyStore()

export const persistEncryptedSourceForSelection = async (galleryId: string, sourceUrl: string): Promise<void> => {
  await keyStore().put(galleryId, sourceUrl)
}

export const resolveEncryptedSourceForSelection = async (galleryId: string): Promise<string | null> => {
  return keyStore().get(galleryId)
}

export const removeEncryptedSourceForSelection = async (galleryId: string): Promise<void> => {
  await keyStore().remove(galleryId)
}

export const clearAllEncryptedSources = async (): Promise<void> => {
  await keyStore().purgeAll()
}

const manifestOf = (session: EncryptedClientSession): KeylessManifest => ({
  provider: session.provider,
  sourceUrl: session.sourceUrl,
  title: session.title,
  images: session.images,
  ...(session.truncated !== undefined ? { truncated: session.truncated } : {}),
})

/** Client scan + keyless create. The key is persisted only after the server
 * returns the gallery address, under that gallery's immutable offline id. */
export const createEncryptedGallery = async (
  apiBase: string,
  sourceUrl: string,
  options: { quick?: boolean; title?: string; caption?: string } = {},
): Promise<{ owner: string; slug: string; galleryId: string }> => {
  const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
  const session = await openEncryptedSource(sourceUrl)
  try {
    const next = await createGalleryFromManifest(apiBase, manifestOf(session), options)
    await persistEncryptedSourceForSelection(next.galleryId, sourceUrl)
    return next
  } finally {
    session.dispose()
  }
}

/** Client-driven refresh (D3): re-scan from the stored key, submit the
 * keyless manifest. Without a stored key this raises a locked error — the
 * server can never refresh an encrypted gallery on its own. */
export const refreshEncryptedGallery = async (apiBase: string, slug: string, galleryId: string): Promise<void> => {
  const sourceUrl = await resolveEncryptedSourceForSelection(galleryId)
  if (!sourceUrl) throw new EncryptedSourceLockedError()
  const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
  const session = await openEncryptedSource(sourceUrl)
  try {
    await refreshGalleryWithManifest(apiBase, slug, manifestOf(session))
  } finally {
    session.dispose()
  }
}
