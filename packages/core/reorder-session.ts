/** Platform-free Reorder session. Media ids stay stable; orderKeys are the
 * provider identities persisted by the Worker (ref ?? filename ?? id). */
export type ReorderItem = {
  id: string
  orderKey: string
  width: number
  height: number
}

export type ReorderState<I extends ReorderItem> = {
  items: I[]
  savedKeys: string[]
  heldId: string | null
}

export const createReorderSession = <I extends ReorderItem>(items: readonly I[]): ReorderState<I> => ({
  items: [...items],
  savedKeys: items.map((item) => item.orderKey),
  heldId: null,
})

export const reorderIsDirty = <I extends ReorderItem>(state: ReorderState<I>): boolean =>
  state.items.length !== state.savedKeys.length || state.items.some((item, index) => item.orderKey !== state.savedKeys[index])

export const moveItem = <I extends ReorderItem>(state: ReorderState<I>, from: number, to: number): ReorderState<I> => {
  if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return state
  const items = [...state.items]
  const [moved] = items.splice(from, 1)
  if (!moved) return state
  items.splice(to, 0, moved)
  return { ...state, items }
}

export const pickUpItem = <I extends ReorderItem>(state: ReorderState<I>, id: string): ReorderState<I> =>
  state.items.some((item) => item.id === id) ? { ...state, heldId: id } : state

export const putDownItem = <I extends ReorderItem>(state: ReorderState<I>, targetId: string): ReorderState<I> => {
  if (!state.heldId) return state
  if (state.heldId === targetId) return { ...state, heldId: null }
  const from = state.items.findIndex((item) => item.id === state.heldId)
  const to = state.items.findIndex((item) => item.id === targetId)
  if (from < 0 || to < 0) return state
  return { ...moveItem(state, from, to), heldId: null }
}

export const moveHeldItem = <I extends ReorderItem>(state: ReorderState<I>, to: number): ReorderState<I> => {
  if (!state.heldId) return state
  const from = state.items.findIndex((item) => item.id === state.heldId)
  const bounded = Math.max(0, Math.min(state.items.length - 1, to))
  return moveItem(state, from, bounded)
}

export const discardReorder = <I extends ReorderItem>(state: ReorderState<I>): ReorderState<I> => {
  const byKey = new Map(state.items.map((item) => [item.orderKey, item]))
  const seen = new Set<string>()
  const items: I[] = []
  for (const key of state.savedKeys) {
    const item = byKey.get(key)
    if (item && !seen.has(key)) {
      items.push(item)
      seen.add(key)
    }
  }
  for (const item of state.items) if (!seen.has(item.orderKey)) items.push(item)
  return { ...state, items, heldId: null }
}

export type PhotoLayoutCell<I> = { item: I; x: number; width: number }
export type PhotoLayoutRow<I> = { cells: PhotoLayoutCell<I>[]; top: number; width: number }
export type PhotoLayout<I> = { rows: PhotoLayoutRow<I>[]; totalHeight: number; totalWidth: number }

/** Greedy aspect-true matrix rows. Row height is fixed by the caller; no cell
 * is cropped or scaled independently. Rows are virtualised by their top. */
export const layoutPhotoRows = <I extends { width: number; height: number }>(
  items: readonly I[],
  viewportWidth: number,
  rowHeight: number,
): PhotoLayout<I> => {
  const rows: PhotoLayoutRow<I>[] = []
  let cells: PhotoLayoutCell<I>[] = []
  let x = 0
  let top = 0
  let totalWidth = 0
  const width = Math.max(1, viewportWidth)
  const flush = () => {
    if (!cells.length) return
    rows.push({ cells, top, width: x })
    totalWidth = Math.max(totalWidth, x)
    top += rowHeight
    cells = []
    x = 0
  }
  for (const item of items) {
    const cellWidth = item.height > 0 && item.width > 0 ? rowHeight * item.width / item.height : rowHeight
    if (cells.length && x + cellWidth > width) flush()
    cells.push({ item, x, width: cellWidth })
    x += cellWidth
  }
  flush()
  return { rows, totalHeight: top, totalWidth }
}

export const visibleRowRange = (
  rows: readonly { top: number }[],
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 1,
): { start: number; end: number } => {
  if (!rows.length) return { start: 0, end: -1 }
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan)
  const lastVisible = Math.min(rows.length - 1, Math.floor(Math.max(0, scrollTop + viewportHeight) / rowHeight))
  return { start: first, end: Math.min(rows.length - 1, lastVisible + overscan) }
}
