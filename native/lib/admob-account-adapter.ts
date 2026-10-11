import type { AdFrame } from '../../packages/core/adframe'
import { createMediumRectangleFrame, type BannerAdAdapter } from './ads'

/**
 * The live side of the account placement, rented from AdMob.
 *
 * The plan's rule for this week is "the mount is ours, the rectangle is
 * rented": the account page reserves the honest 300×250 plate in its own
 * layout, and a real AdMob medium rectangle is painted over that reserve. The
 * plugin places a banner at one of three fixed screen positions, so the slot's
 * own geometry decides whether a live rectangle can land on it truthfully.
 * When it cannot — the slot scrolled out of its band, the device cannot paint
 * it, no fill — this returns null and the caller keeps the house plate. It
 * never reaches for a position that would leave an ad covering the page.
 *
 * The bridge is a narrow structural slice of the plugin on purpose: the
 * adapter is exercised in unit tests without a device, and the plugin's own
 * types stay free to move.
 */

export const ACCOUNT_AD_SLOT_SELECTOR = '[data-account-ad]'

export type AccountAdPosition = 'TOP_CENTER' | 'CENTER'

export type SlotRect = { top: number; height: number }

export type AdMobBannerBridge = {
  initialize: () => Promise<void>
  showBanner: (options: {
    adId: string
    /** The plugin's own size name. Always the 300×250 medium rectangle here. */
    adSize: 'MEDIUM_RECTANGLE'
    position: AccountAdPosition
    /** Offset from the top edge, in points, for the top-centred position. */
    margin?: number
  }) => Promise<void>
  hideBanner: () => Promise<void>
  removeBanner: () => Promise<void>
}

export type AccountAdEnvironment = {
  isNative: boolean
  /** `ca-app-pub-…/…`. Absent means the live placement is off and the house
   *  plate stands, which is what every non-production build wants. */
  unitId?: string
  loadBridge?: () => Promise<AdMobBannerBridge>
  readSlotRect?: () => SlotRect | null
  viewportHeight?: () => number
}

export type AccountAdAdapter = BannerAdAdapter & {
  /** True when a live rectangle can be requested at all: native platform and a
   *  configured unit. The caller uses this to keep the house path untouched
   *  everywhere else. */
  readonly live: boolean
  /** Takes the rectangle down. Safe to call when nothing is showing. */
  retire: () => Promise<void>
}

/** The band a 300×250 rectangle can occupy without covering page content: the
 *  slot's top edge must sit inside the region the plugin's fixed positions
 *  actually address. Below that, the honest answer is no live rectangle. */
const TOP_BAND = 0.34
const MID_BAND = 0.62

export const accountAdPositionFor = (slotTop: number, viewportHeight: number): AccountAdPosition | null => {
  if (!(viewportHeight > 0) || !(slotTop >= 0)) return null
  const ratio = slotTop / viewportHeight
  if (ratio <= TOP_BAND) return 'TOP_CENTER'
  if (ratio <= MID_BAND) return 'CENTER'
  return null
}

const readSlotRectInDocument = (): SlotRect | null => {
  if (typeof document === 'undefined') return null
  const element = document.querySelector(ACCOUNT_AD_SLOT_SELECTOR)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  // The reserved plate is the mount. A reserve that has collapsed to nothing
  // means the page is not showing it, so nothing is rented.
  if (!(rect.height > 0)) return null
  return { top: rect.top, height: rect.height }
}

const loadAdMobBridge = async (): Promise<AdMobBannerBridge> => {
  const { AdMob, BannerAdPosition, BannerAdSize } = await import('@capacitor-community/admob')
  return {
    initialize: () => AdMob.initialize(),
    showBanner: (options) => AdMob.showBanner({
      adId: options.adId,
      adSize: BannerAdSize.MEDIUM_RECTANGLE,
      position: options.position === 'TOP_CENTER' ? BannerAdPosition.TOP_CENTER : BannerAdPosition.CENTER,
      ...(options.margin === undefined ? {} : { margin: options.margin }),
    }),
    hideBanner: () => AdMob.hideBanner(),
    removeBanner: () => AdMob.removeBanner(),
  }
}

export const createAccountAdAdapter = (environment: AccountAdEnvironment): AccountAdAdapter => {
  const unitId = environment.unitId?.trim()
  const live = Boolean(environment.isNative && unitId)
  const loadBridge = environment.loadBridge ?? loadAdMobBridge
  const readSlotRect = environment.readSlotRect ?? readSlotRectInDocument
  const viewportHeight = environment.viewportHeight ?? (() => (typeof window === 'undefined' ? 0 : window.innerHeight))

  let bridge: AdMobBannerBridge | null = null
  let pending: Promise<AdMobBannerBridge> | null = null
  let showing = false

  /** The SDK is initialized once per session. A failed handshake clears the
   *  memo so a later visit can try again rather than staying dark forever. */
  const bridgeFor = async (): Promise<AdMobBannerBridge> => {
    if (bridge) return bridge
    if (!pending) {
      pending = loadBridge()
        .then(async (loaded) => {
          await loaded.initialize()
          bridge = loaded
          return loaded
        })
        .catch((error) => {
          pending = null
          throw error
        })
    }
    return pending
  }

  const retire = async (): Promise<void> => {
    if (!showing || !bridge) return
    showing = false
    try {
      await bridge.hideBanner()
      await bridge.removeBanner()
    } catch {
      // Taking an absent banner down has nothing to report.
    }
  }

  const loadMediumRectangle = async (): Promise<AdFrame | null> => {
    if (!live || !unitId) return null
    const slot = readSlotRect()
    if (!slot) return null
    const position = accountAdPositionFor(slot.top, viewportHeight())
    if (!position) {
      // The reserve is off its band — between scrolling and a short viewport
      // there is no position that lands on it, so rent nothing.
      await retire()
      return null
    }
    try {
      const loaded = await bridgeFor()
      await loaded.showBanner({
        adId: unitId,
        adSize: 'MEDIUM_RECTANGLE',
        position,
        ...(position === 'TOP_CENTER' ? { margin: Math.max(0, Math.round(slot.top)) } : {}),
      })
      showing = true
      return createMediumRectangleFrame({ id: 'account-admob-medium-rectangle' })
    } catch {
      // Limited serving, no fill, or a device that will not paint it: the
      // house plate is the answer, and a failed request is not an error the
      // owner needs to see.
      await retire()
      return null
    }
  }

  return { live, loadMediumRectangle, retire }
}