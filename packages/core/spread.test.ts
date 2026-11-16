import { describe, expect, test } from 'bun:test'
import { flatSpreadSegments, insetSpreadRegion, spreadRanges } from './spread'
import type { GalleryMediaItem } from './imagesource'

const canvas = { x: 0, y: 0, width: 951, height: 669 }

describe('flat photographic spreads', () => {
  for (const [name, dimensions] of [
    ['portrait pair', [[1800, 2700], [2400, 3600]]],
    ['landscape pair', [[3600, 2400], [3000, 2000]]],
    ['mixed pair', [[3600, 2400], [1200, 1800]]],
    ['small first', [[180, 120], [2400, 3600]]],
    ['small second', [[1800, 2700], [120, 180]]],
  ] as const) {
    for (const dpr of [1, 2, 3]) {
      test(`${name} at ${dpr}x uses the largest common honest height`, () => {
        const frames = dimensions.map(([width, height]) => ({ width, height }))
        const region = insetSpreadRegion(canvas)
        const result = flatSpreadSegments(frames, region, dpr)
        const expectedHeight = Math.min(region.height, (region.width - 12) / frames.reduce((sum, frame) => sum + frame.width / frame.height, 0), ...frames.map((frame) => frame.height / dpr))
        expect(result).toHaveLength(2)
        result.forEach((box, index) => {
          expect(Math.abs(box.height - expectedHeight)).toBeLessThan(1e-8)
          expect(Math.abs(box.width / box.height - frames[index].width / frames[index].height)).toBeLessThan(1e-8)
          expect(box.width * dpr).toBeLessThanOrEqual(frames[index].width + 1e-8)
          expect(box.height * dpr).toBeLessThanOrEqual(frames[index].height + 1e-8)
        })
        expect(Math.abs(result[1].x - result[0].x - result[0].width - 12)).toBeLessThan(1e-8)
        expect(Math.abs((result[0].x - region.x) - (region.x + region.width - result[1].x - result[1].width))).toBeLessThan(1e-8)
      })
    }
  }

  test('a singleton is centred at its honest size', () => {
    expect(flatSpreadSegments([{ width: 180, height: 120 }], canvas, 3)).toEqual([{ x: 445.5, y: 314.5, width: 60, height: 40 }])
  })

  test('unusable dimensions produce no fabricated geometry', () => {
    expect(flatSpreadSegments([{ width: 0, height: 120 }], canvas, 1)).toEqual([])
    expect(flatSpreadSegments([{ width: Number.NaN, height: 120 }], canvas, 1)).toEqual([])
  })
})

describe('ordered spread ranges', () => {
  const items = (types: string) => [...types].map((type) => ({ type: type === 'v' ? 'video' : undefined })) as GalleryMediaItem[]
  test('odd last photographs never repeat their predecessor', () => {
    expect(spreadRanges(items('ppppp'))).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 5 }])
  })
  test('videos stand alone without breaking subsequent pairing', () => {
    expect(spreadRanges(items('pvppvvp'))).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 6 }, { start: 6, end: 7 }])
    expect(spreadRanges([])).toEqual([])
  })
})
