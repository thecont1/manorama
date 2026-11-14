import { useEffect } from 'hono/jsx'
import type { RefObject } from 'hono/jsx'
import { placeMasonry } from '../../lib/masonry'

/** The narrowest a cover card may read before the grid adds a column —
 *  below this the photograph stops being a gallery and becomes a thumbnail.
 *  Paired with the 14px column-gap in `.lib-compact-grid`. */
const MIN_CARD_WIDTH = 240
const GRID_GAP = 14
/** Past this the feed is a contact sheet, not a Library. */
const MAX_COLUMNS = 6
const MIN_COLUMNS = 2

/**
 * Row-ordered masonry for a .lib-compact-grid. CSS columns would fill
 * top-to-bottom and scramble the Library's order; instead each card takes
 * an explicit grid row/column from placeMasonry. The effect has no deps, so
 * hono/jsx re-runs it after every render — that covers cards entering or
 * leaving the list. ResizeObserver and the capture-phase load listener
 * cover the changes that never pass through render: viewport crossings and
 * covers finishing their decode.
 */
export function useMasonry(listRef: RefObject<HTMLUListElement | null>) {
  useEffect(() => {
    const list = listRef.current
    if (!list?.isConnected || typeof window === 'undefined') return

    /** Measures card heights and writes each card's grid row/column. The
     *  column count follows the list's own width — the rail already took
     *  its share — so a fullscreen window simply earns more columns. */
    const layout = () => {
      const width = list.getBoundingClientRect().width
      const columns = Math.min(
        MAX_COLUMNS,
        Math.max(MIN_COLUMNS, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP))),
      )
      list.style.setProperty('--cols', String(columns))
      const cards = Array.from(list.querySelectorAll<HTMLElement>('.lib-compact-card'))
      const placements = placeMasonry(
        cards.map((card) => card.getBoundingClientRect().height),
        columns,
      )
      cards.forEach((card, index) => {
        const { column, rowStart, span } = placements[index]!
        card.style.gridColumn = String(column)
        card.style.gridRow = `${rowStart} / span ${span}`
      })
      list.dataset.masonry = 'on'
    }

    let frame = 0
    /** Coalesces layout requests onto a single animation frame. */
    const schedule = () => {
      if (frame) return
      /** The frame callback — clears the guard flag, then lays out. */
      const run = () => {
        frame = 0
        layout()
      }
      frame =
        typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame(run)
          : window.setTimeout(run, 0)
    }

    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(list)
    for (const card of list.querySelectorAll('.lib-compact-card')) resize?.observe(card)

    // `load` does not bubble — listening in the capture phase on the list
    // still sees every cover inside it.
    list.addEventListener('load', schedule, true)

    schedule()

    return () => {
      if (frame) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
        else window.clearTimeout(frame)
      }
      resize?.disconnect()
      list.removeEventListener('load', schedule, true)
    }
  })
}
