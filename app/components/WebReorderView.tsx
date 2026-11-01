import { useState } from 'hono/jsx'
import { announce } from '../lib/announce'
import {
  createReorderSession,
  moveHeldItem,
  pickUpItem,
  putDownItem,
  reorderIsDirty,
  type ReorderItem,
  type ReorderState,
} from '../../packages/core/reorder-session'
import { Button } from './ui/Button'
import { TopBar } from './ui/TopBar'

/** Web reorder is the iPhone draft (Cancel / Save, pick then place) laid out
 * as one non-wrapping row. Nothing is written until Save. */

export type WebReorderImage = ReorderItem & {
  src: string
  label: string
}

type Props = {
  title: string
  images: readonly WebReorderImage[]
  busy?: boolean
  /** A failed Save, shown beside the status line so the draft does not look
   *  committed while the toast behind the overlay is unreadable. */
  note?: string | null
  onCancel: () => void
  onSave: (orderKeys: readonly string[]) => void
}

const HINT = 'Tap a photograph to pick it up, then tap where it goes.'

/** The iPhone editor is a grid with a bottom size controller. The web keeps
 * that controller and adds the strip — a vertically centred, edge-to-edge
 * row — as a second layout. The same cells and session drive both. */
export function WebReorderView({ title, images, busy = false, note = null, onCancel, onSave }: Props) {
  const [session, setSession] = useState<ReorderState<WebReorderImage>>(() => createReorderSession(images))
  const [view, setView] = useState<'strip' | 'grid'>('strip')
  const [itemHeight, setItemHeight] = useState(160)
  const dirty = reorderIsDirty(session)
  const held = session.items.find((item) => item.id === session.heldId) ?? null
  const status = held ? `Picked up ${held.label}. Tap where it goes.` : HINT

  const place = (id: string) => {
    if (busy) return
    const before = session
    const next = before.heldId ? putDownItem(before, id) : pickUpItem(before, id)
    if (next === before) return
    setSession(next)
    if (before.heldId && before.heldId !== id) {
      const at = next.items.findIndex((item) => item.id === before.heldId) + 1
      const moved = before.items.find((item) => item.id === before.heldId)
      announce(`Moved ${moved?.label ?? 'photograph'} to position ${at} of ${next.items.length}.`)
    } else if (!before.heldId) {
      announce(`Picked up ${next.items.find((item) => item.id === id)?.label ?? 'photograph'}. Tap where it goes.`)
    } else {
      announce('Put back.')
    }
  }

  const nudge = (direction: -1 | 1) => {
    if (!session.heldId || busy) return
    const from = session.items.findIndex((item) => item.id === session.heldId)
    const to = from + direction
    if (to < 0 || to >= session.items.length) return
    const next = moveHeldItem(session, to)
    setSession(next)
    const moved = next.items[to]
    announce(`Moved ${moved?.label ?? 'photograph'} to position ${to + 1} of ${next.items.length}.`)
  }

  return (
    <section class="web-reorder" data-screen="reorder" aria-label={`Reorder ${title}`}>
      <TopBar
        logo={false}
        title="Reorder"
        start={<Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>}
        end={<Button variant="primary" onClick={() => onSave(session.items.map((item) => item.orderKey))} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>}
      />
      <div class="web-reorder-bar">
        <p class="web-reorder-status" id="web-reorder-status">
          {status}
          {note ? <span class="web-reorder-note" role="alert">{note}</span> : null}
        </p>
      </div>
      <div class={view === 'grid' ? 'web-reorder-frame web-reorder-frame--grid' : 'admin-gallery-strip-frame web-reorder-frame'}>
        <div
          class={view === 'grid' ? 'web-reorder-grid' : 'admin-gallery-strip'}
          role="listbox"
          aria-label={`Reorder ${title}`}
          aria-describedby="web-reorder-status"
          aria-activedescendant={held ? `reorder-${held.id}` : undefined}
          tabIndex={0}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-1) }
            if (event.key === 'ArrowRight') { event.preventDefault(); nudge(1) }
            if (event.key === 'Escape' && session.heldId) {
              event.preventDefault()
              setSession({ ...session, heldId: null })
              announce('Put back.')
            }
          }}
        >
          {session.items.map((image, index) => (
            <button
              type="button"
              key={image.id}
              id={`reorder-${image.id}`}
              class={`admin-gallery-strip-item web-reorder-cell${session.heldId === image.id ? ' is-picked' : ''}${dirty && image.orderKey !== images[index]?.orderKey ? ' is-moved' : ''}`}
              role="option"
              aria-selected={session.heldId === image.id ? 'true' : 'false'}
              data-image-id={image.id}
              data-order-key={image.orderKey}
              disabled={busy}
              style={{ aspectRatio: `${Math.max(1, image.width)} / ${Math.max(1, image.height)}`, height: `${itemHeight}px` }}
              onClick={() => place(image.id)}
            >
              <img src={image.src} alt="" width={image.width} height={image.height} draggable={false} />
              {dirty && image.orderKey !== images[index]?.orderKey ? <span class="web-reorder-pos">{index + 1}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div class="web-reorder-sizer">
        <svg class="s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1"/></svg>
        <input
          type="range"
          min="56"
          max="248"
          step="4"
          value={itemHeight}
          aria-label="Photograph size"
          onInput={(event) => setItemHeight(Number((event.currentTarget as HTMLInputElement).value))}
          onKeyDown={(event) => {
            // Home/End adjust the slider natively; the listbox handler
            // would otherwise move the held photograph instead.
            if (event.key === 'Home' || event.key === 'End') event.stopPropagation()
          }}
        />
        <svg class="l" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 16l5-5 4 4 3-3 6 6"/></svg>
        {/* The layout choice sits beside the size control — one compact
            bottom cluster instead of a toggle floating in the status bar. */}
        <span class="web-reorder-views" role="group" aria-label="Layout">
          <button type="button" class={`web-reorder-view${view === 'strip' ? ' is-on' : ''}`} aria-pressed={view === 'strip'} onClick={() => setView('strip')}>Strip</button>
          <button type="button" class={`web-reorder-view${view === 'grid' ? ' is-on' : ''}`} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button>
        </span>
      </div>
    </section>
  )
}

export default WebReorderView
