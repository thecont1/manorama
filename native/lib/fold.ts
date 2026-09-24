import { resolveFoldLayout, type FoldDetectionInput, type FoldInsets, type FoldLayout, type FoldSegment, type FoldSizeClass } from '../../packages/core/fold'

export type IOSFoldRuntime = {
  horizontalSizeClass: FoldSizeClass
  verticalSizeClass: FoldSizeClass
  hinge?: NonNullable<NonNullable<FoldDetectionInput['ios']>['hinge']>
}

export type FoldRuntimeEnvironment = {
  viewport: { width: number; height: number }
  chromiumMediaQueryMatches: boolean
  cssValue(name: string): string
  safeAreaInsets: FoldInsets
  ios?: IOSFoldRuntime
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

export const foldInputFromRuntime = (runtime: FoldRuntimeEnvironment): FoldDetectionInput => ({
  viewport: runtime.viewport,
  chromium: {
    mediaQueryMatches: runtime.chromiumMediaQueryMatches,
    segments: [0, 1].map((index) => segmentFromCss(runtime.cssValue, index, runtime.viewport)),
  },
  ios: runtime.ios ? {
    ...runtime.ios,
    safeAreaInsets: runtime.safeAreaInsets,
  } : undefined,
})

export const readRuntimeFoldLayout = (): FoldLayout => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return resolveFoldLayout({ viewport: { width: 0, height: 0 } })
  }
  const rootStyle = getComputedStyle(document.documentElement)
  const cssValue = (name: string) => rootStyle.getPropertyValue(name)
  const ios = window.__MANORAMA_IOS_FOLD__
  return resolveFoldLayout(foldInputFromRuntime({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    chromiumMediaQueryMatches: window.matchMedia?.('(horizontal-viewport-segments: 2)').matches ?? false,
    cssValue,
    safeAreaInsets: {
      top: readPixels(cssValue('--native-safe-top')),
      right: readPixels(cssValue('--native-safe-right')),
      bottom: readPixels(cssValue('--native-safe-bottom')),
      left: readPixels(cssValue('--native-safe-left')),
    },
    ios,
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
  const media = window.matchMedia?.('(horizontal-viewport-segments: 2)')
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  media?.addEventListener?.('change', sync)
  return () => {
    window.removeEventListener('resize', sync)
    window.removeEventListener('orientationchange', sync)
    media?.removeEventListener?.('change', sync)
    if (frame !== null) cancelAnimationFrame(frame)
  }
}

declare global {
  interface Window {
    /** Native iOS integration may populate size classes and hinge geometry. */
    __MANORAMA_IOS_FOLD__?: IOSFoldRuntime
  }
}

export const __private__ = { readPixels, segmentFromCss }
