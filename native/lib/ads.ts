import type { AdFrame } from '../../packages/core/adframe'
import { AD_BANNER_HEIGHT, AD_BANNER_WIDTH } from '../../packages/core/adframe'
import { normalizeApiBase } from './api'

export type AdTier = 'free' | 'pro'

/**
 * Deliberately narrower than a plugin API: the viewer consumes AdFrame, while
 * this seam can be backed by a mount-capable native provider or a house
 * campaign. The current Capacitor AdMob banner API paints an overlay at a
 * screen position, so it must not be wired here until a provider can render
 * inside the honest 300x250 plate without covering photographs.
 */
export type BannerAdAdapter = {
  loadMediumRectangle: () => Promise<AdFrame | null>
}

export type AdPolicyInput = {
  tier: AdTier
  adapter?: BannerAdAdapter
  /** Master switch from the Worker: false hides every plate for the day or
   *  region. Undefined (offline, unanswered) means show — suppression is a
   *  courtesy, not a gate. */
  visible?: boolean
}

export const HOUSE_AD_FRAME: AdFrame = {
  id: 'manorama-house-plate',
  advertiser: 'manorama',
  headline: 'More photographs, quietly shared.',
  cta: { label: 'Explore manorama', url: 'https://manorama.xyz' },
  badge: 'Sponsored',
  provider: 'manorama-house',
}

export const createMediumRectangleFrame = (overrides: Partial<AdFrame> = {}): AdFrame => ({
  id: 'admob-medium-rectangle',
  advertiser: 'AdMob',
  badge: 'Ad',
  provider: 'admob-banner',
  ...overrides,
})

export type AdVisibility = {
  show: boolean
  day?: string
  region?: string
}

/** Asks the Worker whether plates show for this viewer's day and geo region.
 *  Fail-open by design: a missed answer — offline gallery, unreachable API —
 *  keeps the cadence; the master switch only ever *suppresses*. */
export const fetchAdVisibility = async (apiBase: string): Promise<AdVisibility> => {
  try {
    const response = await fetch(`${normalizeApiBase(apiBase)}/api/ads/visibility`)
    if (response.ok) {
      const body = (await response.json()) as Partial<AdVisibility>
      return { show: body.show !== false, day: body.day, region: body.region }
    }
  } catch {
    // Unreachable means unanswered, not suppressed.
  }
  return { show: true }
}

/** House plates are editorial, not ad-network inventory, so every tier sees
 *  them. Pro's promise is "no third-party ad network": the adapter is never
 *  called for pro, only the manorama-owned creative. */
export const adFrameFor = async ({ tier, adapter, visible }: AdPolicyInput): Promise<AdFrame | null> => {
  if (visible === false) return null
  if (tier === 'pro') return HOUSE_AD_FRAME
  if (adapter) {
    try {
      const frame = await adapter.loadMediumRectangle()
      if (frame) return frame
    } catch {
      // A fill failure is expected during limited serving and must not blank
      // the plate in front of a reviewer.
    }
  }
  return HOUSE_AD_FRAME
}

export const adMountSize = { width: AD_BANNER_WIDTH, height: AD_BANNER_HEIGHT } as const

export const isPlateActionable = (moving: boolean, centered: boolean): boolean =>
  !moving && centered
