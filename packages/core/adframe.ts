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

export const PLATE_CADENCE = 25
const PLATE_JITTER = 4

/** Plates land around every 25th photograph, jittered ±4 positions so the
 *  placement does not read as a metronome. The jitter is seeded, so a given
 *  seed key resolves to the same layout every time — re-rolls are per key,
 *  not per render. */
export const platePositionsFor = (photoCount: number, seedKey: string): readonly number[] => {
  const random = mulberry32(hashSeedKey(seedKey))
  const positions: number[] = []
  let pos = PLATE_CADENCE - PLATE_JITTER + Math.floor(random() * (PLATE_JITTER * 2 + 1))
  while (pos < photoCount - 1) {
    positions.push(pos)
    pos += PLATE_CADENCE - PLATE_JITTER + Math.floor(random() * (PLATE_JITTER * 2 + 1))
  }
  return positions
}

/** Inserts plates at the given photo indices without mutating the stored
 *  image sequence — a plate sits before the photograph at each position,
 *  never first, never last. */
export const composePlate = (
  images: readonly GalleryMediaItem[],
  adFrame: AdFrame | null | undefined,
  positions: readonly number[] = [],
): readonly RuntimeGalleryItem[] => {
  if (!adFrame || positions.length === 0) return images
  const composed: RuntimeGalleryItem[] = []
  const plateAt = new Set(positions.filter((pos) => pos > 0 && pos < images.length - 1))
  for (let index = 0; index < images.length; index += 1) {
    if (plateAt.has(index)) composed.push(adFrame)
    composed.push(images[index])
  }
  return composed
}

const hashSeedKey = (key: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export const AD_BANNER_WIDTH = 300
export const AD_BANNER_HEIGHT = 250
