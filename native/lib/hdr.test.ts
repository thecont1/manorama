import { describe, expect, test } from 'bun:test'
import { probeHdr, type HdrReport, type HdrVerdict } from './hdr'

const mq = (yes: string[]) => (query: string) => yes.includes(query)

const SDR: HdrReport = {
  claimsDynamicRange: false,
  claimsVideoDynamicRange: false,
  gamut: 'srgb',
  canvasSupportsP3: false,
  wideGamut: false,
  hdr: 'sdr',
}

describe('probeHdr', () => {
  test('a plain SDR display reports no headroom', () => {
    expect(probeHdr(mq([]), () => false)).toEqual(SDR)
  })

  test('claim + p3 gamut + passing canvas probe reports claimed HDR and wide gamut', () => {
    const report = probeHdr(mq(['(dynamic-range: high)', '(color-gamut: p3)']), () => true)
    expect(report.hdr).toBe('claimed')
    expect(report.gamut).toBe('p3')
    expect(report.wideGamut).toBe(true)
  })

  test('a video-plane claim alone does not enable the image verdict', () => {
    const report = probeHdr(mq(['(video-dynamic-range: high)', '(color-gamut: p3)']), () => true)
    expect(report.hdr).toBe('sdr')
    expect(report.claimsVideoDynamicRange).toBe(true)
    expect(report.claimsDynamicRange).toBe(false)
  })

  test('the WebKit #254489 case: a P3 SDR panel with a false claim is only ever claimed', () => {
    // Canvas says p3 and the media queries claim high range, yet the panel
    // has no headroom. Nothing can verify otherwise, so 'claimed' is the
    // ceiling — HdrVerdict has no verified member for this to drift into.
    const report = probeHdr(mq(['(dynamic-range: high)', '(color-gamut: p3)']), () => true)
    expect(report.claimsDynamicRange).toBe(true)
    expect(report.canvasSupportsP3).toBe(true)
    const verdict: HdrVerdict = report.hdr
    expect(verdict).toBe('claimed')
  })

  test('the canvas probe gates wide gamut, not the verdict', () => {
    const report = probeHdr(mq(['(dynamic-range: high)', '(color-gamut: p3)']), () => false)
    expect(report.hdr).toBe('claimed')
    expect(report.canvasSupportsP3).toBe(false)
    expect(report.wideGamut).toBe(false)
  })

  test('an sRGB-gamut display cannot claim HDR even when the claim fires', () => {
    const report = probeHdr(mq(['(dynamic-range: high)']), () => true)
    expect(report.hdr).toBe('sdr')
    expect(report.wideGamut).toBe(false)
  })

  test('a silent media-query layer fails closed', () => {
    const report: HdrReport = probeHdr(() => false, () => false)
    expect(report).toEqual(SDR)
  })

  test('rec2020 outranks p3', () => {
    expect(probeHdr(mq(['(color-gamut: rec2020)', '(color-gamut: p3)']), () => false).gamut).toBe(
      'rec2020',
    )
  })
})
