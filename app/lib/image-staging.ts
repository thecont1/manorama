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
  // Strip is a photostrip: neighbours must abut, so the only ceiling is
  // natural pixels — a source shorter than the stage stays small rather
  // than upscaling. Vertical and single keep the strict 1/dpr cap.
  const scale = mode === 'strip' ? Math.min(stageHeight / h, 1)
    : mode === 'vertical' ? Math.min(stageWidth / w, 1 / dpr)
    : Math.min(stageWidth / w, stageHeight / h, 1 / dpr)
  return { width: w * scale, height: h * scale }
}
