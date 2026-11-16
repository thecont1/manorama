import { deviceImageDpr } from './image-staging'
import { isVideoItem, type GalleryMediaItem } from './imagesource'
import type { FoldSegment } from './fold'

export const spreadRanges = (items: readonly GalleryMediaItem[]): readonly { start: number; end: number }[] => {
  const ranges: { start: number; end: number }[] = []
  for (let start = 0; start < items.length;) {
    const end = start + (isVideoItem(items[start]) || !items[start + 1] || isVideoItem(items[start + 1]) ? 1 : 2)
    ranges.push({ start, end })
    start = end
  }
  return ranges
}

export const insetSpreadRegion = (region: FoldSegment, margin = 8): FoldSegment => ({
  x: region.x + margin,
  y: region.y + margin,
  width: Math.max(0, region.width - margin * 2),
  height: Math.max(0, region.height - margin * 2),
})

export const flatSpreadSegments = (
  frames: readonly { width: number; height: number }[],
  canvas: FoldSegment,
  dpr: number,
  gutter = 12,
): readonly FoldSegment[] => {
  if (!frames.length || frames.some(({ width, height }) => !(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0))) return []
  const ratios = frames.map(({ width, height }) => width / height)
  const gap = frames.length > 1 ? gutter : 0
  const height = Math.max(0, Math.min(
    canvas.height,
    (canvas.width - gap) / ratios.reduce((sum, ratio) => sum + ratio, 0),
    ...frames.map((frame) => frame.height / deviceImageDpr(dpr)),
  ))
  const widths = ratios.map((ratio) => height * ratio)
  let x = canvas.x + (canvas.width - widths.reduce((sum, width) => sum + width, gap)) / 2
  return widths.map((width) => {
    const segment = { x, y: canvas.y + (canvas.height - height) / 2, width, height }
    x += width + gap
    return segment
  })
}
