import { describe, expect, test } from 'bun:test'
import {
  accountAdPositionFor,
  createAccountAdAdapter,
  type AdMobBannerBridge,
} from './admob-account-adapter'
import { adFrameFor, HOUSE_AD_FRAME } from './ads'

/**
 * The account placement rents a real rectangle from AdMob, so what is worth
 * proving is not that the plugin was called but that it is only ever asked for
 * a rectangle that lands on our own reserve — and that every way it can fail
 * ends at the house plate rather than a hole in the page.
 */

const UNIT = 'ca-app-pub-3564536130489009/1111111111'

type Shown = { adId: string; adSize: string; position: string; margin?: number }

const fakeBridge = (behaviour: { failInitialize?: boolean; failShow?: boolean } = {}) => {
  const calls: string[] = []
  const shown: Shown[] = []
  let loadCount = 0
  const api: AdMobBannerBridge = {
    initialize: async () => {
      calls.push('initialize')
      if (behaviour.failInitialize && calls.filter((call) => call === 'initialize').length === 1) {
        throw new Error('sdk unavailable')
      }
    },
    showBanner: async (options) => {
      calls.push('show')
      if (behaviour.failShow) throw new Error('no fill')
      shown.push(options as Shown)
    },
    hideBanner: async () => { calls.push('hide') },
    removeBanner: async () => { calls.push('remove') },
  }
  return {
    api,
    calls,
    shown,
    loads: () => loadCount,
    load: async () => { loadCount += 1; return api },
  }
}

const settle = { top: 120, height: 250 }

describe('account placement bands', () => {
  test('rents a rectangle only where a fixed position lands on the reserve', () => {
    expect(accountAdPositionFor(60, 812)).toBe('TOP_CENTER')
    expect(accountAdPositionFor(276, 812)).toBe('TOP_CENTER')
    expect(accountAdPositionFor(400, 812)).toBe('CENTER')
    // Below the middle band the plugin has no position that would sit on the
    // slot, so renting one would paint an ad across the page instead.
    expect(accountAdPositionFor(700, 812)).toBeNull()
    expect(accountAdPositionFor(0, 0)).toBeNull()
    expect(accountAdPositionFor(-10, 812)).toBeNull()
  })
})

describe('live account adapter', () => {
  test('is dormant without a native platform or a configured unit', async () => {
    const web = fakeBridge()
    const webAdapter = createAccountAdAdapter({
      isNative: false,
      unitId: UNIT,
      loadBridge: web.load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    expect(webAdapter.live).toBe(false)
    await expect(webAdapter.loadMediumRectangle()).resolves.toBeNull()
    expect(web.loads()).toBe(0)

    const unconfigured = fakeBridge()
    const unconfiguredAdapter = createAccountAdAdapter({
      isNative: true,
      loadBridge: unconfigured.load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    expect(unconfiguredAdapter.live).toBe(false)
    await expect(unconfiguredAdapter.loadMediumRectangle()).resolves.toBeNull()
    expect(unconfigured.loads()).toBe(0)
  })

  test('initializes once and paints the medium rectangle onto the reserved plate', async () => {
    const { api, calls, shown, loads, load } = fakeBridge()
    const adapter = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    expect(adapter.live).toBe(true)

    const frame = await adapter.loadMediumRectangle()
    expect(frame?.provider).toBe('admob-banner')
    expect(frame?.badge).toBe('Ad')
    expect(shown).toEqual([{ adId: UNIT, adSize: 'MEDIUM_RECTANGLE', position: 'TOP_CENTER', margin: 120 }])
    expect(calls).toEqual(['initialize', 'show'])

    // A second visit reuses the initialized SDK.
    await adapter.loadMediumRectangle()
    expect(loads()).toBe(1)
    expect(calls).toEqual(['initialize', 'show', 'show'])

    await adapter.retire()
    expect(calls).toEqual(['initialize', 'show', 'show', 'hide', 'remove'])
    // Retiring twice is not a second teardown.
    await adapter.retire()
    expect(calls.filter((call) => call === 'hide')).toHaveLength(1)
    expect(api).toBeTruthy()
  })

  test('rents nothing when the reserve is off its band', async () => {
    const { calls, loads, load } = fakeBridge()
    const adapter = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: load,
      readSlotRect: () => ({ top: 700, height: 250 }),
      viewportHeight: () => 812,
    })
    await expect(adapter.loadMediumRectangle()).resolves.toBeNull()
    expect(calls).toEqual([])
    expect(loads()).toBe(0)
  })

  test('rents nothing when the reserve is not on screen', async () => {
    const { loads, load } = fakeBridge()
    const adapter = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: load,
      readSlotRect: () => null,
      viewportHeight: () => 812,
    })
    await expect(adapter.loadMediumRectangle()).resolves.toBeNull()
    expect(loads()).toBe(0)
  })

  test('a rectangle that cannot be painted leaves the house plate standing', async () => {
    const failing = fakeBridge({ failShow: true })
    const adapter = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: failing.load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    await expect(adapter.loadMediumRectangle()).resolves.toBeNull()
    expect(failing.calls).toEqual(['initialize', 'show'])
  })

  test('a failed handshake is retried on the next visit, not cached forever', async () => {
    const { calls, shown, load } = fakeBridge({ failInitialize: true })
    const adapter = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    await expect(adapter.loadMediumRectangle()).resolves.toBeNull()
    expect(calls).toEqual(['initialize'])

    const frame = await adapter.loadMediumRectangle()
    expect(frame?.provider).toBe('admob-banner')
    expect(calls).toEqual(['initialize', 'initialize', 'show'])
    expect(shown).toHaveLength(1)
  })
})

describe('live placement through the ad policy', () => {
  const adapter = () => {
    const { calls, shown, load } = fakeBridge()
    return {
      calls,
      shown,
      live: createAccountAdAdapter({
        isNative: true,
        unitId: UNIT,
        loadBridge: load,
        readSlotRect: () => settle,
        viewportHeight: () => 812,
      }),
    }
  }

  test('a free owner is served the rented rectangle', async () => {
    const { shown, live } = adapter()
    const frame = await adFrameFor({ tier: 'free', adapter: live })
    expect(frame?.provider).toBe('admob-banner')
    expect(shown).toHaveLength(1)
  })

  test('pro never reaches the ad network', async () => {
    const { calls, live } = adapter()
    await expect(adFrameFor({ tier: 'pro', adapter: live })).resolves.toBe(HOUSE_AD_FRAME)
    expect(calls).toEqual([])
  })

  test('the master switch suppresses the placement before any request', async () => {
    const { calls, loads, load } = fakeBridge()
    const live = createAccountAdAdapter({
      isNative: true,
      unitId: UNIT,
      loadBridge: load,
      readSlotRect: () => settle,
      viewportHeight: () => 812,
    })
    await expect(adFrameFor({ tier: 'free', adapter: live, visible: false })).resolves.toBeNull()
    expect(calls).toEqual([])
    expect(loads()).toBe(0)
  })
})