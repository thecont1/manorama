import type { MediaReference } from '../../packages/core/encrypted-source'
import { webGalleryKeyStore } from './key-store'
import { EncryptedMediaResolver } from './encrypted-resolver'

const resolvers = new Map<string, Promise<EncryptedMediaResolver>>()

const resolverFor = (galleryId: string): Promise<EncryptedMediaResolver> => {
  let pending = resolvers.get(galleryId)
  if (!pending) {
    pending = (async () => {
      const source = await webGalleryKeyStore().get(galleryId)
      if (!source) throw new Error('This tab does not hold the encrypted gallery key')
      const { openEncryptedSource } = await import('./encrypted-client')
      return new EncryptedMediaResolver(await openEncryptedSource(source))
    })()
    resolvers.set(galleryId, pending)
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
