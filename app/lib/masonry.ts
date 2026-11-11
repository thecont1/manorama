/**
 * Row-ordered masonry placement for the Library's compact cover grid.
 *
 * CSS `columns` fills top-to-bottom inside each column, which scrambles
 * the Library's own order; a grid with explicit row/column placement keeps
 * cards readable left→right while still packing uneven card heights.
 * Heights arrive in px; the grid's rows are MASONRY_ROW_UNIT px each and
 * each item's vertical gap rides inside its span.
 */

export const MASONRY_ROW_UNIT = 4

export function placeMasonry(
  heights: readonly number[],
  columns: number,
  gap = 14,
): { column: number; rowStart: number; span: number }[] {
  const cols = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1))
  // load is the consumed height in px that picks the shortest column;
  // nextRow is the next free 1-based grid line, so spans never overlap.
  const load = new Array<number>(cols).fill(0)
  const nextRow = new Array<number>(cols).fill(1)
  return heights.map((height) => {
    let column = 0
    for (let c = 1; c < cols; c += 1) {
      if (load[c]! < load[column]!) column = c
    }
    const span = Math.max(1, Math.ceil((height + gap) / MASONRY_ROW_UNIT))
    const placement = { column: column + 1, rowStart: nextRow[column]!, span }
    load[column] += height + gap
    nextRow[column] += span
    return placement
  })
}
