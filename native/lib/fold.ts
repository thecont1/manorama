import { resolveFoldLayout, type FoldDetectionInput, type FoldInsets, type FoldLayout, type FoldReservedRegion, type FoldSegment, type FoldSizeClass, type FoldVerticalBarEdge } from '../../packages/core/fold'

export type IOSLayoutRuntime = {
  viewport: { width: number; height: number }
  horizontalSizeClass: FoldSizeClass
  verticalSizeClass: FoldSizeClass
  verticalBarEdge: FoldVerticalBarEdge
  safeAreaInsets?: FoldInsets
  regions: readonly FoldReservedRegion[]
}

export type FoldRuntimeEnvironment = {
  viewport: { width: number; height: number }
  chromiumMediaQueryMatches: boolean
  cssValue(name: string): string
  safeAreaInsets: FoldInsets
  ios?: IOSLayoutRuntime
}

const readPixels = (value: string): number => {
  const pixels = Number.parseFloat(value)
  return Number.isFinite(pixels) && pixels >= 0 ? pixels : 0
}

const segmentFromCss = (cssValue: (name: string) => string, index: number, viewport: { width: number; height: number }): FoldSegment => ({
  x: readPixels(cssValue(`--manorama-segment-left-${index}`)),
  y: readPixels(cssValue(`--manorama-segment-top-${index}`)),
  width: readPixels(cssValue(`--manorama-segment-width-${index}`)) || viewport.width,
  height: readPixels(cssValue(`--manorama-segment-height-${index}`)) || viewport.height,
})

const rounded = (value: number): number => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value

export const foldInputFromRuntime = (runtime: FoldRuntimeEnvironment): FoldDetectionInput => {
  const ios = runtime.ios
  const scaleX = ios && ios.viewport.width > 0 ? runtime.viewport.width / ios.viewport.width : Number.NaN
  const scaleY = ios && ios.viewport.height > 0 ? runtime.viewport.height / ios.viewport.height : Number.NaN
  const scaleSegment = (segment: FoldSegment): FoldSegment => ({
    x: rounded(segment.x * scaleX),
    y: rounded(segment.y * scaleY),
    width: rounded(segment.width * scaleX),
    height: rounded(segment.height * scaleY),
  })
  const nativeInsets = ios?.safeAreaInsets
  return {
    viewport: runtime.viewport,
    chromium: {
      mediaQueryMatches: runtime.chromiumMediaQueryMatches,
      segments: [0, 1].map((index) => segmentFromCss(runtime.cssValue, index, runtime.viewport)),
    },
    ios: ios ? {
      horizontalSizeClass: ios.horizontalSizeClass,
      verticalSizeClass: ios.verticalSizeClass,
      verticalBarEdge: ios.verticalBarEdge,
      safeAreaInsets: nativeInsets ? {
        top: rounded(nativeInsets.top * scaleY),
        right: rounded(nativeInsets.right * scaleX),
        bottom: rounded(nativeInsets.bottom * scaleY),
        left: rounded(nativeInsets.left * scaleX),
      } : runtime.safeAreaInsets,
      regions: ios.regions.map((region) => ({ ...region, frame: scaleSegment(region.frame) })),
    } : undefined,
  }
}

export const readRuntimeFoldLayout = (): FoldLayout => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return resolveFoldLayout({ viewport: { width: 0, height: 0 } })
  }
  const rootStyle = getComputedStyle(document.documentElement)
  const cssValue = (name: string) => rootStyle.getPropertyValue(name)
  const horizontalSegments = window.matchMedia?.('(horizontal-viewport-segments: 2)').matches ?? false
  const verticalSegments = window.matchMedia?.('(vertical-viewport-segments: 2)').matches ?? false
  return resolveFoldLayout(foldInputFromRuntime({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    chromiumMediaQueryMatches: horizontalSegments || verticalSegments,
    cssValue,
    safeAreaInsets: {
      top: readPixels(cssValue('--native-safe-top')),
      right: readPixels(cssValue('--native-safe-right')),
      bottom: readPixels(cssValue('--native-safe-bottom')),
      left: readPixels(cssValue('--native-safe-left')),
    },
    ios: window.__MANORAMA_IOS_LAYOUT__,
  }))
}

export const subscribeToRuntimeFoldLayout = (onChange: (layout: FoldLayout) => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined
  let frame: number | null = null
  const sync = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      onChange(readRuntimeFoldLayout())
    })
  }
  const horizontalMedia = window.matchMedia?.('(horizontal-viewport-segments: 2)')
  const verticalMedia = window.matchMedia?.('(vertical-viewport-segments: 2)')
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  window.addEventListener('manorama:layout', sync)
  horizontalMedia?.addEventListener?.('change', sync)
  verticalMedia?.addEventListener?.('change', sync)
  return () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('orientationchange', sync)
    window.removeEventListener('manorama:layout', sync)
    horizontalMedia?.removeEventListener?.('change', sync)
    verticalMedia?.removeEventListener?.('change', sync)
    if (frame !== null) cancelAnimationFrame(frame)
  }
}

declare global {
  interface Window {
    /** UIKit's current web-view geometry, in native points before adapter scaling. */
    __MANORAMA_IOS_LAYOUT__?: IOSLayoutRuntime
  }
}

export const __private__ = { readPixels, segmentFromCss }
