import manifest from './gallery-manifest'
import type { GalleryManifest } from './imagesource'

export type AvailableGallery = Pick<GalleryManifest, 'slug' | 'title' | 'caption' | 'date'> & {
  imageCount: number
}

/**
 * v1 registry. Future gallery creation/import code can append entries here or
 * replace this static source with a persistent GalleryRegistry adapter without
 * changing the root admin's selector contract.
 */
export const availableGalleries: readonly AvailableGallery[] = [
  {
    slug: manifest.slug,
    title: manifest.title,
    caption: manifest.caption,
    date: manifest.date,
    imageCount: manifest.images.length,
  },
]
