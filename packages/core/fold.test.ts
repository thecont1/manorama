import { describe, expect, test } from 'bun:test'
import { resolveFoldLayout, type FoldDetectionInput, type FoldSegment } from './fold'

const viewport = { width: 1440, height: 900 }
const left: FoldSegment = { x: 0, y: 0, width: 680, height: 900 }
const right: FoldSegment = { x: 760, y: 0, width: 680, height: 900 }

const chromiumInput = (overrides: Partial<NonNullable<FoldDetectionInput['chromium']>> = {}): FoldDetectionInput => ({
  viewport,
  chromium: { mediaQueryMatches: true, segments: [right, left], ...overrides },
})

describe('resolveFoldLayout', () => {
  test('accepts two Chromium viewport segments and orders them physically', () => {
    const layout = resolveFoldLayout(chromiumInput())

    expect(layout.mode).toBe('diptych')
    expect(layout.source).toBe('chromium')
    expect(layout.segments).toEqual([left, right])
    expect(layout.controlRegions).toEqual([left, right])
  })

  test('does not use segment rectangles when Chromium media-query detection is false', () => {
    const layout = resolveFoldLayout(chromiumInput({ mediaQueryMatches: false }))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('fallback')
    expect(layout.segments).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }])
  })

  test('rejects overlapping or incomplete Chromium geometry conservatively', () => {
    const layout = resolveFoldLayout(chromiumInput({
      segments: [left, { ...right, x: 600 }],
    }))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('fallback')
  })

  test('does not treat horizontal segments as a Chromium horizontal-viewport fold', () => {
    const layout = resolveFoldLayout(chromiumInput({
      segments: [
        { x: 0, y: 0, width: 1440, height: 420 },
        { x: 0, y: 480, width: 1440, height: 420 },
      ],
    }))

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('fallback')
  })

  test('derives an iOS vertical hinge from regular size-class data', () => {
    const layout = resolveFoldLayout({
      viewport,
      ios: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
        hinge: { axis: 'vertical', start: 700, size: 40 },
      },
    })

    expect(layout.mode).toBe('diptych')
    expect(layout.source).toBe('ios')
    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 700, height: 900 },
      { x: 740, y: 0, width: 700, height: 900 },
    ])
    expect(layout.controlRegions).toEqual([
      { x: 0, y: 24, width: 700, height: 842 },
      { x: 740, y: 24, width: 700, height: 842 },
    ])
  })

  test('derives an iOS horizontal hinge without displacing the photo segments', () => {
    const layout = resolveFoldLayout({
      viewport: { width: 900, height: 1440 },
      ios: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        hinge: { axis: 'horizontal', start: 700, size: 40 },
      },
    })

    expect(layout.mode).toBe('diptych')
    expect(layout.segments).toEqual([
      { x: 0, y: 0, width: 900, height: 700 },
      { x: 0, y: 740, width: 900, height: 700 },
    ])
    expect(layout.controlRegions).toEqual(layout.segments)
  })

  test('requires a regular horizontal size class before trusting an iOS hinge', () => {
    const layout = resolveFoldLayout({
      viewport,
      ios: {
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        safeAreaInsets: { top: 10, right: 12, bottom: 20, left: 8 },
        hinge: { axis: 'vertical', start: 700, size: 40 },
      },
    })

    expect(layout.mode).toBe('single')
    expect(layout.source).toBe('ios')
    expect(layout.segments).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }])
    expect(layout.controlRegions).toEqual([{ x: 8, y: 10, width: 1420, height: 870 }])
  })

  test('falls back to the whole viewport when no platform reports a fold', () => {
    const layout = resolveFoldLayout({ viewport })

    expect(layout).toEqual({
      mode: 'single',
      source: 'fallback',
      viewport,
      segments: [{ x: 0, y: 0, width: 1440, height: 900 }],
      controlRegions: [{ x: 0, y: 0, width: 1440, height: 900 }],
    })
  })
})
