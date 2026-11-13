import { describe, expect, test } from 'bun:test'
import { DEMO_DUO_PHOTOS, DEMO_PHOTOS } from './manifest'
import {
  DEMO_PRESETS,
  demoPresetById,
  deviceFrameSize,
  deviceViewerSize,
  DUO_HINGE_WIDTH,
  fitDeviceFrame,
} from './presets'
import { duoSpreadStartIndexes } from './DemoDuoTrack'
import { resolveFoldLayout } from '../../../../packages/core/fold'
import {
  captureAnchor,
  contentWidth,
  endCardWidth,
  layoutStrip,
  positionIndex,
  restStops,
  restoreOffset,
  travelBounds,
} from './geometry'

const sources = () => DEMO_PHOTOS.map((photo) => ({
  id: photo.id,
  naturalWidth: photo.lg.width,
  naturalHeight: photo.lg.height,
}))

const near = (actual: number, expected: number, tolerance = 1e-5) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)

const VIEWPORT = { width: 900, height: 450 }

describe('device frames', () => {
  test('each category names one real device and its logical screen', () => {
    expect(DEMO_PRESETS.map((preset) => preset.id)).toEqual(['desktop', 'phone', 'tablet', 'duo'])
    expect(DEMO_PRESETS.map((preset) => preset.label)).toEqual(['Desktop', 'Mobile', 'Tablet', 'Foldable'])
    expect(demoPresetById('desktop').model).toBe('MacBook Pro 14-inch')
    expect(demoPresetById('desktop').screen).toEqual({ width: 1512, height: 982 })
    expect(demoPresetById('phone').model).toBe('iPhone 17 Pro')
    expect(demoPresetById('phone').screen).toEqual({ width: 402, height: 874 })
    expect(demoPresetById('tablet').model).toBe('iPad Pro 11-inch (M5)')
    expect(demoPresetById('tablet').screen).toEqual({ width: 834, height: 1210 })
    expect(demoPresetById('duo').model).toBe('iPhone Duo')
    expect(demoPresetById('duo').screen).toEqual({ width: 951, height: 669 })
  })

  test('the touch-device bodies follow Apple’s published physical proportions', () => {
    const phone = deviceFrameSize(demoPresetById('phone'))
    const tablet = deviceFrameSize(demoPresetById('tablet'))
    const duo = deviceFrameSize(demoPresetById('duo'))
    near(phone.width / phone.height, 71.9 / 150, 0.01)
    near(tablet.width / tablet.height, 177.5 / 249.7, 0.01)
    near(duo.width / duo.height, 164.6 / 117.8, 0.01)
  })

  test('the complete device fits the reserved stage with one uniform scale', () => {
    for (const preset of DEMO_PRESETS) {
      const available = { width: 620, height: 510 }
      const frame = deviceFrameSize(preset)
      const fit = fitDeviceFrame(preset, available)
      expect(fit.scale).toBeGreaterThan(0)
      expect(fit.scale).toBeLessThanOrEqual(1)
      near(fit.width, frame.width * fit.scale)
      near(fit.height, frame.height * fit.scale)
      expect(fit.width).toBeLessThanOrEqual(available.width)
      expect(fit.height).toBeLessThanOrEqual(available.height)
    }
  })

  test('a density-approved display can fill a larger stage without exceeding its scale budget', () => {
    const preset = demoPresetById('desktop')
    const frame = deviceFrameSize(preset)
    const fit = fitDeviceFrame(preset, { width: 3000, height: 2000 }, 1.25)
    expect(fit.scale).toBe(1.25)
    near(fit.width, frame.width * 1.25)
    near(fit.height, frame.height * 1.25)
  })

  test('the Foldable derives a vertical 40pt gutter from regular inner-display size classes', () => {
    const duo = demoPresetById('duo')
    const viewport = deviceViewerSize(duo)
    const layout = resolveFoldLayout({
      viewport,
      ios: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        safeAreaInsets: { top: 24, right: 28, bottom: 24, left: 24 },
        hinge: {
          axis: 'vertical',
          start: (viewport.width - DUO_HINGE_WIDTH) / 2,
          size: DUO_HINGE_WIDTH,
        },
      },
    })
    expect(DUO_HINGE_WIDTH).toBe(40)
    expect(layout.mode).toBe('diptych')
    expect(layout.source).toBe('ios')
    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 455.5, height: 669 },
      { x: 495.5, y: 0, width: 455.5, height: 669 },
    ])
    expect(layout.controlRegions).toEqual([
      { x: 24, y: 24, width: 403.5, height: 621 },
      { x: 519.5, y: 24, width: 403.5, height: 621 },
    ])
    near(duo.bezel / deviceFrameSize(duo).width, 0.04)
    near(duo.screenRadius / duo.screen.height, 0.09, 0.01)
  })

  test('hardware intrusions leave full screens while their chrome stays clear', () => {
    const desktop = demoPresetById('desktop')
    expect(desktop.baseHeight).toBeGreaterThan(0)
    expect(desktop.viewerInset.top).toBe(desktop.notch!.height)
    expect(deviceViewerSize(desktop)).toEqual({ width: 1512, height: 946 })

    const phone = demoPresetById('phone')
    expect(phone.chromeTop).toBeGreaterThan(phone.island!.top + phone.island!.height)
    expect(deviceViewerSize(phone)).toEqual({ width: 402, height: 874 })

    const tablet = demoPresetById('tablet')
    expect(tablet.orientation).toBe('portrait')
    expect(tablet.chromeTop).toBeGreaterThan(8)
    expect(tablet.rim).toBeLessThan(tablet.bezel)
    expect(deviceViewerSize(tablet)).toEqual({ width: 834, height: 1210 })

    const duo = demoPresetById('duo')
    expect(duo.island).toBeUndefined()
    expect(duo.notch).toBeUndefined()
    expect(duo.screenRadius).toBe(60)
    expect(deviceViewerSize(duo)).toEqual({ width: 951, height: 669 })
  })
})

