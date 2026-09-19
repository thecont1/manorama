export type ImageStageMode = 'strip' | 'vertical' | 'single'

export const effectiveImageDpr = (dpr: number | undefined) => Math.min(dpr && Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 2)

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
  const scale = mode === 'strip' ? Math.min(stageHeight / h, 1 / dpr)
    : mode === 'vertical' ? Math.min(stageWidth / w, 1 / dpr)
    : Math.min(stageWidth / w, stageHeight / h, 1 / dpr)
  return { width: w * scale, height: h * scale }
}
