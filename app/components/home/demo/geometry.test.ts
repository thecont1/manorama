import { describe, expect, test } from 'bun:test'
import { DEMO_PHOTOS } from './manifest'
import { DEMO_PRESETS, MAX_STRIP_CSS_HEIGHT, demoPresetById } from './presets'
import {
  captureAnchor,
  contentWidth,
  frameInnerBox,
  layoutStrip,
  restoreOffset,
  travelBounds,
} from './geometry'

const sources = (size: 'lg' | 'sm') =>
  DEMO_PHOTOS.map((p) => ({ id: p.id, naturalWidth: p[size].width, naturalHeight: p[size].height }))

const near = (actual: number, expected: number, tol = 1e-5) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol)

const STAGE = { width: 600, height: 450 }

describe('frameInnerBox', () => {
  test('every preset stages no taller than the renditions were sized for', () => {
    for (const preset of DEMO_PRESETS) {
      const inner = frameInnerBox(preset, STAGE)
      expect(inner.height).toBeLessThanOrEqual(MAX_STRIP_CSS_HEIGHT)
      expect(inner.width).toBeGreaterThan(0)
    }
  })

  test('the three presets are clearly different compositions', () => {
    const desktop = frameInnerBox(demoPresetById('desktop'), STAGE)
    const phone = frameInnerBox(demoPresetById('phone'), STAGE)
    const tablet = frameInnerBox(demoPresetById('tablet'), STAGE)
    // Desktop is wide and short; phone narrow and tall; tablet in between.
    expect(desktop.width / desktop.height).toBeGreaterThan(1.4)
    expect(phone.width / phone.height).toBeLessThan(0.6)
    expect(tablet.width / tablet.height).toBeGreaterThan(phone.width / phone.height)
    expect(tablet.width / tablet.height).toBeLessThan(desktop.width / desktop.height)
  })
})

describe('layoutStrip', () => {
  test('stages landscape and portrait frames whole, abutting, never upscaled', () => {
    const inner = frameInnerBox(demoPresetById('phone'), STAGE)
    const dpr = 2
    const layout = layoutStrip(sources('lg'), inner.height, dpr)
    expect(layout.length).toBe(DEMO_PHOTOS.length)
    let x = 0
    for (const [i, photo] of layout.entries()) {
      const rendition = DEMO_PHOTOS[i]!.lg
      // Aspect preserved exactly.
      near(photo.width / photo.height, rendition.width / rendition.height, 1e-5)
      // Never rendered larger than the served bitmap's own pixels.
      expect(photo.width * dpr).toBeLessThanOrEqual(rendition.width + 0.5)
      expect(photo.height * dpr).toBeLessThanOrEqual(rendition.height + 0.5)
      // Fits the strip height.
      expect(photo.height).toBeLessThanOrEqual(inner.height + 0.5)
      // Abuts the previous frame: no gap, no overlap.
      near(photo.x, x, 1e-5)
      x += photo.width
    }
    near(contentWidth(layout), x, 1e-5)
  })

  test('a pixel-short source floats at its honest size rather than stretching', () => {
    // A tiny source cannot fill the strip height at dpr 2; it must shrink.
    const layout = layoutStrip([{ id: 'tiny', naturalWidth: 100, naturalHeight: 80 }], 430, 2)
    expect(layout[0]!.height).toBeLessThan(430)
    expect(layout[0]!.height * 2).toBeLessThanOrEqual(80)
  })

  test('portrait frames appear in the sequence (phone shows them tall)', () => {
    const layout = layoutStrip(sources('lg'), 430, 2)
    const portraits = layout.filter((p) => DEMO_PHOTOS.find((d) => d.id === p.id)!.orientation === 'portrait')
    expect(portraits.length).toBe(2)
    for (const p of portraits) expect(p.height).toBeGreaterThan(p.width)
  })
})

describe('travelBounds', () => {
  test('a sequence shorter than the viewport has no travel', () => {
    expect(travelBounds(300, 600)).toBe(0)
    expect(travelBounds(600, 600)).toBe(0)
  })
  test('a longer sequence travels exactly its overflow', () => {
    expect(travelBounds(2000, 600)).toBe(1400)
  })
})

describe('the continuity anchor', () => {
  const desktop = frameInnerBox(demoPresetById('desktop'), STAGE)
  const phone = frameInnerBox(demoPresetById('phone'), STAGE)

  test('keeps the same photograph in view across a shape change', () => {
    const before = layoutStrip(sources('lg'), desktop.height, 2)
    const boundsBefore = travelBounds(contentWidth(before), desktop.width)
    const offset = boundsBefore * 0.4
    const anchor = captureAnchor(before, offset, desktop.width)!
    const after = layoutStrip(sources('lg'), phone.height, 2)
    const boundsAfter = travelBounds(contentWidth(after), phone.width)
    const restored = restoreOffset(after, anchor, phone.width, boundsAfter)
    expect(restored).toBeGreaterThanOrEqual(0)
    expect(restored).toBeLessThanOrEqual(boundsAfter)
    const centre = restored + phone.width / 2
    const inView = after.find((p) => centre >= p.x && centre < p.x + p.width)
    expect(inView?.id).toBe(anchor.id)
  })

  test('clamps to the new bounds at the ends', () => {
    const before = layoutStrip(sources('lg'), desktop.height, 2)
    const boundsBefore = travelBounds(contentWidth(before), desktop.width)
    const anchor = captureAnchor(before, boundsBefore, desktop.width)!
    const after = layoutStrip(sources('lg'), phone.height, 2)
    const boundsAfter = travelBounds(contentWidth(after), phone.width)
    const restored = restoreOffset(after, anchor, phone.width, boundsAfter)
    expect(restored).toBeLessThanOrEqual(boundsAfter)
    expect(restored).toBeGreaterThanOrEqual(0)
  })

  test('a dropped photograph falls back to a clamped offset, not a crash', () => {
    const after = layoutStrip(sources('lg').slice(1), phone.height, 2)
    const boundsAfter = travelBounds(contentWidth(after), phone.width)
    const restored = restoreOffset(after, { id: DEMO_PHOTOS[0]!.id, within: 0.5 }, phone.width, boundsAfter)
    expect(restored).toBeGreaterThanOrEqual(0)
    expect(restored).toBeLessThanOrEqual(boundsAfter)
  })

  test('an empty layout restores to zero', () => {
    expect(restoreOffset([], null, 400, 0)).toBe(0)
    expect(captureAnchor([], 0, 400)).toBeNull()
  })
})