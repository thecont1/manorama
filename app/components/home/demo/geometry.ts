/**
 * Demo geometry: staging, travel bounds and the continuity anchor.
 *
 * Pure and platform-free so it can be unit-tested against the real sequence.
 * Staging reuses the production viewer's own sizing helper (`imageStageSize`,
 * strip mode) so a frame is never cropped, stretched or enlarged past the
 * pixels its served rendition actually carries.
 */
import { imageStageSize } from '../../../lib/image-staging'
import type { DemoPreset } from './presets'

export type StagedPhoto = {
  id: string
  index: number
  /** Rendered CSS size at the current stage height and dpr. */
  width: number
  height: number
  /** Left edge in strip-content coordinates. Frames abut: no gaps. */
  x: number
}

export type StripSource = { id: string; naturalWidth: number; naturalHeight: number }

/** The frame's inner box: the logical viewport contained in the reserved
 *  stage, minus the bezel. */
export const frameInnerBox = (preset: DemoPreset, stage: { width: number; height: number }) => {
  const scale = Math.min(stage.width / preset.logical.width, stage.height / preset.logical.height)
  const outerWidth = preset.logical.width * scale
  const outerHeight = preset.logical.height * scale
  return {
    outerWidth,
    outerHeight,
    width: Math.max(0, outerWidth - preset.bezel * 2),
    height: Math.max(0, outerHeight - preset.bezel * 2),
  }
}

/** Stage every frame at the strip's height, abutting edge-to-edge. */
export const layoutStrip = (
  sources: StripSource[],
  innerHeight: number,
  dpr: number,
): StagedPhoto[] => {
  let x = 0
  return sources.map((source, index) => {
    const { width, height } = imageStageSize({
      mode: 'strip',
      naturalWidthPx: source.naturalWidth,
      naturalHeightPx: source.naturalHeight,
      // Strip fits height; the width bound is deliberately not the constraint.
      stageWidthCssPx: 1_000_000,
      stageHeightCssPx: innerHeight,
      dpr,
    })
    const staged = { id: source.id, index, width, height, x }
    x += width
    return staged
  })
}

export const contentWidth = (layout: StagedPhoto[]) =>
  layout.length ? layout[layout.length - 1]!.x + layout[layout.length - 1]!.width : 0

/** How far the strip can travel. A sequence shorter than the viewport has no
 *  travel: the composition is stable and empty space is never animated. */
export const travelBounds = (total: number, viewportWidth: number) =>
  Math.max(0, total - viewportWidth)

export type ContinuityAnchor = { id: string; within: number }

/** Anchor on the photograph at the viewport's centre and the position within
 *  it — not a raw pixel offset or percentage — so a relayout keeps the same
 *  photograph in view. */
export const captureAnchor = (
  layout: StagedPhoto[],
  offset: number,
  viewportWidth: number,
): ContinuityAnchor | null => {
  if (!layout.length) return null
  const centre = offset + viewportWidth / 2
  const photo =
    layout.find((p) => centre >= p.x && centre < p.x + p.width) ?? layout[layout.length - 1]!
  return { id: photo.id, within: photo.width > 0 ? (centre - photo.x) / photo.width : 0 }
}

/** Restore the anchor into a new layout and clamp to the new bounds. */
export const restoreOffset = (
  layout: StagedPhoto[],
  anchor: ContinuityAnchor | null,
  viewportWidth: number,
  bounds: number,
): number => {
  if (!layout.length || !anchor) return 0
  const photo = layout.find((p) => p.id === anchor.id)
  if (!photo) return Math.min(Math.max(0, bounds), bounds)
  const centre = photo.x + anchor.within * photo.width
  return Math.min(Math.max(0, centre - viewportWidth / 2), bounds)
}