describe('Foldable spreads', () => {
  test('opens with portraits and keeps every fixed spread in one orientation', () => {
    expect(DEMO_DUO_PHOTOS.slice(0, 2).map((photo) => photo.id)).toEqual(['italy-0302', 'italy-0503'])
    expect(new Set(DEMO_DUO_PHOTOS.map((photo) => photo.id))).toEqual(new Set(DEMO_PHOTOS.map((photo) => photo.id)))
    for (const start of duoSpreadStartIndexes(DEMO_DUO_PHOTOS.length)) {
      const spread = DEMO_DUO_PHOTOS.slice(start, start + 2)
      expect(spread).toHaveLength(2)
      expect(spread[1]!.orientation).toBe(spread[0]!.orientation)
    }
  })

  test('advances by two and overlaps only the final odd-count spread', () => {
    expect(duoSpreadStartIndexes(15)).toEqual([0, 2, 4, 6, 8, 10, 12, 13])
    expect(duoSpreadStartIndexes(3)).toEqual([0, 1])
    expect(duoSpreadStartIndexes(2)).toEqual([0])
    expect(duoSpreadStartIndexes(1)).toEqual([0])
    expect(duoSpreadStartIndexes(0)).toEqual([])
  })
})

describe('layoutStrip', () => {
  test('every non-fold device uses the same height-first, uncropped strip geometry', () => {
    for (const preset of DEMO_PRESETS.filter((candidate) => candidate.id !== 'duo')) {
      const viewport = deviceViewerSize(preset)
      const layout = layoutStrip(sources(), viewport, 2)
      expect(layout).toHaveLength(DEMO_PHOTOS.length)
      let x = 0
      for (const [index, staged] of layout.entries()) {
        const source = DEMO_PHOTOS[index]!.lg
        near(staged.width / staged.height, source.width / source.height)
        expect(staged.width * 2).toBeLessThanOrEqual(source.width + 0.5)
        expect(staged.height * 2).toBeLessThanOrEqual(source.height + 0.5)
        expect(staged.height).toBeLessThanOrEqual(viewport.height + 0.5)
        near(staged.x, x)
        near(staged.slotWidth, staged.width)
        x += staged.slotWidth
      }
      near(contentWidth(layout), x)
      expect(contentWidth(layout)).toBeGreaterThan(viewport.width)
    }
  })

  test('a pixel-short source floats at its honest size', () => {
    const [staged] = layoutStrip(
      [{ id: 'tiny', naturalWidth: 100, naturalHeight: 80 }],
      VIEWPORT,
      2,
    )
    expect(staged!.width).toBe(50)
    expect(staged!.height).toBe(40)
    expect(staged!.slotWidth).toBe(50)
  })
})

