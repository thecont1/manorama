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

/**
 * Places each card in the column whose next free grid line is smallest —
 * the shortest column. Ranking must use nextRow, not raw consumed px:
 * spans quantize height into MASONRY_ROW_UNIT rows, and a column can hold
 * less px but more rows than its neighbour (small items round up). Items
 * are processed in feed order and returned one placement each: 1-based
 * column and rowStart, plus the span in row units (gap rides inside it).
 */
export function placeMasonry(
  heights: readonly number[],
  columns: number,
  gap = 14,
): { column: number; rowStart: number; span: number }[] {
  const cols = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1))
  // nextRow is the next free 1-based grid line per column, so spans never
  // overlap; it is also the shortest-column ranking.
  const nextRow = new Array<number>(cols).fill(1)
  return heights.map((height) => {
    let column = 0
    for (let c = 1; c < cols; c += 1) {
      if (nextRow[c]! < nextRow[column]!) column = c
    }
    const span = Math.max(1, Math.ceil((height + gap) / MASONRY_ROW_UNIT))
    const placement = { column: column + 1, rowStart: nextRow[column]!, span }
    nextRow[column] += span
    return placement
  })
}
