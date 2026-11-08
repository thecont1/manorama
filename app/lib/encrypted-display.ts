import type { MediaReference } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore, type WebGalleryKeyStore } from './key-store'
import { EncryptedMediaResolver } from './encrypted-resolver'

const resolvers = new Map<string, Promise<EncryptedMediaResolver>>()

// Custody is shell-scoped: the web keeps keys in a session store, device
// shells inject their durable store at startup. A single store per shell
// keeps the resolver map keyed by gallery id alone.
let keyStoreForDisplay: () => WebGalleryKeyStore = webGalleryKeyStore

/** Point the display resolver at this shell's key custody (desktop calls
 *  it once at boot). Pass a factory — the store itself is cheap to build. */
export const configureEncryptedDisplayKeyStore = (store: () => WebGalleryKeyStore): void => {
  keyStoreForDisplay = store
}

const resolverFor = (galleryId: string): Promise<EncryptedMediaResolver> => {
  let pending = resolvers.get(galleryId)
  if (!pending) {
    pending = (async () => {
      const source = await keyStoreForDisplay().get(galleryId)
      if (!source) throw new Error('This tab does not hold the encrypted gallery key')
      const { openEncryptedSource } = await import('./encrypted-client')
      return new EncryptedMediaResolver(await openEncryptedSource(source))
    })()
    resolvers.set(galleryId, pending)
    // A rejected open must not poison the cache — the key may be stored or
    // a transient failure retried moments later. Only evict when the entry
    // still is this promise; a newer resolver may already have replaced it.
    pending.catch(() => {
      if (resolvers.get(galleryId) === pending) resolvers.delete(galleryId)
    })
  }
  return pending
}

export const acquireEncryptedDisplay = async (galleryId: string, reference: MediaReference, preview: boolean) => {
  const resolver = await resolverFor(galleryId)
  const url = await resolver.acquire(reference, preview)
  return { url, release: () => resolver.release(reference, preview) }
}

export const releaseEncryptedGallery = (galleryId: string): void => {
  const pending = resolvers.get(galleryId)
  resolvers.delete(galleryId)
  void pending?.then((resolver) => resolver.dispose()).catch(() => {})
}

export const releaseAllEncryptedDisplays = (): void => {
  for (const galleryId of [...resolvers.keys()]) releaseEncryptedGallery(galleryId)
}
