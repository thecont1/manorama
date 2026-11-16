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

export type FoldSizeClass = 'compact' | 'regular' | 'unspecified'
export type FoldVerticalBarEdge = 'unspecified' | 'leading' | 'trailing'
export type FoldReservedRegionKind = 'division' | 'occlusion'

export type FoldReservedRegion = {
  kind: FoldReservedRegionKind
  frame: FoldSegment
  active: boolean
}

/**
 * Platform adapters stay outside core. The browser adapter supplies viewport
 * segments only when its media queries match. UIKit supplies the web view's
 * reserved regions; an active division creates segments, while occlusions only
 * constrain controls.
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
    verticalBarEdge: FoldVerticalBarEdge
    safeAreaInsets: FoldInsets
    regions: readonly FoldReservedRegion[]
  }
}

export type FoldSource = 'chromium' | 'ios' | 'fallback'

export type FoldLayout = {
  mode: 'single' | 'diptych'
  source: FoldSource
  viewport: FoldViewport
  horizontalSizeClass: FoldSizeClass
  verticalSizeClass: FoldSizeClass
  verticalBarEdge: FoldVerticalBarEdge
  safeAreaInsets: FoldInsets
  /** The untouched physical areas available to the scrolling photograph canvas. */
  segments: readonly FoldSegment[]
  /** Safe regions for controls; the scrolling canvas is not displaced by these insets. */
  controlRegions: readonly FoldSegment[]
}

const zeroInsets: FoldInsets = { top: 0, right: 0, bottom: 0, left: 0 }
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

const area = (segment: FoldSegment): number => segment.width * segment.height

const orderedPair = (segments: readonly FoldSegment[], viewport: FoldViewport): readonly [FoldSegment, FoldSegment] | null => {
  if (segments.length !== 2 || !segments.every((segment) => withinViewport(segment, viewport))) return null
  const ordered = [...segments].sort((a, b) => a.x - b.x || a.y - b.y) as [FoldSegment, FoldSegment]
  return overlaps(ordered[0], ordered[1]) ? null : ordered
}

const chromiumSegmentPair = (segments: readonly FoldSegment[], viewport: FoldViewport): readonly [FoldSegment, FoldSegment] | null => {
  const pair = orderedPair(segments, viewport)
  if (!pair) return null
  const [first, second] = pair
  const sideBySide = first.x === 0 && first.y === 0 && second.y === 0 &&
    first.height === viewport.height && second.height === viewport.height &&
    second.x > first.x + first.width
  const stacked = first.x === 0 && second.x === 0 && first.y === 0 &&
    first.width === viewport.width && second.width === viewport.width &&
    second.y > first.y + first.height
  return sideBySide || stacked ? pair : null
}

const intersection = (a: FoldSegment, b: FoldSegment): FoldSegment => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

const withoutOcclusion = (segment: FoldSegment, occlusion: FoldSegment): FoldSegment => {
  if (!overlaps(segment, occlusion)) return segment
  const right = segment.x + segment.width
  const bottom = segment.y + segment.height
  const occlusionRight = occlusion.x + occlusion.width
  const occlusionBottom = occlusion.y + occlusion.height
  const candidates: FoldSegment[] = [
    { x: segment.x, y: segment.y, width: Math.max(0, occlusion.x - segment.x), height: segment.height },
    { x: Math.min(right, occlusionRight), y: segment.y, width: Math.max(0, right - occlusionRight), height: segment.height },
    { x: segment.x, y: segment.y, width: segment.width, height: Math.max(0, occlusion.y - segment.y) },
    { x: segment.x, y: Math.min(bottom, occlusionBottom), width: segment.width, height: Math.max(0, bottom - occlusionBottom) },
  ]
  return candidates.reduce((largest, candidate) => area(candidate) > area(largest) ? candidate : largest, {
    x: segment.x,
    y: segment.y,
    width: 0,
    height: 0,
  })
}

