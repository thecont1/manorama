import { describe, expect, test } from 'bun:test'
import { VIDEO_STRIP_MAX_STAGE_HEIGHT, VIDEO_VERTICAL_MAX_STAGE_WIDTH, effectiveImageDpr, imageStageSize, videoStageSize } from './image-staging'

const STAGE = { stageWidthCssPx: 1440, stageHeightCssPx: 900 }
const EPSILON = 1e-6

const SHAPES = [
  ['landscape', 2400, 1600],
  ['portrait', 1600, 2400],
  ['square', 1600, 1600],
  ['panorama', 8000, 1000],
  ['tiny', 120, 80],
] as const

const DPRS = [1, 1.5, 2, 3]
const MODES = ['strip', 'vertical', 'single'] as const

const size = (mode: (typeof MODES)[number], w: number, h: number, dpr?: number) =>
  imageStageSize({ mode, naturalWidthPx: w, naturalHeightPx: h, ...STAGE, dpr })

const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(EPSILON)

describe('effectiveImageDpr', () => {
  test('passes 1x and 1.5x through, keeps 2x, caps 3x at 2x', () => {
    const expected = [1, 1.5, 2, 2]
    DPRS.forEach((dpr, i) => expect(effectiveImageDpr(dpr)).toBe(expected[i]))
  })

  test('zero, negative, NaN, Infinity and undefined fall back to 1', () => {
    for (const dpr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(effectiveImageDpr(dpr)).toBe(1)
    }
  })
})

describe('imageStageSize in strip mode fits height-first', () => {
  // The photostrip fills height-first and abuts edge-to-edge, but the
  // same device-pixel budget as every other mode applies: a source short
  // on pixels renders at natural/dpr rather than fabricating them.
  for (const dpr of DPRS) {
    const eff = Math.min(dpr, 2)
    for (const [name, w, h] of SHAPES) {
      test(`${name} ${w}x${h} at ${dpr}x`, () => {
        const result = size('strip', w, h, dpr)
        const expectedHeight = Math.min(STAGE.stageHeightCssPx, h / eff)
        near(result.height, expectedHeight)
        near(result.width, expectedHeight * (w / h))
      })
    }
  }

  test('the stage width plays no role', () => {
    for (const [, w, h] of SHAPES) {
      const result = imageStageSize({ mode: 'strip', naturalWidthPx: w, naturalHeightPx: h, stageWidthCssPx: 0, stageHeightCssPx: STAGE.stageHeightCssPx, dpr: 1 })
      near(result.height, Math.min(STAGE.stageHeightCssPx, h))
      near(result.width, result.height * (w / h))
    }
  })
})

describe('imageStageSize in vertical mode fits width-first', () => {
  for (const dpr of DPRS) {
    for (const [name, w, h] of SHAPES) {
      test(`${name} ${w}x${h} at ${dpr}x`, () => {
        const eff = Math.min(dpr, 2)
        const result = size('vertical', w, h, dpr)
        const expectedWidth = Math.min(STAGE.stageWidthCssPx, w / eff)
        near(result.width, expectedWidth)
        near(result.height, expectedWidth * (h / w))
      })
    }
  }

  test('a portrait may run taller than the viewport — no height cap', () => {
    const result = size('vertical', 1600, 2400, 1)
    expect(result.width).toBe(STAGE.stageWidthCssPx)
    near(result.height, 2160)
    expect(result.height).toBeGreaterThan(STAGE.stageHeightCssPx)
  })
})

describe('imageStageSize in single mode contains both axes', () => {
  for (const dpr of DPRS) {
    for (const [name, w, h] of SHAPES) {
      test(`${name} ${w}x${h} at ${dpr}x`, () => {
        const eff = Math.min(dpr, 2)
        const result = size('single', w, h, dpr)
        const scale = Math.min(STAGE.stageWidthCssPx / w, STAGE.stageHeightCssPx / h, 1 / eff)
        near(result.width, w * scale)
        near(result.height, h * scale)
        expect(result.width).toBeLessThanOrEqual(STAGE.stageWidthCssPx + EPSILON)
        expect(result.height).toBeLessThanOrEqual(STAGE.stageHeightCssPx + EPSILON)
      })
    }
  }
})

