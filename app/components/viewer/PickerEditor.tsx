import { useRef, useState } from 'hono/jsx'
import { announce } from '../../lib/announce'
import { PIPELINE_LOCK_MESSAGE } from '../../lib/gallery-policy'
import { formatDuration } from '../../islands/VideoSlide'
import { isVideoItem, type GalleryMediaItem } from '../../lib/imagesource'
import { isHeicFilename } from '../../lib/heic'
import type { GallerySummary } from '../../lib/gallery-repository'
import {
  createReorderSession,
  moveHeldItem,
  pickUpItem,
  pointerTargetIndex,
  putDownItem,
  reorderIsDirty,
  rowStepIndex,
  type ReorderItem,
  type ReorderState,
} from '../../../packages/core/reorder-session'
import type { MediaReference } from '../../../packages/core/encrypted-source'
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
  /** Keyless encrypted refs — MEGA items carry no src; the cell resolves
   *  them through the client's own key store, never a keyed URL. */
  media?: MediaReference
  previewMedia?: MediaReference
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
export const loadGalleryItems = async (slug: string, apiBase = '', token?: string): Promise<PickerEditItem[]> => {
  const base = apiBase.replace(/\/$/, '')
  const url = base ? `${base}/api/galleries/${encodeURIComponent(slug)}` : `/api/galleries/${encodeURIComponent(slug)}`
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  const payload = await response.json().catch(() => ({})) as { gallery?: { images: SummaryImages }; error?: string }
  if (!response.ok) throw new Error(payload.error || 'That gallery could not be read')
  const summary = payload.gallery
  if (!summary) throw new Error('That gallery could not be found in the account')
  // Media paths are server-relative — on a non-web shell they must resolve
  // against the API origin or the cells ask tauri://localhost for them.
  const mediaUrl = <T extends string | undefined>(src: T): T =>
    (src && base && src.startsWith('/') ? `${base}${src}` : src) as T
  return summary.images.map((image) => {
    const video = isVideoItem(image as GalleryMediaItem)
    const poster = video ? (image as GalleryMediaItem & { poster?: { src: string } }).poster : undefined
    return {
      id: image.id,
      orderKey: image.ref ?? image.filename,
      width: image.width,
      height: image.height,
      src: mediaUrl(poster?.src ?? image.src),
      // The same URL browse mode puts in its <img> — identical bytes mean
      // the browser cache answers the mode switch instead of the network.
      preview: mediaUrl(image.variants?.[0]?.src ?? poster?.src ?? image.placeholder),
      media: image.media,
      previewMedia: image.variants?.[0]?.media,
      filename: image.filename,
      label: image.filename,
      hidden: image.hidden,
      video,
      durationSeconds: video ? (image as GalleryMediaItem & { durationSeconds?: number }).durationSeconds : undefined,
    }
  })
}

/** The browse top bar's affordance — a button, a busy label while the
 *  summary loads, or the lock message on a temporary gallery. */
export const PickerEditButton = ({ temporary, loading, onBegin }: { temporary: boolean; loading: boolean; onBegin: () => void }) =>
  temporary ? (
    <span class="viewer-picker-lock">{PIPELINE_LOCK_MESSAGE}</span>
  ) : (
    <button type="button" class="viewer-picker-switch" onClick={onBegin} disabled={loading}>{loading ? 'Loading…' : 'Switch to Reorder Photos'}</button>
  )

/** The photograph-size slider — identical markup in both modes so it
 *  never moves a pixel when the mode switches. */
export const PickerSizer = ({ value, onChange }: { value: number; onChange: (height: number) => void }) => (
  <label class="viewer-edit-sizer">
    <svg class="s" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="1"/></svg>
    <span class="sr-only">Photograph size</span>
    <input
      type="range"
      min={8}
      max={24}
      step={1}
      value={value}
      aria-label="Photograph size"
      onInput={(event) => onChange(Number((event.currentTarget as HTMLInputElement).value))}
      onKeyDown={(event) => {
        // Home/End size the slider natively; the editor's handler
        // would otherwise move a held photograph or the selection.
        if (event.key === 'Home' || event.key === 'End') event.stopPropagation()
      }}
    />
    <svg class="l" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 16l5-5 4 4 3-3 6 6"/></svg>
  </label>
)

/** One line under the picker title, both modes — the screen reads the
 *  same, only what a tap does changes. */
export const BROWSE_HINT = 'Tap a photograph to open it.'
const HINT = 'Reorder mode — tap a photograph to pick it up, then tap where it goes.'

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((key) => b.has(key))