const controlRegions = (
  segments: readonly FoldSegment[],
  viewport: FoldViewport,
  insets: FoldInsets,
  occlusions: readonly FoldReservedRegion[] = [],
): readonly FoldSegment[] => {
  const safeRect: FoldSegment = {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  }
  const activeOcclusions = occlusions
    .filter((region) => region.kind === 'occlusion' && region.active && withinViewport(region.frame, viewport))
    .map((region) => region.frame)
  return segments.map((segment) => activeOcclusions.reduce(
    (region, occlusion) => withoutOcclusion(region, occlusion),
    intersection(segment, safeRect),
  ))
}

const segmentsFromDivision = (
  viewport: FoldViewport,
  region: FoldReservedRegion,
): readonly FoldSegment[] | null => {
  const frame = region.frame
  if (!withinViewport(frame, viewport)) return null
  if (frame.height >= frame.width) {
    if (frame.x <= 0 || frame.x + frame.width >= viewport.width || frame.y !== 0 || frame.height !== viewport.height) return null
    return [
      { x: 0, y: 0, width: frame.x, height: viewport.height },
      { x: frame.x + frame.width, y: 0, width: viewport.width - frame.x - frame.width, height: viewport.height },
    ]
  }
  if (frame.y <= 0 || frame.y + frame.height >= viewport.height || frame.x !== 0 || frame.width !== viewport.width) return null
  return [
    { x: 0, y: 0, width: viewport.width, height: frame.y },
    { x: 0, y: frame.y + frame.height, width: viewport.width, height: viewport.height - frame.y - frame.height },
  ]
}

const layout = (
  mode: FoldLayout['mode'],
  source: FoldSource,
  viewport: FoldViewport,
  segments: readonly FoldSegment[],
  ios: FoldDetectionInput['ios'],
): FoldLayout => {
  const safeAreaInsets = normalizedInsets(ios?.safeAreaInsets, viewport)
  return {
    mode,
    source,
    viewport,
    horizontalSizeClass: ios?.horizontalSizeClass ?? 'unspecified',
    verticalSizeClass: ios?.verticalSizeClass ?? 'unspecified',
    verticalBarEdge: ios?.verticalBarEdge ?? 'unspecified',
    safeAreaInsets,
    segments,
    controlRegions: controlRegions(segments, viewport, safeAreaInsets, ios?.regions),
  }
}

const singleLayout = (viewport: FoldViewport, source: FoldSource, ios?: FoldDetectionInput['ios']): FoldLayout =>
  layout('single', source, viewport, [{ x: 0, y: 0, width: viewport.width, height: viewport.height }], ios)

/**
 * A native snapshot is authoritative whenever present, including its flat and
 * inactive-division states. Malformed geometry therefore falls back to one
 * segment instead of letting a contradictory browser API split the canvas.
 */
export const resolveFoldLayout = (input: FoldDetectionInput): FoldLayout => {
  const viewport = usableViewport(input.viewport)
  if (!finitePositive(viewport.width) || !finitePositive(viewport.height)) {
    return singleLayout(viewport, 'fallback', input.ios)
  }

  if (input.ios) {
    const divisions = input.ios.regions.filter((region) => region.kind === 'division' && region.active)
    if (divisions.length === 1) {
      const segments = divisions[0] ? segmentsFromDivision(viewport, divisions[0]) : null
      const pair = segments ? orderedPair(segments, viewport) : null
      if (pair) return layout('diptych', 'ios', viewport, pair, input.ios)
    }
    return singleLayout(viewport, 'ios', input.ios)
  }

  const chromiumFoldPair = input.chromium?.mediaQueryMatches
    ? chromiumSegmentPair(input.chromium.segments, viewport)
    : null
  if (chromiumFoldPair) {
    return layout('diptych', 'chromium', viewport, chromiumFoldPair, undefined)
  }

  return singleLayout(viewport, 'fallback')
}

export const __private__ = { orderedPair, segmentsFromDivision, normalizedInsets, controlRegions, zeroInsets }
