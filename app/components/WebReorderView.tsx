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
import { HeicImg } from './ui/HeicImg'
import { TopBar } from './ui/TopBar'

/** Web reorder is the iPhone draft (Cancel / Save, pick then place) laid out
 * as one non-wrapping row. Nothing is written until Save. */

export type WebReorderImage = ReorderItem & {
  /** The item's original bytes — possibly HEIC. */
  src: string
  /** A renderable rendition; wins over the original when present. */
  preview?: string | null
  /** Manifest filename; the .heic/.heif suffix selects the decode path. */
  filename?: string | null
  label: string
  hidden?: boolean
}

type Props = {
  title: string
  images: readonly WebReorderImage[]
  busy?: boolean
  /** A failed Save, shown beside the status line so the draft does not look
   *  committed while the toast behind the overlay is unreadable. */
  note?: string | null
  onCancel: () => void
  onSave: (orderKeys: readonly string[], hiddenKeys: readonly string[]) => void
}

const HINT = 'Tap a photograph to pick it up, then tap where it goes.'

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key))

/** The iPhone editor is a grid with a bottom size controller. The web keeps
 * that controller and adds the strip — a vertically centred, edge-to-edge
 * row — as a second layout. The same cells and session drive both. */
export function WebReorderView({ title, images, busy = false, note = null, onCancel, onSave }: Props) {
  const [session, setSession] = useState<ReorderState<WebReorderImage>>(() => createReorderSession(images))
  const [view, setView] = useState<'strip' | 'grid'>('strip')
  const [itemHeight, setItemHeight] = useState(160)
  // Concealment is a draft like order: nothing is hidden until Save writes
  // the set. Hidden cells stay mounted — dimmed, with their mark raised —
  // so an unhide is one tap and a hidden photograph keeps its place.
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set(images.filter((image) => image.hidden).map((image) => image.orderKey)))
  const [savedHidden] = useState(hiddenKeys)
  // The mark surfaces on hover or focus; on touch it is raised by the tap
  // that picks the photograph up, and rides along to the next cell tapped.
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const dirty = reorderIsDirty(session) || !sameKeys(hiddenKeys, savedHidden)
  const held = session.items.find((item) => item.id === session.heldId) ?? null
  const status = held ? `Picked up ${held.label}. Tap where it goes.` : HINT

  const place = (id: string) => {
    if (busy) return
    setRevealedId(id)
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

  const toggleHidden = (image: WebReorderImage) => {
    if (busy) return
    const next = new Set(hiddenKeys)
    const hiding = !next.has(image.orderKey)
    if (hiding) next.add(image.orderKey)
    else next.delete(image.orderKey)
    setHiddenKeys(next)
    // A held photograph that is hidden has nowhere meaningful to land —
    // put it down rather than let the draft carry a concealed hold.
    if (hiding && session.heldId === image.id) setSession({ ...session, heldId: null })
    announce(hiding ? `Hid ${image.label}. Save to remove it from the gallery.` : `${image.label} is visible again.`)
  }

  return (
    <section class="web-reorder" data-screen="reorder" aria-label={`Reorder ${title}`}>
      <TopBar
        logo={false}
        title="Reorder"
        start={<Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>}
        end={<Button variant="primary" onClick={() => onSave(session.items.map((item) => item.orderKey), [...hiddenKeys])} disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save'}</Button>}
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
          {session.items.map((image, index) => {
            const hidden = hiddenKeys.has(image.orderKey)
            return (
              <div
                key={image.id}
                class={`web-reorder-item${hidden ? ' is-hidden' : ''}${revealedId === image.id ? ' is-revealed' : ''}`}
                style={{ aspectRatio: `${Math.max(1, image.width)} / ${Math.max(1, image.height)}`, height: `${itemHeight}px` }}
              >
                <button
                  type="button"
                  id={`reorder-${image.id}`}
                  class={`admin-gallery-strip-item web-reorder-cell${session.heldId === image.id ? ' is-picked' : ''}${dirty && image.orderKey !== images[index]?.orderKey ? ' is-moved' : ''}`}
                  role="option"
                  aria-selected={session.heldId === image.id ? 'true' : 'false'}
                  data-image-id={image.id}
                  data-order-key={image.orderKey}
                  disabled={busy}
                  onClick={() => place(image.id)}
                >
                  <HeicImg src={image.src} preview={image.preview} filename={image.filename} alt="" width={image.width} height={image.height} draggable={false} />
                  {dirty && image.orderKey !== images[index]?.orderKey ? <span class="web-reorder-pos">{index + 1}</span> : null}
                </button>
                {/* A button cannot nest inside the cell's own button, so the
                    mark is an absolutely placed sibling of the option. It
                    surfaces on hover and keyboard focus, on the tap that
                    picks the photograph up, and permanently while hidden. */}
                <button
                  type="button"
                  class="web-reorder-hide"
                  aria-label={hidden ? `Show ${image.label}` : `Hide ${image.label}`}
                  aria-pressed={hidden ? 'true' : 'false'}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); toggleHidden(image) }}
                >
                  {hidden
                    ? <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                    : <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 5 14 14M19 5 5 19"/></svg>}
                </button>
              </div>
            )
          })}
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
