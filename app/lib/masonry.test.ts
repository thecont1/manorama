import { describe, expect, test } from 'bun:test'
import { MASONRY_ROW_UNIT, placeMasonry } from './masonry'

describe('placeMasonry', () => {
  test('returns one placement per item, in input order', () => {
    const heights = [120, 80, 200, 60]
    const placements = placeMasonry(heights, 2)
    expect(placements).toHaveLength(heights.length)
  })

  test('ties break toward the leftmost column', () => {
    const placements = placeMasonry([40, 40, 40], 3, 0)
    expect(placements.map((p) => p.column)).toEqual([1, 2, 3])
    expect(placements.every((p) => p.rowStart === 1)).toBe(true)
  })

  test('fills the shortest column', () => {
    // The 200px card opens column 1; both short cards stack in column 2.
    const placements = placeMasonry([200, 50, 50], 2, 0)
    expect(placements.map((p) => p.column)).toEqual([1, 2, 2])
    expect(placements[2]!.rowStart).toBe(placements[1]!.rowStart + placements[1]!.span)
  })

  test('ranks columns by next grid row, not consumed px', () => {
    // Column 1 holds two 1px items: less px than column 2's single 4px item,
    // but each rounded up to a full row — its next free line is 3 against
    // column 2's 2. A px-load ranking would misorder the fourth item.
    const placements = placeMasonry([1, 4, 1, 8], 2, 0)
    expect(placements[3]!.column).toBe(2)
    expect(placements[3]!.rowStart).toBe(2)
  })

  test('two and three columns place the same feed differently', () => {
    const heights = [100, 60, 140, 80, 120, 50]
    const two = placeMasonry(heights, 2, 0)
    const three = placeMasonry(heights, 3, 0)
    expect(two.map((p) => p.column)).not.toEqual(three.map((p) => p.column))
    expect(three.every((p) => p.column >= 1 && p.column <= 3)).toBe(true)
  })

  test('equal heights read row-first: item i lands in column (i % n) + 1', () => {
    const heights = [90, 90, 90, 90, 90, 90]
    for (const columns of [2, 3]) {
      const placements = placeMasonry(heights, columns, 0)
      placements.forEach((placement, index) => {
        expect(placement.column).toBe((index % columns) + 1)
      })
      // The first row holds the first `columns` items.
      for (let index = 0; index < columns; index += 1) {
        expect(placements[index]!.rowStart).toBe(1)
      }
    }
  })

  test('span quantizes height plus gap into row units', () => {
    const [placement] = placeMasonry([100], 1, 14)
    expect(placement!.span).toBe(Math.ceil((100 + 14) / MASONRY_ROW_UNIT))
    expect(placement!.rowStart).toBe(1)
    expect(placement!.column).toBe(1)
  })

  test('a zero-height item still claims one row unit', () => {
    const [placement] = placeMasonry([0], 1, 0)
    expect(placement!.span).toBe(1)
  })

  test('columns below one collapse to a single column', () => {
    const placements = placeMasonry([10, 20, 30], 0, 0)
    expect(placements.map((p) => p.column)).toEqual([1, 1, 1])
    expect(placements.map((p) => p.rowStart)).toEqual([1, 4, 9])
  })

  test('empty input places nothing', () => {
    expect(placeMasonry([], 3)).toEqual([])
  })
})