describe('restStops', () => {
  test('includes the end card in the final travel bound', () => {
    const layout = layoutStrip(sources(), VIEWPORT, 2)
    const cardWidth = endCardWidth(VIEWPORT)
    const bounds = travelBounds(contentWidth(layout) + cardWidth, VIEWPORT.width)
    const stops = restStops(layout, VIEWPORT.width, cardWidth)
    expect(stops[0]).toBe(0)
    near(stops[stops.length - 1]!, bounds, 0.001)
    expect(new Set(stops).size).toBe(stops.length)
    for (const [index, stop] of stops.entries()) {
      expect(stop).toBeGreaterThanOrEqual(0)
      expect(stop).toBeLessThanOrEqual(bounds)
      if (index > 0) expect(stop).toBeGreaterThan(stops[index - 1]!)
    }
  })

  test('the end card has a readable bounded width on every screen', () => {
    expect(endCardWidth(deviceViewerSize(demoPresetById('phone')))).toBe(230)
    expect(endCardWidth(deviceViewerSize(demoPresetById('tablet')))).toBe(266.88)
    expect(endCardWidth(deviceViewerSize(demoPresetById('desktop')))).toBe(360)
    expect(endCardWidth(deviceViewerSize(demoPresetById('duo')))).toBe(304.32)
  })

  test('a strip with no overflow stays at zero', () => {
    const layout = layoutStrip(
      [{ id: 'tiny', naturalWidth: 100, naturalHeight: 80 }],
      VIEWPORT,
      1,
    )
    expect(restStops(layout, VIEWPORT.width, endCardWidth(VIEWPORT))).toEqual([0])
  })
})

describe('travelBounds', () => {
  test('measures only actual overflow', () => {
    expect(travelBounds(300, 600)).toBe(0)
    expect(travelBounds(600, 600)).toBe(0)
    expect(travelBounds(2000, 600)).toBe(1400)
  })
})

describe('the continuity anchor and position count', () => {
  test('keeps the same photograph and relative position across device changes', () => {
    const beforeViewport = deviceViewerSize(demoPresetById('desktop'))
    const afterViewport = deviceViewerSize(demoPresetById('phone'))
    const before = layoutStrip(sources(), beforeViewport, 2)
    const middle = before[Math.floor(before.length / 2)]!
    const offset = middle.x + middle.slotWidth * 0.4 - beforeViewport.width / 2
    const anchor = captureAnchor(before, offset, beforeViewport.width)!
    expect(anchor.id).toBe(middle.id)
    near(anchor.within, 0.4)

    const after = layoutStrip(sources(), afterViewport, 2)
    const bounds = travelBounds(contentWidth(after) + endCardWidth(afterViewport), afterViewport.width)
    const restored = restoreOffset(after, anchor, afterViewport.width, bounds)
    const recaptured = captureAnchor(after, restored, afterViewport.width)!
    expect(recaptured.id).toBe(anchor.id)
    near(recaptured.within, anchor.within)
  })

  test('derives the visible count from the photograph under the screen centre', () => {
    const layout = layoutStrip(sources(), VIEWPORT, 2)
    for (const photo of layout) {
      const offset = Math.max(0, photo.x + photo.slotWidth / 2 - VIEWPORT.width / 2)
      expect(positionIndex(layout, offset, VIEWPORT.width)).toBe(photo.index)
    }
    const bounds = travelBounds(contentWidth(layout) + endCardWidth(VIEWPORT), VIEWPORT.width)
    expect(positionIndex(layout, bounds, VIEWPORT.width)).toBe(layout.length - 1)
  })

  test('clamps the first and last photographs to the new travel bounds', () => {
    const viewport = deviceViewerSize(demoPresetById('phone'))
    const layout = layoutStrip(sources(), viewport, 2)
    const bounds = travelBounds(contentWidth(layout), viewport.width)
    expect(restoreOffset(layout, { id: layout[0]!.id, within: 0 }, viewport.width, bounds)).toBe(0)
    expect(restoreOffset(layout, { id: layout[layout.length - 1]!.id, within: 1 }, viewport.width, bounds)).toBe(bounds)
  })

  test('a dropped photograph falls back inside the bounds', () => {
    const viewport = deviceViewerSize(demoPresetById('phone'))
    const layout = layoutStrip(sources().slice(1), viewport, 2)
    const bounds = travelBounds(contentWidth(layout), viewport.width)
    const restored = restoreOffset(layout, { id: DEMO_PHOTOS[0]!.id, within: 0.5 }, viewport.width, bounds)
    expect(restored).toBeGreaterThanOrEqual(0)
    expect(restored).toBeLessThanOrEqual(bounds)
  })

  test('an empty layout has no anchor and restores to zero', () => {
    expect(restoreOffset([], null, 400, 0)).toBe(0)
    expect(captureAnchor([], 0, 400)).toBeNull()
    expect(positionIndex([], 0, 400)).toBe(0)
  })
})