type Props = {
  slug: string
  /** The gallery's immutable id — the key store's lookup key for any
   *  encrypted media refs the items carry. */
  galleryId?: string
  items: PickerEditItem[]
  /** Optional API base + bearer token for non-web shells (desktop). */
  apiBase?: string
  token?: string
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
  /** The photograph size both modes share — hoisted to the viewer so a
   *  switch carries it over. */
  itemHeight: number
  onItemHeight: (height: number) => void
  /** Leaves Edit for browse mode; the draft dies with the component. */
  onExit: () => void
  /** Leaves the whole picker — the browse mode's Close, offered here as
   *  Cancel whenever there is no draft to lose. */
  onDone: () => void
  /** Where Save and Cancel land when Edit was entered from outside the
   *  gallery (the Library's card menu) — the screen the user came from.
   *  Unset, both end on the gallery. */
  doneHref?: string
  /** Post-save continuation for shells that cannot reload a URL to land
   *  back on the photograph (desktop, native) — receives the on-stage
   *  photograph when the draft still shows it, null otherwise. */
  onSaved?: (photoId: string | null) => void
  /** Overrides the default PATCH persistence — galleries whose order lives
   *  somewhere other than the Worker manifest (a local catalogue record)
   *  receive the same draft shape: every item's orderKey, then the hidden
   *  orderKeys. A rejection lands in the note slot like an API failure. */
  onSaveOrder?: (order: string[], hidden: string[]) => Promise<void>
}

