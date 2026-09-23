export type ImageStageMode = 'strip' | 'vertical' | 'single'

/** Normalizes invalid device-pixel ratios to 1 and caps valid ratios at 2. */
export const effectiveImageDpr = (dpr: number | undefined) => Math.min(dpr && Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 2)

/** Computes aspect-ratio-preserving CSS dimensions for a still image. Strip
 *  mode fits stage height, vertical mode fits stage width, and single mode
 *  contains both axes; no mode requests more pixels than the source provides. */
export const imageStageSize = (input: {
  mode: ImageStageMode
  naturalWidthPx: number
  naturalHeightPx: number
  stageWidthCssPx: number
  stageHeightCssPx: number
  dpr?: number
}) => {
  const { mode, naturalWidthPx: w, naturalHeightPx: h } = input
  const stageWidth = Math.max(0, Number.isFinite(input.stageWidthCssPx) ? input.stageWidthCssPx : 0)
  const stageHeight = Math.max(0, Number.isFinite(input.stageHeightCssPx) ? input.stageHeightCssPx : 0)
  const dpr = effectiveImageDpr(input.dpr)
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return { width: 0, height: 0 }
  // Strip is still a photostrip — neighbours abut edge-to-edge — but it
  // honors the same device-pixel budget as every other mode: a source
  // without the pixels for a full-height render at this density floats
  // shorter and centred rather than fabricating pixels. Hi-res sources
  // are unaffected (stageHeight/h is already the tighter bound), so a
  // mixed folder blends seamlessly.
  const scale = mode === 'strip' ? Math.min(stageHeight / h, 1 / dpr)
    : mode === 'vertical' ? Math.min(stageWidth / w, 1 / dpr)
    : Math.min(stageWidth / w, stageHeight / h, 1 / dpr)
  return { width: w * scale, height: h * scale }
}

/** Moving pictures are not photographs: a clip running at full stage height
 *  dominates the gallery and reads as a different kind of object. On a
 *  desktop screen a video is therefore held to a fraction of the viewport —
 *  70% of its height in the horizontal strip, 60% of its width in vertical
 *  scroll — and centred in the empty space that leaves. */
export const VIDEO_STRIP_MAX_STAGE_HEIGHT = 0.7
export const VIDEO_VERTICAL_MAX_STAGE_WIDTH = 0.6

export type VideoStageSize = { width: number; height: number; capped: boolean }

/** The uncapped result: the caller keeps whatever sizing it already used. */
const UNCAPPED: VideoStageSize = { width: 0, height: 0, capped: false }

/**
 * Aspect-ratio-preserving CSS dimensions for a *video* frame.
 *
 * `capped: false` means "no rule applies — size this frame the way you
 * always did", which is the honest answer for phones and tablets (the
 * restraint is a desktop rule only), for single-image mode (which has no
 * such rule), and for any input we cannot measure.
 *
 * The caps are one-sided on purpose, matching each mode's own geometry:
 * strip mode fits height and lets wide frames run past the stage edge
 * (that is what a photostrip does), vertical mode fits width and lets tall
 * frames run past the fold. Small clips are *not* clamped to their natural
 * size — a video already fills its frame today, so honouring the cap
 * exactly keeps every clip in a mode the same height (or width) instead of
 * making low-resolution sources jump around.
 */
export const videoStageSize = (input: {
  mode: ImageStageMode
  naturalWidthPx: number
  naturalHeightPx: number
  stageWidthCssPx: number
  stageHeightCssPx: number
  isDesktop: boolean
}): VideoStageSize => {
  const { mode, naturalWidthPx: w, naturalHeightPx: h } = input
  // Phones and tablets keep the full-bleed treatment.
  if (!input.isDesktop) return UNCAPPED
  // Single-image mode already shows one thing at a time; no cap was asked
  // for and shrinking it there would just add letterboxing.
  if (mode !== 'strip' && mode !== 'vertical') return UNCAPPED
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return UNCAPPED

  const stageWidth = Number.isFinite(input.stageWidthCssPx) ? Math.max(0, input.stageWidthCssPx) : 0
  const stageHeight = Number.isFinite(input.stageHeightCssPx) ? Math.max(0, input.stageHeightCssPx) : 0

  if (mode === 'strip') {
    // Before the stage has been measured there is nothing to take a
    // fraction of; fall back rather than collapse the frame to zero.
    if (!(stageHeight > 0)) return UNCAPPED
    const height = stageHeight * VIDEO_STRIP_MAX_STAGE_HEIGHT
    return { width: w * (height / h), height, capped: true }
  }

  if (!(stageWidth > 0)) return UNCAPPED
  const width = stageWidth * VIDEO_VERTICAL_MAX_STAGE_WIDTH
  return { width, height: h * (width / w), capped: true }
}
