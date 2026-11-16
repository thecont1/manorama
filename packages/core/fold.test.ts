import { describe, expect, test } from 'bun:test'
import { resolveFoldLayout, type FoldDetectionInput, type FoldReservedRegion, type FoldSegment } from './fold'

const viewport = { width: 1440, height: 900 }
const left: FoldSegment = { x: 0, y: 0, width: 680, height: 900 }
const right: FoldSegment = { x: 760, y: 0, width: 680, height: 900 }
const division: FoldReservedRegion = {
  kind: 'division',
  active: true,
  frame: { x: 700, y: 0, width: 40, height: 900 },
}

const chromiumInput = (overrides: Partial<NonNullable<FoldDetectionInput['chromium']>> = {}): FoldDetectionInput => ({
  viewport,
  chromium: { mediaQueryMatches: true, segments: [right, left], ...overrides },
})

const iosInput = (regions: FoldReservedRegion[] = []): FoldDetectionInput => ({
  viewport,
  ios: {
    horizontalSizeClass: 'regular',
    verticalSizeClass: 'regular',
    verticalBarEdge: 'trailing',
    safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
    regions,
  },
})

describe('resolveFoldLayout', () => {
  test('accepts two side-by-side Chromium viewport segments and orders them physically', () => {
    const layout = resolveFoldLayout(chromiumInput())

    expect(layout.mode).toBe('diptych')
    expect(layout.source).toBe('chromium')
    expect(layout.segments).toEqual([left, right])
    expect(layout.controlRegions).toEqual([left, right])
  })

  test('accepts stacked Chromium viewport segments', () => {
    const top = { x: 0, y: 0, width: 1440, height: 420 }
    const bottom = { x: 0, y: 480, width: 1440, height: 420 }
    const layout = resolveFoldLayout(chromiumInput({ segments: [bottom, top] }))

    expect(layout.mode).toBe('diptych')
    expect(layout.segments).toEqual([top, bottom])
  })

  test('does not use segment rectangles when Chromium media-query detection is false', () => {
    const layout = resolveFoldLayout(chromiumInput({ mediaQueryMatches: false }))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('fallback')
    expect(layout.segments).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }])
  })

  test('rejects overlapping or incomplete Chromium geometry conservatively', () => {
    const layout = resolveFoldLayout(chromiumInput({ segments: [left, { ...right, x: 600 }] }))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('fallback')
  })

  test('derives two iOS canvas segments from an active vertical division', () => {
    const layout = resolveFoldLayout(iosInput([division]))

    expect(layout.mode).toBe('diptych')
    expect(layout.source).toBe('ios')
    expect(layout.verticalBarEdge).toBe('trailing')
    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 700, height: 900 },
      { x: 740, y: 0, width: 700, height: 900 },
    ])
    expect(layout.controlRegions).toEqual([
      { x: 0, y: 24, width: 700, height: 842 },
      { x: 740, y: 24, width: 700, height: 842 },
    ])
  })

  test('derives an iOS horizontal division without displacing the photo segments', () => {
    const layout = resolveFoldLayout({
      viewport: { width: 900, height: 1440 },
      ios: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'unspecified',
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        regions: [{ kind: 'division', active: true, frame: { x: 0, y: 700, width: 900, height: 40 } }],
      },
    })

    expect(layout.mode).toBe('diptych')
    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 900, height: 700 },
      { x: 0, y: 740, width: 900, height: 700 },
    ])
    expect(layout.controlRegions).toEqual(layout.segments)
  })

  test('treats an inactive division as a flat single canvas', () => {
    const layout = resolveFoldLayout(iosInput([{ ...division, active: false }]))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('ios')
    expect(layout.segments).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }])
  })

  test('keeps the canvas intact while removing a camera occlusion from controls', () => {
    const layout = resolveFoldLayout(iosInput([
      division,
      { kind: 'occlusion', active: true, frame: { x: 0, y: 0, width: 120, height: 120 } },
    ]))

    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 700, height: 900 },
      { x: 740, y: 0, width: 700, height: 900 },
    ])
    expect(layout.controlRegions[0]).toEqual({ x: 0, y: 120, width: 700, height: 746 })
    expect(layout.controlRegions[1]).toEqual({ x: 740, y: 24, width: 700, height: 842 })
  })

  test('uses native flat geometry in preference to contradictory browser segments', () => {
    const input = iosInput([])
    input.chromium = { mediaQueryMatches: true, segments: [left, right] }
    const layout = resolveFoldLayout(input)

    expect(layout.source).toBe('ios')
    expect(layout.mode).toBe('single')
  })

  test('falls back conservatively when a native active division is malformed', () => {
    const input = iosInput([{ ...division, frame: { x: 700, y: 100, width: 40, height: 700 } }])
    input.chromium = { mediaQueryMatches: true, segments: [left, right] }
    const layout = resolveFoldLayout(input)

    expect(layout.source).toBe('ios')
    expect(layout.mode).toBe('single')
  })

  test('falls back to the whole viewport when no platform reports a division', () => {
    const layout = resolveFoldLayout({ viewport })

    expect(layout).toEqual({
      mode: 'single',
      source: 'fallback',
      viewport,
      horizontalSizeClass: 'unspecified',
      verticalSizeClass: 'unspecified',
      verticalBarEdge: 'unspecified',
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      segments: [{ x: 0, y: 0, width: 1440, height: 900 }],
      controlRegions: [{ x: 0, y: 0, width: 1440, height: 900 }],
    })
  })
})
