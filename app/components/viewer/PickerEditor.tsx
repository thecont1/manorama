import { useRef, useState } from 'hono/jsx'
import { announce } from '../../lib/announce'
import { PIPELINE_LOCK_MESSAGE } from '../../lib/gallery-policy'
import { formatDuration } from '../../islands/VideoSlide'
import { isVideoItem, type GalleryMediaItem } from '../../lib/imagesource'
import type { GallerySummary } from '../../lib/gallery-repository'
import {
  createReorderSession,
  moveHeldItem,
  pickUpItem,
  putDownItem,
  reorderIsDirty,
  rowStepIndex,
  type ReorderItem,
  type ReorderState,
} from '../../../packages/core/reorder-session'
import { HeicImg } from '../ui/HeicImg'

/** The picker's owner Edit mode — the retired dashboard overlay's
 *  pick-then-place and hide draft, moved into the photograph matrix the
 *  viewer already renders. The component owns the whole session: fetch
 *  the summary once (loadGalleryItems), render it here, and nothing is
 *  written until Save. */

export type PickerEditItem = ReorderItem & {
  /** The item's original bytes — possibly HEIC; a poster for videos. */
  src: string
  /** A renderable rendition; wins over the original when present. */
  preview?: string | null
  /** Manifest filename; the .heic/.heif suffix selects the decode path. */
  filename: string
  label: string
  hidden?: boolean
  video?: boolean
  durationSeconds?: number
}

/** The dialog-level key router and cancel the viewer hands to its chrome
 *  handlers through a render-synced ref, exactly like the grid actions. */
export type PickerEditActions = {
  onKey: (event: KeyboardEvent) => boolean
  cancel: () => void
}

type SummaryImages = GallerySummary['images']

/** The summary carries every item including hidden ones — the page's own
 *  manifest deliberately does not. orderKey is the Worker's persistence
 *  key (ref ?? filename), the same key the PATCH route writes. */
export const loadGalleryItems = async (slug: string): Promise<PickerEditItem[]> => {
  const response = await fetch(`/api/galleries/${encodeURIComponent(slug)}`)
  const payload = await response.json().catch(() => ({})) as { gallery?: { images: SummaryImages }; error?: string }
  if (!response.ok) throw new Error(payload.error || 'That gallery could not be read')
  const summary = payload.gallery
  if (!summary) throw new Error('That gallery could not be found in the account')
  return summary.images.map((image) => {
    const video = isVideoItem(image as GalleryMediaItem)
    const poster = video ? (image as GalleryMediaItem & { poster?: { src: string } }).poster : undefined
    return {
      id: image.id,
      orderKey: image.ref ?? image.filename,
      width: image.width,
      height: image.height,
      src: poster?.src ?? image.src,
      preview: image.variants?.[0]?.src ?? poster?.src,
      filename: image.filename,
      label: image.filename,
      hidden: image.hidden,
      video,
      durationSeconds: video ? (image as GalleryMediaItem & { durationSeconds?: number }).durationSeconds : undefined,
    }
  })
}

/** The browse header's affordance — a button, a busy label while the
 *  summary loads, or the lock message on a temporary gallery. */
export const PickerEditButton = ({ temporary, loading, onBegin }: { temporary: boolean; loading: boolean; onBegin: () => void }) =>
  temporary ? (
    <span class="viewer-picker-lock">{PIPELINE_LOCK_MESSAGE}</span>
  ) : (
    <button type="button" onClick={onBegin} disabled={loading}>{loading ? 'Loading…' : 'Edit'}</button>
  )

const HINT = 'Tap a photograph to pick it up, then tap where it goes.'

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key))

type Props = {
  slug: string
  items: PickerEditItem[]
  /** The pink-box index — the viewer's gridSel, shared so the same
   *  keyboard stepping works over the draft cells. */
  selIndex: number
  /** The scroll frame's own ref/handlers — the same ones browse mode
   *  wires, passed in so pan/scroll behaves identically. */
  frameRef: { current: HTMLDivElement | null }
  pan: {
    onPointerDown: (event: PointerEvent) => void
    onPointerMove: (event: PointerEvent) => void
    onPointerUp: (event: PointerEvent) => void
    onPointerCancel: (event: PointerEvent) => void
    onWheel: (event: WheelEvent) => void
  }
  /** Pan suppression — a drag-scrolled frame must not pick a photo up. */
  suppressClickRef: { current: boolean }
  /** Render-synced slot the viewer's key/scrim handlers consult. */
  actionsRef: { current: PickerEditActions | null }
  /** The on-stage photograph at save time — the reload returns to it
   *  unless the draft hides it. */
  currentPhotoId: () => string
  /** Leaves Edit for browse mode; the draft dies with the component. */
  onExit: () => void
}