describe('imageStageSize never upscales', () => {
  test('display px multiplied by effective dpr stays within natural px', () => {
    // Strict device-pixel parity holds in every mode: the strip keeps its
    // edge-to-edge contact but never claims pixels the source lacks.
    for (const mode of MODES) {
      for (const dpr of DPRS) {
        const eff = Math.min(dpr, 2)
        for (const [, w, h] of SHAPES) {
          const result = size(mode, w, h, dpr)
          expect(result.width * eff).toBeLessThanOrEqual(w + EPSILON)
          expect(result.height * eff).toBeLessThanOrEqual(h + EPSILON)
        }
      }
    }
  })

  test('strip display px never exceeds natural px', () => {
    for (const dpr of DPRS) {
      for (const [, w, h] of SHAPES) {
        const result = size('strip', w, h, dpr)
        expect(result.width).toBeLessThanOrEqual(w + EPSILON)
        expect(result.height).toBeLessThanOrEqual(h + EPSILON)
      }
    }
  })

  test('dpr 3 renders identically to dpr 2', () => {
    for (const mode of MODES) {
      for (const [, w, h] of SHAPES) {
        expect(size(mode, w, h, 3)).toEqual(size(mode, w, h, 2))
      }
    }
  })
})

describe('imageStageSize guards invalid input', () => {
  test('zero, negative, NaN and infinite source dims return 0x0', () => {
    const bad = [[0, 1600], [2400, 0], [-2400, 1600], [2400, -1600], [Number.NaN, 1600], [2400, Number.NaN], [Number.POSITIVE_INFINITY, 1600], [2400, Number.POSITIVE_INFINITY]]
    for (const [w, h] of bad) {
      for (const mode of MODES) {
        expect(size(mode, w, h, 1)).toEqual({ width: 0, height: 0 })
      }
    }
  })

  test('a non-finite or negative stage clamps to 0', () => {
    for (const stage of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(imageStageSize({ mode: 'vertical', naturalWidthPx: 2400, naturalHeightPx: 1600, stageWidthCssPx: stage, stageHeightCssPx: STAGE.stageHeightCssPx, dpr: 1 })).toEqual({ width: 0, height: 0 })
      expect(imageStageSize({ mode: 'strip', naturalWidthPx: 2400, naturalHeightPx: 1600, stageWidthCssPx: STAGE.stageWidthCssPx, stageHeightCssPx: stage, dpr: 1 })).toEqual({ width: 0, height: 0 })
      expect(imageStageSize({ mode: 'single', naturalWidthPx: 2400, naturalHeightPx: 1600, stageWidthCssPx: stage, stageHeightCssPx: stage, dpr: 1 })).toEqual({ width: 0, height: 0 })
    }
  })

  test('an invalid dpr falls back to 1', () => {
    for (const dpr of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      for (const mode of MODES) {
        expect(size(mode, 2400, 1600, dpr)).toEqual(size(mode, 2400, 1600, 1))
      }
    }
  })
})

