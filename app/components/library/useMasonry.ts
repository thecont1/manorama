import { useEffect } from 'hono/jsx'
import type { RefObject } from 'hono/jsx'
import { placeMasonry } from '../../lib/masonry'

const WIDE_QUERY = '(min-width: 640px)'

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

    const layout = () => {
      const columns =
        typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches ? 3 : 2
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
    const schedule = () => {
      if (frame) return
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

    const media =
      typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', schedule)
    }

    schedule()

    return () => {
      if (frame) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
        else window.clearTimeout(frame)
      }
      resize?.disconnect()
      list.removeEventListener('load', schedule, true)
      if (media && typeof media.removeEventListener === 'function') {
        media.removeEventListener('change', schedule)
      }
    }
  })
}
