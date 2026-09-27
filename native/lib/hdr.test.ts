import { describe, expect, test } from 'bun:test'
import { probeHdr, type HdrReport } from './hdr'

const mq = (yes: string[]) => (query: string) => yes.includes(query)

const SDR = { claimsDynamicRange: false, gamut: 'srgb', rendersWideGamut: false, hdr: false }

describe('probeHdr', () => {
  test('a plain SDR display reports no headroom', () => {
    expect(probeHdr(mq([]), () => false)).toEqual(SDR)
  })

  test('claim + p3 gamut + passing render probe means HDR', () => {
    const report = probeHdr(mq(['(dynamic-range: high)', '(color-gamut: p3)']), () => true)
    expect(report.hdr).toBe(true)
    expect(report.gamut).toBe('p3')
  })

  test('video-dynamic-range alone still counts as the claim', () => {
    expect(probeHdr(mq(['(video-dynamic-range: high)', '(color-gamut: p3)']), () => true).hdr).toBe(true)
  })

  test('the WebKit false positive: claim without a passing probe is not HDR', () => {
    const report = probeHdr(mq(['(dynamic-range: high)', '(color-gamut: p3)']), () => false)
    expect(report.claimsDynamicRange).toBe(true)
    expect(report.hdr).toBe(false)
  })

  test('an sRGB-gamut display cannot be HDR even when the claim fires', () => {
    expect(probeHdr(mq(['(dynamic-range: high)']), () => true).hdr).toBe(false)
  })

  test('a silent media-query layer fails closed', () => {
    const report: HdrReport = probeHdr(() => false, () => false)
    expect(report.hdr).toBe(false)
  })

  test('rec2020 outranks p3', () => {
    expect(probeHdr(mq(['(color-gamut: rec2020)', '(color-gamut: p3)']), () => false).gamut).toBe('rec2020')
  })
})