describe('videoStageSize caps desktop video against the stage', () => {
  const SHAPES_V = [
    ['landscape', 1920, 1080],
    ['portrait', 1080, 1920],
    ['square', 1000, 1000],
    ['ultrawide', 4000, 1000],
    ['tiny', 160, 90],
  ] as const

  test('strip mode holds every shape to exactly 70% of stage height', () => {
    for (const [, w, h] of SHAPES_V) {
      const r = videoStageSize({ mode: 'strip', naturalWidthPx: w, naturalHeightPx: h, ...STAGE, isDesktop: true })
      expect(r.capped).toBe(true)
      near(r.height, STAGE.stageHeightCssPx * 0.7)
      // Aspect ratio survives the cap.
      near(r.width / r.height, w / h)
    }
  })

  test('vertical mode holds every shape to exactly 60% of stage width', () => {
    for (const [, w, h] of SHAPES_V) {
      const r = videoStageSize({ mode: 'vertical', naturalWidthPx: w, naturalHeightPx: h, ...STAGE, isDesktop: true })
      expect(r.capped).toBe(true)
      near(r.width, STAGE.stageWidthCssPx * 0.6)
      near(r.width / r.height, w / h)
    }
  })

  test('the caps are the advertised constants', () => {
    expect(VIDEO_STRIP_MAX_STAGE_HEIGHT).toBe(0.7)
    expect(VIDEO_VERTICAL_MAX_STAGE_WIDTH).toBe(0.6)
  })

  test('mobile is exempt in both capped modes', () => {
    for (const mode of ['strip', 'vertical'] as const) {
      const r = videoStageSize({ mode, naturalWidthPx: 1920, naturalHeightPx: 1080, ...STAGE, isDesktop: false })
      expect(r.capped).toBe(false)
    }
  })

  test('single mode is never capped, desktop or not', () => {
    for (const isDesktop of [true, false]) {
      const r = videoStageSize({ mode: 'single', naturalWidthPx: 1920, naturalHeightPx: 1080, ...STAGE, isDesktop })
      expect(r.capped).toBe(false)
    }
  })

  test('a capped strip video leaves room above and below to centre in', () => {
    const r = videoStageSize({ mode: 'strip', naturalWidthPx: 1920, naturalHeightPx: 1080, ...STAGE, isDesktop: true })
    expect(r.height).toBeLessThan(STAGE.stageHeightCssPx)
    expect(STAGE.stageHeightCssPx - r.height).toBeGreaterThan(0)
  })

  test('a capped vertical video never exceeds the stage width', () => {
    const r = videoStageSize({ mode: 'vertical', naturalWidthPx: 1080, naturalHeightPx: 1920, ...STAGE, isDesktop: true })
    expect(r.width).toBeLessThan(STAGE.stageWidthCssPx)
  })

  test('degenerate intrinsic sizes fall back instead of producing NaN', () => {
    const bad: [number, number][] = [[0, 0], [1920, 0], [0, 1080], [-100, 50], [Number.NaN, 100], [Number.POSITIVE_INFINITY, 100]]
    for (const [w, h] of bad) {
      for (const mode of ['strip', 'vertical'] as const) {
        const r = videoStageSize({ mode, naturalWidthPx: w, naturalHeightPx: h, ...STAGE, isDesktop: true })
        expect(r.capped).toBe(false)
        expect(Number.isNaN(r.width)).toBe(false)
        expect(Number.isNaN(r.height)).toBe(false)
      }
    }
  })

  test('an unmeasured stage falls back rather than collapsing the frame', () => {
    const strip = videoStageSize({ mode: 'strip', naturalWidthPx: 1920, naturalHeightPx: 1080, stageWidthCssPx: 1440, stageHeightCssPx: 0, isDesktop: true })
    expect(strip.capped).toBe(false)
    const vert = videoStageSize({ mode: 'vertical', naturalWidthPx: 1920, naturalHeightPx: 1080, stageWidthCssPx: 0, stageHeightCssPx: 900, isDesktop: true })
    expect(vert.capped).toBe(false)
    const nan = videoStageSize({ mode: 'strip', naturalWidthPx: 1920, naturalHeightPx: 1080, stageWidthCssPx: Number.NaN, stageHeightCssPx: Number.NaN, isDesktop: true })
    expect(nan.capped).toBe(false)
  })

  test('the cap scales with the stage, not with a fixed pixel count', () => {
    const small = videoStageSize({ mode: 'strip', naturalWidthPx: 1920, naturalHeightPx: 1080, stageWidthCssPx: 1000, stageHeightCssPx: 500, isDesktop: true })
    const big = videoStageSize({ mode: 'strip', naturalWidthPx: 1920, naturalHeightPx: 1080, stageWidthCssPx: 2000, stageHeightCssPx: 1000, isDesktop: true })
    near(small.height, 350)
    near(big.height, 700)
  })
})
