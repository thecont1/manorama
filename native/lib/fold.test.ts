import { describe, expect, test } from 'bun:test'
import { foldInputFromRuntime, __private__ } from './fold'

const values: Record<string, string> = {
  '--manorama-segment-left-0': '0px',
  '--manorama-segment-top-0': '0px',
  '--manorama-segment-width-0': '680px',
  '--manorama-segment-height-0': '900px',
  '--manorama-segment-left-1': '760px',
  '--manorama-segment-top-1': '0px',
  '--manorama-segment-width-1': '680px',
  '--manorama-segment-height-1': '900px',
}

describe('fold runtime adapter', () => {
  test('reads the CSS environment bridge without importing a browser API into core', () => {
    const input = foldInputFromRuntime({
      viewport: { width: 1440, height: 900 },
      chromiumMediaQueryMatches: true,
      cssValue: (name) => values[name] ?? '',
      safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
    })

    expect(input.chromium?.mediaQueryMatches).toBe(true)
    expect(input.chromium?.segments).toEqual([
      { x: 0, y: 0, width: 680, height: 900 },
      { x: 760, y: 0, width: 680, height: 900 },
    ])
  })

  test('passes iOS size classes and hinge data through unchanged', () => {
    const input = foldInputFromRuntime({
      viewport: { width: 1440, height: 900 },
      chromiumMediaQueryMatches: false,
      cssValue: () => '',
      safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
      ios: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        hinge: { axis: 'vertical', start: 700, size: 40 },
      },
    })

    expect(input.ios).toEqual({
      horizontalSizeClass: 'regular',
      verticalSizeClass: 'regular',
      safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
      hinge: { axis: 'vertical', start: 700, size: 40 },
    })
  })

  test('uses finite non-negative pixels and viewport fallbacks for missing CSS values', () => {
    expect(__private__.readPixels('12.5px')).toBe(12.5)
    expect(__private__.readPixels('-2px')).toBe(0)
    expect(__private__.readPixels('not-a-length')).toBe(0)
    expect(__private__.segmentFromCss(() => '', 0, { width: 400, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 800,
    })
  })
})