export default function PickerEditor({
  slug, items, selIndex, frameRef, pan, suppressClickRef, actionsRef, currentPhotoId, onExit,
}: Props) {
  const [session, setSession] = useState<ReorderState<PickerEditItem>>(() => createReorderSession(items))
  // Concealment is a draft like order: nothing is hidden until Save
  // writes the set. Hidden cells stay mounted — dimmed, with their mark
  // raised — so an unhide is one tap and a hidden photo keeps its place.
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set(items.filter((item) => item.hidden).map((item) => item.orderKey)))
  const [savedHidden] = useState(hiddenKeys)
  // hono batches renders, so two quick taps (pick, then place) can land
  // inside one render — the handlers read the draft through these refs,
  // which commit synchronously, instead of a stale closure.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const commitSession = (next: ReorderState<PickerEditItem>) => { sessionRef.current = next; setSession(next) }
  const hiddenRef = useRef(hiddenKeys)
  hiddenRef.current = hiddenKeys
  const commitHidden = (next: ReadonlySet<string>) => { hiddenRef.current = next; setHiddenKeys(next) }
  // The mark surfaces on hover or focus; on touch it is raised by the tap
  // that picks the photograph up, and rides along to the next cell tapped.
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [itemHeight, setItemHeight] = useState(12)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const dirty = reorderIsDirty(session) || !sameKeys(hiddenKeys, savedHidden)
  const held = session.items.find((item) => item.id === session.heldId) ?? null
  const status = held ? `Picked up ${held.label}. Tap where it goes.` : HINT

  const place = (id: string) => {
    if (saving) return
    setRevealedId(id)
    const before = sessionRef.current
    const next = before.heldId ? putDownItem(before, id) : pickUpItem(before, id)
    if (next === before) return
    commitSession(next)
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
    const before = sessionRef.current
    if (!before.heldId || saving) return
    const from = before.items.findIndex((item) => item.id === before.heldId)
    const to = from + direction
    if (to < 0 || to >= before.items.length) return
    const next = moveHeldItem(before, to)
    commitSession(next)
    const moved = next.items[to]
    announce(`Moved ${moved?.label ?? 'photograph'} to position ${to + 1} of ${next.items.length}.`)
  }

  // A vertical arrow moves the held photograph by a whole matrix row — to
  // the cell above or below at the nearest horizontal position, the same
  // step the picker matrix's wrapped rows imply.
  const nudgeRow = (direction: -1 | 1) => {
    const before = sessionRef.current
    if (!before.heldId || saving) return
    const cells = [...(frameRef.current?.querySelectorAll<HTMLElement>('[data-grid-item]') ?? [])]
    const from = before.items.findIndex((item) => item.id === before.heldId)
    if (from < 0 || cells.length !== before.items.length) return
    const to = rowStepIndex(
      cells.map((el) => { const rect = el.getBoundingClientRect(); return { top: rect.top, left: rect.left } }),
      from,
      direction,
    )
    if (to === from) return
    const next = moveHeldItem(before, to)
    commitSession(next)
    const moved = next.items[to]
    announce(`Moved ${moved?.label ?? 'photograph'} to position ${to + 1} of ${next.items.length}.`)
  }

  const toggleHidden = (item: PickerEditItem) => {
    if (saving) return
    const next = new Set(hiddenRef.current)
    const hiding = !next.has(item.orderKey)
    if (hiding) next.add(item.orderKey)
    else next.delete(item.orderKey)
    commitHidden(next)
    // A held photograph that is hidden has nowhere meaningful to land —
    // put it down rather than let the draft carry a concealed hold.
    if (hiding && sessionRef.current.heldId === item.id) commitSession({ ...sessionRef.current, heldId: null })
    announce(hiding ? `Hid ${item.label}. Save to remove it from the gallery.` : `${item.label} is visible again.`)
  }

  const cancel = () => onExit()

  // Same request shape as Admin.persistGalleryOrder — order and hidden are
  // independent drafts written in one PATCH.
  const save = () => {
    if (!dirty || saving) return
    setSaving(true)
    setNote(null)
    void (async () => {
      try {
        const response = await fetch(`/api/galleries/${encodeURIComponent(slug)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: sessionRef.current.items.map((item) => item.orderKey), hidden: [...hiddenRef.current] }),
        })
        const payload = await response.json().catch(() => ({})) as { error?: string }
        if (!response.ok) throw new Error(payload.error || 'That order could not be saved')
        announce('Order saved')
        // Return to the on-stage photograph when the draft still shows it;
        // a freshly hidden one leaves the reload on the first frame.
        const current = currentPhotoId()
        const stillVisible = items.some((item) => item.id === current && !hiddenRef.current.has(item.orderKey))
        window.location.replace(`${window.location.pathname}${stillVisible ? `?photo=${encodeURIComponent(current)}` : ''}`)
      } catch (error) {
        setSaving(false)
        setNote(error instanceof Error ? error.message : 'That order could not be saved')
      }
    })()
  }

  // The dialog/window key handlers give the editor first claim on every
  // key; returning false lets the browse semantics apply — arrows with
  // nothing held keep stepping the pink selection.
  const onKey = (event: KeyboardEvent): boolean => {
    const key = event.key
    if (key === 'Escape') {
      event.preventDefault()
      if (sessionRef.current.heldId) {
        commitSession({ ...sessionRef.current, heldId: null })
        announce('Put back.')
      } else {
        cancel()
      }
      return true
    }
    if (saving) return false
    if (key === 'Enter' || key === ' ') {
      const target = sessionRef.current.items[selIndex]
      if (!target) return true
      event.preventDefault()
      place(target.id)
      return true
    }
    if (key === 'h' || key === 'H') {
      const target = sessionRef.current.items[selIndex]
      if (!target) return true
      event.preventDefault()
      toggleHidden(target)
      return true
    }
    if (sessionRef.current.heldId && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault()
      // ←/→ step one place; ↑/↓ step a whole matrix row.
      if (key === 'ArrowUp' || key === 'ArrowDown') nudgeRow(key === 'ArrowUp' ? -1 : 1)
      else nudge(key === 'ArrowLeft' ? -1 : 1)
      return true
    }
    return false
  }

  actionsRef.current = { onKey, cancel }

  const cellClick = (item: PickerEditItem) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    place(item.id)
  }

  return (
    <>
      <header class="viewer-picker-header viewer-picker-header--edit">
        <p class="viewer-edit-status">
          {status}
          {note ? <span class="viewer-edit-alert" role="alert"> {note}</span> : null}
        </p>
        <div class="viewer-edit-controls">
          <label class="viewer-edit-sizer">
            <span class="sr-only">Photograph size</span>
            <input
              type="range"
              min={8}
              max={24}
              step={1}
              value={itemHeight}
              aria-label="Photograph size"
              onInput={(event) => setItemHeight(Number((event.currentTarget as HTMLInputElement).value))}
              onKeyDown={(event) => {
                // Home/End size the slider natively; the editor's handler
                // would otherwise move a held photograph or the selection.
                if (event.key === 'Home' || event.key === 'End') event.stopPropagation()
              }}
            />
          </label>
          <button type="button" onClick={cancel} disabled={saving}>Cancel</button>
          <button type="button" class="viewer-edit-save" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </header>
      <div ref={frameRef} class="viewer-filmstrip-frame" {...pan}>
        <div class="viewer-filmstrip-track">
          {session.items.map((item, index) => {
            const hidden = hiddenKeys.has(item.orderKey)
            return (
              <div
                key={item.id}
                class={`viewer-edit-cell${hidden ? ' is-hidden' : ''}${revealedId === item.id ? ' is-revealed' : ''}`}
                style={{ aspectRatio: `${Math.max(1, item.width)} / ${Math.max(1, item.height)}`, height: `${itemHeight}dvh` }}
              >
                <button
                  type="button"
                  class={`viewer-filmstrip-item viewer-edit-item${session.heldId === item.id ? ' is-held' : ''}${index === selIndex ? ' is-active' : ''}`}
                  data-grid-item
                  data-grid-active={index === selIndex ? 'true' : undefined}
                  data-image-id={item.id}
                  data-order-key={item.orderKey}
                  aria-label={`${hidden ? 'Hidden ' : ''}${item.video ? 'Video' : 'Photograph'} ${index + 1} of ${session.items.length}`}
                  disabled={saving}
                  onClick={() => cellClick(item)}
                >
                  <HeicImg src={item.src} preview={item.preview} filename={item.filename} alt="" draggable={false} onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')} />
                  {item.video ? <span class="viewer-filmstrip-badge">▶{item.durationSeconds ? ` ${formatDuration(item.durationSeconds)}` : ''}</span> : null}
                </button>
                {/* A button cannot nest inside the cell's own button, so the
                    mark is an absolutely placed sibling. It surfaces on
                    hover and keyboard focus, on the tap that picks the
                    photograph up, and permanently while hidden. */}
                <button
                  type="button"
                  class="viewer-edit-mark"
                  aria-label={hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                  aria-pressed={hidden ? 'true' : 'false'}
                  disabled={saving}
                  onClick={(event) => { event.stopPropagation(); toggleHidden(item) }}
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
    </>
  )
}
