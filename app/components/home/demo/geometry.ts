import { imageStageSize } from '../../../lib/image-staging'

export type StagedPhoto = {
  id: string
  index: number
  width: number
  height: number
  x: number
  slotWidth: number
}

export type StripSource = { id: string; naturalWidth: number; naturalHeight: number }
export type DemoViewport = { width: number; height: number }

export const layoutStrip = (
  sources: StripSource[],
  viewport: DemoViewport,
  dpr: number,
): StagedPhoto[] => {
  let x = 0
  return sources.map((source, index) => {
    const stagedSize = imageStageSize({
      mode: 'strip',
      naturalWidthPx: source.naturalWidth,
      naturalHeightPx: source.naturalHeight,
      stageWidthCssPx: viewport.width,
      stageHeightCssPx: viewport.height,
      dpr,
    })
    const staged = { id: source.id, index, ...stagedSize, x, slotWidth: stagedSize.width }
    x += staged.slotWidth
    return staged
  })
}

export const contentWidth = (layout: StagedPhoto[]) =>
  layout.length ? layout[layout.length - 1]!.x + layout[layout.length - 1]!.slotWidth : 0

export const endCardWidth = (viewport: DemoViewport) =>
  Math.min(360, Math.max(230, viewport.width * 0.32))

export const travelBounds = (total: number, viewportWidth: number) =>
  Math.max(0, total - viewportWidth)

export const restStops = (
  layout: StagedPhoto[],
  viewportWidth: number,
  finalCardWidth = 0,
) => {
  const bounds = travelBounds(contentWidth(layout) + finalCardWidth, viewportWidth)
  const stops = [0, bounds]
  for (const photo of layout) {
    stops.push(Math.min(Math.max(0, photo.x + photo.slotWidth / 2 - viewportWidth / 2), bounds))
  }
  return [...new Set(stops.map((stop) => Math.round(stop * 1000) / 1000))].sort((a, b) => a - b)
}

export type ContinuityAnchor = { id: string; within: number }

export const captureAnchor = (
  layout: StagedPhoto[],
  offset: number,
  viewportWidth: number,
): ContinuityAnchor | null => {
  if (!layout.length) return null
  const centre = offset + viewportWidth / 2
  const photo =
    layout.find((p) => centre >= p.x && centre < p.x + p.slotWidth) ?? layout[layout.length - 1]!
  return { id: photo.id, within: photo.slotWidth > 0 ? (centre - photo.x) / photo.slotWidth : 0 }
}

export const restoreOffset = (
  layout: StagedPhoto[],
  anchor: ContinuityAnchor | null,
  viewportWidth: number,
  bounds: number,
): number => {
  if (!layout.length || !anchor) return 0
  const photo = layout.find((p) => p.id === anchor.id)
  if (!photo) return Math.min(Math.max(0, bounds), bounds)
  const centre = photo.x + anchor.within * photo.slotWidth
  return Math.min(Math.max(0, centre - viewportWidth / 2), bounds)
}

export const positionIndex = (
  layout: StagedPhoto[],
  offset: number,
  viewportWidth: number,
) => {
  const anchor = captureAnchor(layout, offset, viewportWidth)
  return anchor ? layout.find((photo) => photo.id === anchor.id)?.index ?? 0 : 0
}
