import { describe, expect, test } from 'bun:test'
import { adFrameFor, adMountSize, HOUSE_AD_FRAME, isPlateActionable, type BannerAdAdapter } from './ads'

describe('native ad policy', () => {
  test('requests a free-tier banner and preserves its AdFrame', async () => {
    const frame = { ...HOUSE_AD_FRAME, id: 'filled', provider: 'admob-banner' as const, badge: 'Ad' as const }
    let calls = 0
    const adapter: BannerAdAdapter = { loadMediumRectangle: async () => { calls += 1; return frame } }
    await expect(adFrameFor({ tier: 'free', adapter })).resolves.toBe(frame)
    expect(calls).toBe(1)
    expect(adMountSize).toEqual({ width: 300, height: 250 })
  })

  test('uses the manorama house frame when fill fails or is empty', async () => {
    const failing: BannerAdAdapter = { loadMediumRectangle: async () => { throw new Error('no fill') } }
    await expect(adFrameFor({ tier: 'free', adapter: failing })).resolves.toBe(HOUSE_AD_FRAME)
    await expect(adFrameFor({ tier: 'free', adapter: { loadMediumRectangle: async () => null } })).resolves.toBe(HOUSE_AD_FRAME)
  })

  test('does not request or compose an ad for pro', async () => {
    let calls = 0
    const adapter: BannerAdAdapter = { loadMediumRectangle: async () => { calls += 1; return HOUSE_AD_FRAME } }
    await expect(adFrameFor({ tier: 'pro', adapter })).resolves.toBeNull()
    expect(calls).toBe(0)
  })

  test('actionability requires both rest and centering', () => {
    expect(isPlateActionable(true, true)).toBe(false)
    expect(isPlateActionable(false, false)).toBe(false)
    expect(isPlateActionable(false, true)).toBe(true)
  })
})
