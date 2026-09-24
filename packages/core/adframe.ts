import type { GalleryMediaItem } from './imagesource'

export type AdFrame = {
  id: string
  advertiser: string
  headline?: string
  image?: { src: string; width: number; height: number }
  cta?: { label: string; url: string }
  badge: 'Ad' | 'Advertisement' | 'Sponsored'
  provider: 'admob-banner' | 'admob-native' | 'manorama-house'
}

export type RuntimeGalleryItem = GalleryMediaItem | AdFrame

export const isAdFrame = (item: RuntimeGalleryItem): item is AdFrame =>
  'provider' in item && (item.provider === 'admob-banner' || item.provider === 'admob-native' || item.provider === 'manorama-house')

/** Inserts one runtime-only plate without mutating the stored image sequence. */
export const composePlate = (
  images: readonly GalleryMediaItem[],
  adFrame: AdFrame | null | undefined,
): readonly RuntimeGalleryItem[] => {
  if (!adFrame || images.length < 8) return images
  const midpoint = Math.floor(images.length / 2)
  return [...images.slice(0, midpoint), adFrame, ...images.slice(midpoint)]
}

export const plateIndexFor = (photoCount: number): number | null =>
  photoCount >= 8 ? Math.floor(photoCount / 2) : null

export const AD_BANNER_WIDTH = 300
export const AD_BANNER_HEIGHT = 250
