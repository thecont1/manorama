import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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
  test('the iOS bridge reads reserved regions synchronously during constraint updates', () => {
    const source = readFileSync(new URL('../../ios/App/App/SceneDelegate.swift', import.meta.url), 'utf8')
    const update = source.match(/override func updateConstraints\(\) \{([\s\S]*?)\n    \}/)?.[1]
    expect(update).toBeDefined()
    expect(update).toContain('onReservedRegionsChange?()')
    expect(update).toContain('super.updateConstraints()')
    expect(update).not.toMatch(/DispatchQueue|Task\s*\{|await/)
    expect(source).toContain('let webView = ManoramaWebView(frame: frame, configuration: configuration)')
    expect(source).toContain('webView.onReservedRegionsChange = { [weak self] in self?.onLayoutChange?() }')
    expect(source).toContain('self?.injectLayout(for: scene)')
    expect(source).toContain('webView.reservedRegions(kind: .division, options: .includeInactive)')
  })

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

  test('scales native points, safe areas, and reserved regions into CSS pixels', () => {
    const input = foldInputFromRuntime({
      viewport: { width: 1440, height: 900 },
      chromiumMediaQueryMatches: false,
      cssValue: () => '',
      safeAreaInsets: { top: 1, right: 1, bottom: 1, left: 1 },
      ios: {
        viewport: { width: 2880, height: 1800 },
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'leading',
        safeAreaInsets: { top: 48, right: 0, bottom: 68, left: 0 },
        regions: [{
          kind: 'division',
          active: true,
          frame: { x: 1400, y: 0, width: 80, height: 1800 },
        }],
      },
    })

    expect(input.ios).toEqual({
      horizontalSizeClass: 'regular',
      verticalSizeClass: 'regular',
      verticalBarEdge: 'leading',
      safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
      regions: [{
        kind: 'division',
        active: true,
        frame: { x: 700, y: 0, width: 40, height: 900 },
      }],
    })
  })

  test('prefers native safe-area data and preserves inactive regions', () => {
    const input = foldInputFromRuntime({
      viewport: { width: 400, height: 800 },
      chromiumMediaQueryMatches: false,
      cssValue: () => '',
      safeAreaInsets: { top: 10, right: 20, bottom: 30, left: 40 },
      ios: {
        viewport: { width: 400, height: 800 },
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'unspecified',
        regions: [{
          kind: 'division',
          active: false,
          frame: { x: 190, y: 0, width: 20, height: 800 },
        }],
      },
    })

    expect(input.ios?.safeAreaInsets).toEqual({ top: 10, right: 20, bottom: 30, left: 40 })
    expect(input.ios?.regions[0]?.active).toBe(false)
  })

  test('makes malformed native viewport geometry fail conservative core validation', () => {
    const input = foldInputFromRuntime({
      viewport: { width: 400, height: 800 },
      chromiumMediaQueryMatches: false,
      cssValue: () => '',
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      ios: {
        viewport: { width: 0, height: 800 },
        horizontalSizeClass: 'compact',
        verticalSizeClass: 'regular',
        verticalBarEdge: 'unspecified',
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        regions: [{
          kind: 'division',
          active: true,
          frame: { x: 190, y: 0, width: 20, height: 800 },
        }],
      },
    })

    expect(Number.isNaN(input.ios?.regions[0]?.frame.x)).toBe(true)
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
