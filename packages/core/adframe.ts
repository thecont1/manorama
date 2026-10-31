import type { GalleryMediaItem } from './imagesource'

export type AdFrame = {
  id: string
  advertiser: string
  headline?: string
  image?: { src: string; width: number; height: number }
  cta?: { label: string; url: string }
  badge: 'Ad' | 'Advertisement' | 'Sponsored'
  provider: 'admob-banner' | 'admob-native' | 'manorama-house' | 'web-network'
}

export type RuntimeGalleryItem = GalleryMediaItem | AdFrame

export const isAdFrame = (item: RuntimeGalleryItem): item is AdFrame =>
  'provider' in item && (
    item.provider === 'admob-banner' ||
    item.provider === 'admob-native' ||
    item.provider === 'manorama-house' ||
    item.provider === 'web-network'
  )

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

/** The interim single-plate placement while dummy house creatives stand in
 *  for AdMob: exactly one plate per gallery at a seeded interior position —
 *  never first, never last, re-rolled per seed key like the cadence. A
 *  gallery under three photographs has no interior slot and stays clean.
 *  Returns a readonly array so callers can swap policies with one line. */
export const singlePlatePositionsFor = (photoCount: number, seedKey: string): readonly number[] => {
  if (photoCount < 3) return []
  const random = mulberry32(hashSeedKey(seedKey))
  return [1 + Math.floor(random() * (photoCount - 2))]
}

export type AdCreative = { src: string; width: number; height: number }

/** Owner-supplied stand-in creatives, served from /ads on every surface
 *  (web bundle, Capacitor webDir, desktop publicDir share the one folder).
 *  All verticals — the plate is a portrait slot. */
export const HOUSE_AD_CREATIVES: readonly AdCreative[] = [
  { src: '/ads/house-1.jpg', width: 329, height: 512 },
  { src: '/ads/house-2.jpg', width: 411, height: 512 },
  { src: '/ads/house-3.jpg', width: 335, height: 512 },
  { src: '/ads/house-4.jpg', width: 317, height: 512 },
]

export const houseAdCreativeFor = (seedKey: string): AdCreative =>
  HOUSE_AD_CREATIVES[Math.floor(mulberry32(hashSeedKey(seedKey))() * HOUSE_AD_CREATIVES.length)]

export const HOUSE_AD_FRAME: AdFrame = {
  id: 'manorama-house-plate',
  advertiser: 'manorama',
  headline: 'More photographs, quietly shared.',
  image: HOUSE_AD_CREATIVES[0],
  cta: { label: 'Explore manorama', url: 'https://manorama.xyz' },
  badge: 'Sponsored',
  provider: 'manorama-house',
}

/** The house frame carrying a seeded creative. `scope` is the surface the
 *  plate belongs to (gallery slug, 'library'); the UTC day is folded in so
 *  the creative re-rolls on the same boundary as the placement. */
export const houseAdFrameFor = (
  scope: string,
  day = new Date().toISOString().slice(0, 10),
): AdFrame => ({
  ...HOUSE_AD_FRAME,
  image: houseAdCreativeFor(`${scope}:${day}`),
})
