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
  onCancel: () => void
  onSave: (orderKeys: readonly string[]) => void
}

const HINT = 'Tap a photograph to pick it up, then tap where it goes.'

export function WebReorderView({ title, images, busy = false, onCancel, onSave }: Props) {
  const [session, setSession] = useState<ReorderState<WebReorderImage>>(() => createReorderSession(images))
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
      <p class="web-reorder-status" id="web-reorder-status">{status}</p>
      <div class="admin-gallery-strip-frame web-reorder-frame">
        <div
          class="admin-gallery-strip"
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
              style={{ aspectRatio: `${Math.max(1, image.width)} / ${Math.max(1, image.height)}` }}
              onClick={() => place(image.id)}
            >
              <img src={image.src} alt="" width={image.width} height={image.height} draggable={false} />
              {dirty && image.orderKey !== images[index]?.orderKey ? <span class="web-reorder-pos">{index + 1}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

export default WebReorderView
