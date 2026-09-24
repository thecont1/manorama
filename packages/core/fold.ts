export type FoldViewport = {
  width: number
  height: number
}

export type FoldInsets = {
  top: number
  right: number
  bottom: number
  left: number
}

export type FoldSegment = {
  x: number
  y: number
  width: number
  height: number
}

export type FoldAxis = 'vertical' | 'horizontal'
export type FoldSizeClass = 'compact' | 'regular'

/**
 * Platform adapters stay outside core. A Chromium adapter supplies the result
 * of `matchMedia('(horizontal-viewport-segments: 2)')` and the two rectangles
 * read from the viewport-segment CSS environment variables. An iOS adapter
 * supplies UIKit size-class/safe-area information and an optional hinge.
 */
export type FoldDetectionInput = {
  viewport: FoldViewport
  chromium?: {
    mediaQueryMatches: boolean
    segments: readonly FoldSegment[]
  }
  ios?: {
    horizontalSizeClass: FoldSizeClass
    verticalSizeClass: FoldSizeClass
    safeAreaInsets: FoldInsets
    hinge?: {
      axis: FoldAxis
      start: number
      size: number
    }
  }
}

export type FoldSource = 'chromium' | 'ios' | 'fallback'

export type FoldLayout = {
  mode: 'single' | 'diptych'
  source: FoldSource
  viewport: FoldViewport
  /** The untouched physical areas available to the scrolling photograph canvas. */
  segments: readonly FoldSegment[]
  /** Safe regions for controls; the scrolling canvas is not displaced by these insets. */
  controlRegions: readonly FoldSegment[]
}

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0
const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

const usableViewport = (viewport: FoldViewport): FoldViewport => ({
  width: finitePositive(viewport.width) ? viewport.width : 0,
  height: finitePositive(viewport.height) ? viewport.height : 0,
})

const normalizedInsets = (insets: FoldInsets | undefined, viewport: FoldViewport): FoldInsets => {
  const top = finiteNonNegative(insets?.top ?? 0) ? insets?.top ?? 0 : 0
  const right = finiteNonNegative(insets?.right ?? 0) ? insets?.right ?? 0 : 0
  const bottom = finiteNonNegative(insets?.bottom ?? 0) ? insets?.bottom ?? 0 : 0
  const left = finiteNonNegative(insets?.left ?? 0) ? insets?.left ?? 0 : 0
  return {
    top: Math.min(top, viewport.height),
    right: Math.min(right, viewport.width),
    bottom: Math.min(bottom, viewport.height),
    left: Math.min(left, viewport.width),
  }
}

const withinViewport = (segment: FoldSegment, viewport: FoldViewport): boolean =>
  finiteNonNegative(segment.x) && finiteNonNegative(segment.y) &&
  finitePositive(segment.width) && finitePositive(segment.height) &&
  segment.x + segment.width <= viewport.width && segment.y + segment.height <= viewport.height

const overlaps = (a: FoldSegment, b: FoldSegment): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width &&
  a.y < b.y + b.height && b.y < a.y + a.height

const orderedPair = (segments: readonly FoldSegment[], viewport: FoldViewport): readonly [FoldSegment, FoldSegment] | null => {
  if (segments.length !== 2 || !segments.every((segment) => withinViewport(segment, viewport))) return null
  const ordered = [...segments].sort((a, b) => a.x - b.x || a.y - b.y) as [FoldSegment, FoldSegment]
  return overlaps(ordered[0], ordered[1]) ? null : ordered
}

const chromiumSegmentPair = (segments: readonly FoldSegment[], viewport: FoldViewport): readonly [FoldSegment, FoldSegment] | null => {
  const pair = orderedPair(segments, viewport)
  if (!pair) return null
  const [left, right] = pair
  return left.x === 0 && left.y === 0 && right.y === 0 &&
    left.height === viewport.height && right.height === viewport.height &&
    right.x > left.x + left.width
    ? pair
    : null
}

const insetRegion = (segment: FoldSegment, insets: FoldInsets): FoldSegment => {
  const left = Math.min(insets.left, segment.width)
  const right = Math.min(insets.right, Math.max(0, segment.width - left))
  const top = Math.min(insets.top, segment.height)
  const bottom = Math.min(insets.bottom, Math.max(0, segment.height - top))
  return {
    x: segment.x + left,
    y: segment.y + top,
    width: Math.max(0, segment.width - left - right),
    height: Math.max(0, segment.height - top - bottom),
  }
}

const controlRegions = (segments: readonly FoldSegment[], insets: FoldInsets): readonly FoldSegment[] =>
  segments.map((segment) => insetRegion(segment, insets))

const segmentsFromHinge = (
  viewport: FoldViewport,
  hinge: NonNullable<NonNullable<FoldDetectionInput['ios']>['hinge']>,
): readonly FoldSegment[] | null => {
  if (!finiteNonNegative(hinge.start) || !finitePositive(hinge.size)) return null
  if (hinge.axis === 'vertical') {
    if (hinge.start <= 0 || hinge.start + hinge.size >= viewport.width) return null
    return [
      { x: 0, y: 0, width: hinge.start, height: viewport.height },
      { x: hinge.start + hinge.size, y: 0, width: viewport.width - hinge.start - hinge.size, height: viewport.height },
    ]
  }
  if (hinge.start <= 0 || hinge.start + hinge.size >= viewport.height) return null
  return [
    { x: 0, y: 0, width: viewport.width, height: hinge.start },
    { x: 0, y: hinge.start + hinge.size, width: viewport.width, height: viewport.height - hinge.start - hinge.size },
  ]
}

const singleLayout = (viewport: FoldViewport, source: FoldSource, insets?: FoldInsets): FoldLayout => {
  const segment = { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const safeInsets = normalizedInsets(insets, viewport)
  return {
    mode: 'single',
    source,
    viewport,
    segments: [segment],
    controlRegions: controlRegions([segment], safeInsets),
  }
}

/**
 * Resolves fold geometry without touching a platform API. A false Chromium
 * media-query result or an incomplete iOS hinge snapshot conservatively falls
 * back to one segment. The photograph canvas keeps physical segments; only
 * controls are inset into their safe region.
 */
export const resolveFoldLayout = (input: FoldDetectionInput): FoldLayout => {
  const viewport = usableViewport(input.viewport)
  if (!finitePositive(viewport.width) || !finitePositive(viewport.height)) {
    return singleLayout(viewport, 'fallback')
  }

  const chromiumFoldPair = input.chromium?.mediaQueryMatches
    ? chromiumSegmentPair(input.chromium.segments, viewport)
    : null
  if (chromiumFoldPair) {
    return {
      mode: 'diptych',
      source: 'chromium',
      viewport,
      segments: chromiumFoldPair,
      controlRegions: controlRegions(chromiumFoldPair, { top: 0, right: 0, bottom: 0, left: 0 }),
    }
  }

  const ios = input.ios
  const iosSegments = ios?.horizontalSizeClass === 'regular' && ios.hinge
    ? segmentsFromHinge(viewport, ios.hinge)
    : null
  const iosPair = iosSegments ? orderedPair(iosSegments, viewport) : null
  if (iosPair) {
    return {
      mode: 'diptych',
      source: 'ios',
      viewport,
      segments: iosPair,
      controlRegions: controlRegions(iosPair, normalizedInsets(ios?.safeAreaInsets, viewport)),
    }
  }

  return singleLayout(viewport, ios ? 'ios' : 'fallback', ios?.safeAreaInsets)
}

export const __private__ = { orderedPair, segmentsFromHinge, normalizedInsets }
