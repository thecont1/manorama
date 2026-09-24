import type { AdFrame } from '../../packages/core/adframe'
import { AD_BANNER_HEIGHT, AD_BANNER_WIDTH } from '../../packages/core/adframe'

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

/** Policy is intentionally boring: pro gets no request and no fallback. */
export const adFrameFor = async ({ tier, adapter }: AdPolicyInput): Promise<AdFrame | null> => {
  if (tier === 'pro') return null
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
