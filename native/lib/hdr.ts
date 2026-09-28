/**
 * HDR capability detection for #31. Gain-map JPEG/AVIF pass through the
 * viewer untouched, so this module only reports what the shell claims —
 * it cannot verify anything. `dynamic-range: high` is untrusted: WebKit
 * has reported it on hardware without the headroom (WebKit #254489), and
 * no web API measures luminance headroom to prove it wrong.
 * `video-dynamic-range: high` describes the video plane, not the display,
 * so it is reported separately and never feeds the verdict. The display-p3
 * canvas probe only proves a wide-gamut backing store can be allocated,
 * which WebKit grants on sRGB panels too; it gates `wideGamut`, never the
 * verdict. The verdict is therefore at most 'claimed': callers must not
 * present an affordance that asserts HDR on that alone. A gain-map image
 * degrades to its SDR base safely either way.
 */

export type MediaQuery = (query: string) => boolean

/** True when a 2d canvas can hold a display-p3 backing store. */
export type CanvasP3Probe = () => boolean

export type HdrGamut = 'srgb' | 'p3' | 'rec2020'

/** 'claimed' = the media queries assert extended range; nothing on the web can confirm the headroom. */
export type HdrVerdict = 'sdr' | 'claimed'

export type HdrReport = {
  /** The display claims extended range — untrusted on its own. */
  claimsDynamicRange: boolean
  /** The video plane claims extended range — never used for the image verdict. */
  claimsVideoDynamicRange: boolean
  /** Widest gamut the media queries will vouch for. */
  gamut: HdrGamut
  /** A canvas capability, not display proof — WebKit grants p3 backing stores on sRGB panels. */
  canvasSupportsP3: boolean
  /** Gamut claim backed by a canvas that can actually hold it. */
  wideGamut: boolean
  /** At most 'claimed' — headroom cannot be measured on the web. */
  hdr: HdrVerdict
}

export const probeHdr = (matchMedia: MediaQuery, canvasP3: CanvasP3Probe): HdrReport => {
  const claimsDynamicRange = matchMedia('(dynamic-range: high)')
  const claimsVideoDynamicRange = matchMedia('(video-dynamic-range: high)')
  const gamut: HdrGamut = matchMedia('(color-gamut: rec2020)')
    ? 'rec2020'
    : matchMedia('(color-gamut: p3)')
      ? 'p3'
      : 'srgb'
  const canvasSupportsP3 = canvasP3()
  return {
    claimsDynamicRange,
    claimsVideoDynamicRange,
    gamut,
    canvasSupportsP3,
    wideGamut: gamut !== 'srgb' && canvasSupportsP3,
    hdr: claimsDynamicRange && gamut !== 'srgb' ? 'claimed' : 'sdr',
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