export default function PickerEditor({
  slug, galleryId, items, apiBase = '', token, selIndex, frameRef, pan, suppressClickRef, actionsRef, itemHeight, onItemHeight, currentPhotoId, onExit, onDone, doneHref, onSaved, onSaveOrder,
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

  // Pointer-drag reorder — the tap pick-up/put-down's sibling for mice and
  // held touches. Mouse drags own the gesture after a small move (the frame
  // never pans under them — the matrix has no gaps to grab); touch and pen
  // require a press-and-hold so an immediate move stays a scroll. Once a
  // drag activates, the held item live-moves under the pointer: every cell
  // the point crosses becomes the draft position, and release is already a
  // complete move — Escape or a pointercancel restores the start index.
  type DragState = {
    pointerId: number
    pointerType: string
    itemId: string
    startX: number
    startY: number
    lastX: number
    lastY: number
    /** The index the drag picked the item up from — where cancel puts it. */
    fromIndex: number
    /** The cell's pixel box at activation — the ghost's size. */
    width: number
    height: number
    active: boolean
    holdTimer: ReturnType<typeof setTimeout> | null
  }
  const DRAG_MOUSE_PX = 6
  const DRAG_TOUCH_CANCEL_PX = 10
  const DRAG_HOLD_MS = 350
  const dragRef = useRef<DragState | null>(null)
  const ghostEl = useRef<HTMLElement | null>(null)
  const [dragGhost, setDragGhost] = useState<{ src: string; preview?: string | null; filename: string; media?: MediaReference; previewMedia?: MediaReference; width: number; height: number } | null>(null)

  const clearDrag = (drag: DragState) => {
    if (drag.holdTimer !== null) clearTimeout(drag.holdTimer)
    dragRef.current = null
  }

  const positionGhost = (drag: DragState) => {
    const el = ghostEl.current
    if (el) el.style.transform = `translate3d(${Math.round(drag.lastX - drag.width / 2)}px, ${Math.round(drag.lastY - drag.height / 2)}px, 0)`
  }

  const activateDrag = () => {
    const drag = dragRef.current
    if (!drag || drag.active || saving) return
    const items = sessionRef.current.items
    const index = items.findIndex((item) => item.id === drag.itemId)
    const item = items[index]
    if (!item) { clearDrag(drag); return }
    drag.active = true
    drag.fromIndex = index
    commitSession(pickUpItem(sessionRef.current, drag.itemId))
    setRevealedId(drag.itemId)
    const cell = [...(frameRef.current?.querySelectorAll<HTMLElement>('[data-grid-item]') ?? [])].find((el) => el.dataset.imageId === drag.itemId)
    const rect = cell?.getBoundingClientRect()
    drag.width = rect?.width || 96
    drag.height = rect?.height || 96
    // Capture keeps the moves and the release on this frame wherever the
    // pointer wanders — outside the window included.
    frameRef.current?.setPointerCapture?.(drag.pointerId)
    setDragGhost({ src: item.src, preview: item.preview, filename: item.filename, media: item.media, previewMedia: item.previewMedia, width: drag.width, height: drag.height })
    // The pointerup's click must not place() — the drop is the placement.
    suppressClickRef.current = true
    announce(`Dragged ${item.label}. Release where it goes.`)
  }

  /** Applies the drop unless cancelled, which restores the index the drag
   *  started from. The held ring comes down either way. */
  const finishDrag = (drag: DragState, cancelled: boolean) => {
    if (!drag.active) return
    if (cancelled && drag.fromIndex >= 0) commitSession(moveHeldItem(sessionRef.current, drag.fromIndex))
    const landed = sessionRef.current.items.findIndex((item) => item.id === drag.itemId)
    const moved = sessionRef.current.items[landed]
    commitSession({ ...sessionRef.current, heldId: null })
    setDragGhost(null)
    suppressClickRef.current = true
    if (cancelled) announce('Put back.')
    else if (landed >= 0 && landed !== drag.fromIndex) announce(`Moved ${moved?.label ?? 'photograph'} to position ${landed + 1} of ${sessionRef.current.items.length}.`)
  }

  const endDrag = (event: PointerEvent, cancelled: boolean) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    finishDrag(drag, cancelled)
    clearDrag(drag)
  }

  /** While the drag is live the pointer is also the scroller: nearing the
   *  frame's top or bottom edge walks the matrix under it, and every cell
   *  crossed becomes the held item's new draft position. */
  const moveDrag = (event: PointerEvent) => {
    event.preventDefault()
    const drag = dragRef.current
    if (!drag?.active) return
    positionGhost(drag)
    const frame = frameRef.current
    if (!frame) return
    const bounds = frame.getBoundingClientRect()
    const zone = 44
    if (drag.lastY < bounds.top + zone) frame.scrollTop -= Math.ceil((bounds.top + zone - drag.lastY) / 6)
    else if (drag.lastY > bounds.bottom - zone) frame.scrollTop += Math.ceil((drag.lastY - bounds.bottom + zone) / 6)
    const to = pointerTargetIndex(
      [...frame.querySelectorAll<HTMLElement>('[data-grid-item]')].map((el) => {
        const cell = el.getBoundingClientRect()
        return { top: cell.top, left: cell.left, right: cell.right, bottom: cell.bottom }
      }),
      event.clientX,
      event.clientY,
    )
    const from = sessionRef.current.items.findIndex((item) => item.id === drag.itemId)
    if (to >= 0 && from >= 0 && to !== from) commitSession(moveHeldItem(sessionRef.current, to))
  }

  const onFramePointerDown = (event: PointerEvent) => {
    const cell = (event.target as HTMLElement | null)?.closest?.('[data-grid-item]') as HTMLElement | null
    if (cell?.dataset.imageId && event.button === 0 && !saving) {
      // A new gesture on a cell clears any suppression a release-off-cell
      // left standing — otherwise this press's click gets eaten by a
      // stale flag and the tap does nothing.
      suppressClickRef.current = false
      dragRef.current = {
        pointerId: event.pointerId,
        pointerType: event.pointerType || 'mouse',
        itemId: cell.dataset.imageId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        fromIndex: -1,
        width: 0,
        height: 0,
        active: false,
        holdTimer: null,
      }
      // A mouse press on a photograph is a putative drag, never a pan —
      // the wheel and trackpad still scroll. Anything coarser holds first:
      // scroll wins if the point moves before the timer does.
      if (event.pointerType === 'mouse') return
      dragRef.current.holdTimer = setTimeout(activateDrag, DRAG_HOLD_MS)
    }
    pan.onPointerDown(event)
  }

  const onFramePointerMove = (event: PointerEvent) => {
    const drag = dragRef.current
    if (drag && event.pointerId === drag.pointerId) {
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      if (!drag.active) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
        if (drag.pointerType === 'mouse' ? distance > DRAG_MOUSE_PX : distance > DRAG_TOUCH_CANCEL_PX) {
          if (drag.pointerType === 'mouse') activateDrag()
          else clearDrag(drag)
        }
      }
      if (dragRef.current?.active) { moveDrag(event); return }
    }
    pan.onPointerMove(event)
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
        const order = sessionRef.current.items.map((item) => item.orderKey)
        const hidden = [...hiddenRef.current]
        if (onSaveOrder) {
          await onSaveOrder(order, hidden)
        } else {
          const base = apiBase.replace(/\/$/, '')
          const url = base ? `${base}/api/galleries/${encodeURIComponent(slug)}` : `/api/galleries/${encodeURIComponent(slug)}`
          const headers: Record<string, string> = { 'Content-Type': 'application/json' }
          if (token) headers.Authorization = `Bearer ${token}`
          const response = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ order, hidden }),
          })
          const payload = await response.json().catch(() => ({})) as { error?: string }
          if (!response.ok) throw new Error(payload.error || 'That order could not be saved')
        }
        announce('Order saved')
        // Entered from outside the gallery — go back to that screen
        // rather than reloading into a gallery the user never opened.
        if (doneHref) { window.location.assign(doneHref); return }
        // Return to the on-stage photograph when the draft still shows it;
        // a freshly hidden one leaves the reload on the first frame.
        const current = currentPhotoId()
        const stillVisible = items.some((item) => item.id === current && !hiddenRef.current.has(item.orderKey))
        if (onSaved) { onSaved(stillVisible ? current : null); return }
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
      // An in-flight drag cancels back to its start index rather than
      // merely putting the photograph down wherever it floated to.
      const drag = dragRef.current
      if (drag?.active) {
        finishDrag(drag, true)
        clearDrag(drag)
        return true
      }
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
      // Save, Cancel, the size slider, and the per-cell mark activate
      // natively — claiming the key would turn them into a pick-up.
      const el = event.target as HTMLElement | null
      if (el?.closest?.('.viewer-picker-actions, .viewer-edit-mark')) return true
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

  // The display:contents wrapper matters, not just the shape: hono
  // re-inserts a fragment's first child on every render, and detaching
  // the top bar kills the browser's drag on the size slider mid-gesture.
  // A real element diffs in place, so nothing under the pointer moves.
  return (
    <div style="display:contents">
      {/* The top bar is pixel-identical across modes: the mode title in
          the brand font and the tap description on the left; the sizer,
          the mode switch, and the mode's own action on the right, in
          fixed slots so nothing jumps when the mode flips. The gallery
          title and count stay in the shared bottom bar the viewer
          renders. */}
      <div class="viewer-picker-top">
        <div class="viewer-picker-title">
          <strong class="viewer-picker-mode">Reorder Photos</strong>
          <p class="viewer-picker-desc">
            {status}
            {note ? <span class="viewer-edit-alert" role="alert"> {note}</span> : null}
          </p>
        </div>
        <div class="viewer-picker-actions">
          <PickerSizer value={itemHeight} onChange={onItemHeight} />
          <button type="button" class="viewer-picker-switch" onClick={cancel} disabled={saving}>Switch to Photo Picker</button>
        </div>
        {/* The terminal slot is always 72px: a Save while the draft is
            dirty, otherwise a Cancel that exits like browse's Close —
            an untouched draft must not trap the owner in Reorder. It sits
            outside actions so the narrow layout pairs it with the mode
            switch on row two. */}
        {dirty
          ? <button type="button" class="viewer-picker-end viewer-edit-save" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          : <button type="button" class="viewer-picker-end" onClick={onDone}>Cancel</button>}
      </div>
      {/* The tap-raised mark is a touch affordance — a mouse pointer has
          hover, so when it leaves the grid the mark goes with it instead
          of staying pinned to the last cell tapped. */}
      <div
        ref={frameRef}
        class="viewer-filmstrip-frame"
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') setRevealedId(null) }}
        onPointerDown={onFramePointerDown}
        onPointerMove={onFramePointerMove}
        onPointerUp={(event) => { endDrag(event, false); pan.onPointerUp(event) }}
        onPointerCancel={(event) => { endDrag(event, true); pan.onPointerCancel(event) }}
        onWheel={pan.onWheel}
      >
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
                  <HeicImg src={item.src} preview={item.preview} media={item.media} previewMedia={item.previewMedia} galleryId={galleryId} filename={item.filename} alt="" draggable={false} onLoad={(event: Event) => (event.currentTarget as HTMLImageElement).classList.add('is-loaded')} />
                  {item.video ? <span class="viewer-filmstrip-badge">▶{item.durationSeconds ? ` ${formatDuration(item.durationSeconds)}` : ''}</span> : null}
                  {!item.video && isHeicFilename(item.filename) ? <span class="viewer-filmstrip-badge">HEIC</span> : null}
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
      {/* The dragged photograph's float — a fixed-position copy that rides
          the pointer while the draft reflows beneath it. Its transform is
          written straight onto the element so moves cost no re-render. */}
      {dragGhost ? (
        <div
          class="viewer-edit-ghost"
          ref={(el: HTMLElement | null) => {
            ghostEl.current = el
            // Positions always come from the live drag — hono may re-run
            // this callback on a draft re-render, and the mount-time
            // coordinates in state would snap the ghost backwards.
            const drag = dragRef.current
            if (el && drag) positionGhost(drag)
          }}
          style={{ width: `${Math.round(dragGhost.width)}px`, height: `${Math.round(dragGhost.height)}px` }}
          aria-hidden="true"
        >
          <HeicImg src={dragGhost.src} preview={dragGhost.preview} media={dragGhost.media} previewMedia={dragGhost.previewMedia} galleryId={galleryId} filename={dragGhost.filename} alt="" draggable={false} />
        </div>
      ) : null}
    </div>
  )
}
