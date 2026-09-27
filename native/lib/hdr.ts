/**
 * HDR capability detection for #31. Gain-map JPEG/AVIF pass through the
 * viewer untouched — the honest check is whether the display can spend the
 * headroom. `dynamic-range: high` alone is not trusted: WebKit has reported
 * it on hardware without extended range (WebKit #254489). The verdict
 * requires the media-query claim AND a rendering probe — a canvas that can
 * actually allocate a wider-than-sRGB backing store.
 */

export type MediaQuery = (query: string) => boolean

/** True when a 2d canvas can hold a display-p3 backing store. */
export type WideGamutProbe = () => boolean

export type HdrGamut = 'srgb' | 'p3' | 'rec2020'

export type HdrReport = {
  /** The display claims extended range — untrusted on its own. */
  claimsDynamicRange: boolean
  /** Widest gamut the media queries will vouch for. */
  gamut: HdrGamut
  /** The rendering probe: a canvas was asked for display-p3 and said yes. */
  rendersWideGamut: boolean
  /** The gated verdict — claim and probe must agree. */
  hdr: boolean
}

export const probeHdr = (matchMedia: MediaQuery, wideGamut: WideGamutProbe): HdrReport => {
  const claimsDynamicRange =
    matchMedia('(dynamic-range: high)') || matchMedia('(video-dynamic-range: high)')
  const gamut: HdrGamut = matchMedia('(color-gamut: rec2020)')
    ? 'rec2020'
    : matchMedia('(color-gamut: p3)')
      ? 'p3'
      : 'srgb'
  const rendersWideGamut = wideGamut()
  return {
    claimsDynamicRange,
    gamut,
    rendersWideGamut,
    hdr: claimsDynamicRange && gamut !== 'srgb' && rendersWideGamut,
  }
}

/** The live probes — the only place this module touches the shell. */
export const probeHdrInShell = (doc: Pick<Document, 'createElement'>): HdrReport =>
  probeHdr(
    (query) => typeof matchMedia !== 'undefined' && matchMedia(query).matches,
    () => {
      const ctx = doc
        .createElement('canvas')
        .getContext('2d', { colorSpace: 'display-p3' } as CanvasRenderingContext2DSettings)
      return !!ctx && ctx.getContextAttributes?.().colorSpace === 'display-p3'
    },
  )
