import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import { CloseIcon } from '../../app/components/admin-icons'
import { fetchGallery, updateGalleryOrder } from '../lib/api'
import { TopBar } from '../../app/components/ui/TopBar'
import { Button } from '../../app/components/ui/Button'
import { Sheet } from '../../app/components/ui/Sheet'
import { pushOverlay } from '../../app/lib/overlay-stack'
import { installReorderCloseGuard } from '../lib/reorder-close-guard'
import {
  createReorderSession,
  discardReorder,
  layoutPhotoRows,
  moveHeldItem,
  pickUpItem,
  putDownItem,
  reorderIsDirty,
  visibleRowRange,
  type ReorderState,
} from '../../packages/core/reorder-session'

/**
 * The gallery editor. Resequencing is the only edit it makes, and it makes it
 * on the same matrix the photo picker uses — same cells, same fixed height,
 * aspect-true widths, zero gaps, and the same shocking pink marking the
 * photograph in hand. A photograph is picked up with one tap and put down
 * with another; the ones between it and its new place shift along as they
 * would on a table.
 *
 * The order is held locally until it is saved, so a half-finished shuffle is
 * never written to the gallery. The matrix is virtualised with the core
 * layout helpers: only the complete rows inside the visible window (plus one
 * row of overscan) are mounted, so a 1,000-photograph gallery stays cheap.
 *
 * Close, Escape and Android back all route through one dirty guard: an
 * unsaved shuffle opens a confirmation (Continue editing / Discard) instead
 * of silently dropping the draft. Reset discards to the saved keys and closes
 * after a short settle.
 */
type Props = {
  owner: string
  slug: string
  title: string
  apiBase: string
  onClose: () => void
  onSaved?: () => void
}

type EditorPhoto = {
  id: string
  /** The key an order is matched against. Deliberately not `id`: `id` is the
   *  manifest's own handle, while the repository reorders by `ref ?? filename`.
   *  An order sent in ids matches nothing server-side and is dropped without
   *  complaint, which reaches the owner as a save that did nothing. */
  orderKey: string
  src: string
  width: number
  height: number
  label: string
}

/** Mirrors `imageKey` in `app/lib/gallery-repository.ts`. The two must agree,
 *  which is why the save below reads the order back before calling it saved. */
export const orderKeyOf = (image: GalleryMediaItem): string =>
  image.ref ?? image.filename ?? image.id

const photosFrom = (manifest: GalleryManifest): EditorPhoto[] =>
  manifest.images.map((image, index) => ({
    id: image.id,
    orderKey: orderKeyOf(image),
    src: isVideoItem(image) ? image.poster.src : image.variants?.[0]?.src ?? image.src,
    width: image.width,
    height: image.height,
    label: image.alt || image.filename || `Photograph ${index + 1}`,
  }))

/** The matrix row height follows the viewport, like the picker. The measured
 *  pixel value also drives complete-row virtualisation. */
const editorRowHeight = () => Math.max(72, Math.min(160, Math.round((typeof window === 'undefined' ? 812 : window.innerHeight) * .12)))
/** Reset holds this beat before closing so the settle reads as deliberate. */
const SETTLE_MS = 240

export default function GalleryEditor({ owner, slug, title, apiBase, onClose, onSaved }: Props) {
  const [session, setSession] = useState<ReorderState<EditorPhoto> | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [settling, setSettling] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [viewport, setViewport] = useState({ width: 375, height: 812 })
  const [rowHeight, setRowHeight] = useState(editorRowHeight)
  const [scrollTop, setScrollTop] = useState(0)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const sectionRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Settling reads must be synchronous: a back press between setSettling and
  // the rerender would otherwise slip past both close guards.
  const settlingRef = useRef(false)
  const settleTimerRef = useRef<number | undefined>(undefined)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const sessionRef = useRef(session)
  sessionRef.current = session

  const dirty = session ? reorderIsDirty(session) : false
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const confirmRef = useRef(confirmOpen)
  confirmRef.current = confirmOpen

  useEffect(() => {
    let active = true
    setNote('Reading this gallery…')
    void fetchGallery(apiBase, owner, slug)
      .then(({ manifest }) => {
        if (!active) return
        const loaded = photosFrom(manifest)
        setSession(createReorderSession(loaded))
        setNote(loaded.length ? null : 'This gallery has no photographs yet.')
      })
      .catch((reason) => {
        if (active) setNote(reason instanceof Error ? reason.message : 'This gallery could not be read.')
      })
    return () => { active = false }
  }, [apiBase, owner, slug])

  /** The scroll area is the measuring stick: its client box is the matrix
   *  viewport. ResizeObserver keeps it honest across rotation/desktop resizes;
   *  without one (tests, old webviews) a resize listener stands in. */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      setRowHeight(editorRowHeight())
      const width = el.clientWidth
      const height = el.clientHeight
      if (width > 0 || height > 0) {
        setViewport((current) =>
          current.width === width && current.height === height
            ? current
            : { width: width || current.width, height: height || current.height })
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /** The close path shared by the top-bar Close button, Escape (via the
   *  overlay stack) and the shell's Android back. Unsaved edits open the
   *  confirmation instead of closing. */
  const requestClose = () => {
    if (confirmRef.current || settlingRef.current) return
    if (dirtyRef.current) setConfirmOpen(true)
    else onCloseRef.current()
  }
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  /** The dirty guard the shell asks on Android back. True means the back press
   *  belongs to the editor and must be swallowed. */
  useEffect(() => installReorderCloseGuard(() => {
    if (confirmRef.current || settlingRef.current) return true
    if (dirtyRef.current) {
      setConfirmOpen(true)
      return true
    }
    return false
  }), [])

  // The settle timer outlives a render; clear it if the editor unmounts first
  // so a delayed onClose cannot fire after teardown.
  useEffect(() => () => window.clearTimeout(settleTimerRef.current), [])

  /** The editor is itself a modal: focus lands on it, Tab is trapped inside
   *  by the overlay stack, and Escape goes through the same dirty guard. */
  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    const release = pushOverlay({ host: section, onEscape: () => requestCloseRef.current() })
    section.focus()
    return release
  }, [])

  const finePointer = useMemo(() => {
    if (typeof window === 'undefined') return false
    const matchMedia = window.matchMedia
    return typeof matchMedia === 'function' ? matchMedia('(pointer: fine)').matches : false
  }, [])

  const pickUp = (photo: EditorPhoto) => {
    const current = sessionRef.current
    if (!current) return
    const next = pickUpItem(current, photo.id)
    if (next === current) return
    setSession(next)
    setNote(`“${photo.label}” is in hand.`)
  }

  const putDown = (target: EditorPhoto) => {
    const current = sessionRef.current
    if (!current?.heldId) return
    const heldId = current.heldId
    const next = putDownItem(current, target.id)
    setSession(next)
    setDropTarget(null)
    if (heldId === target.id) {
      setNote('Nothing is in hand now.')
      return
    }
    if (next === current) return
    const movedAt = next.items.findIndex((item) => item.id === heldId)
    const moved = next.items[movedAt]
    if (moved) setNote(`Moved “${moved.label}” to position ${movedAt + 1} of ${next.items.length}.`)
  }

  const save = async () => {
    const current = sessionRef.current
    if (!current || busy || !reorderIsDirty(current)) return
    setBusy(true)
    setNote('Saving the new order…')
    const intended = current.items.map((photo) => photo.orderKey)
    try {
      await updateGalleryOrder(apiBase, slug, intended)
      // The route tolerates keys it does not recognise and still answers 200,
      // so a key that has drifted from the repository's own would read as a
      // silent no-op — the exact failure this read-back exists to catch.
      const { manifest } = await fetchGallery(apiBase, owner, slug)
      const stored = manifest.images.map(orderKeyOf)
      if (!intended.every((key, index) => stored[index] === key)) {
        setNote('The gallery did not take that order, so nothing was changed. Try again.')
        return
      }
      setSession((previous) => previous ? { ...previous, savedKeys: intended } : previous)
      setNote('New order saved.')
      onSavedRef.current?.()
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'That order could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  /** Reset is the editor's cancel: it restores the saved keys and closes after
   *  the settle beat. The draft is thrown away either way. */
  const reset = () => {
    const current = sessionRef.current
    if (!current || busy || settling) return
    settlingRef.current = true
    setSettling(true)
    setSession(discardReorder(current))
    setDropTarget(null)
    setNote('Back to the saved order.')
    settleTimerRef.current = window.setTimeout(() => {
      settlingRef.current = false
      onCloseRef.current()
    }, SETTLE_MS)
  }

  const layout = useMemo(() => {
    if (!session) return null
    return layoutPhotoRows(session.items, viewport.width, rowHeight)
  }, [session, viewport.width, rowHeight])

  const range = useMemo(() => {
    if (!layout || layout.rows.length === 0) return { start: 0, end: -1 }
    return visibleRowRange(layout.rows, rowHeight, scrollTop, viewport.height)
  }, [layout, scrollTop, viewport.height, rowHeight])

  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    session?.items.forEach((item, index) => map.set(item.id, index))
    return map
  }, [session])

  const heldId = session?.heldId ?? null
  const itemCount = session?.items.length ?? 0
  const hint = heldId
    ? 'Tap where it should land.'
    : 'Pick a photograph, then tap its new place.'

  /** Keyboard moves mirror the tap contract: Ctrl/Meta+arrows step the held
   *  photograph, Home/End jump to the boundary. Nothing moves without a hold.
   *  The handler lives on the modal itself, so the keys only act while focus
   *  is inside the editor (never while a sheet owns the top overlay). */
  const onSectionKeyDown = (event: KeyboardEvent) => {
    const current = sessionRef.current
    if (!current?.heldId || confirmOpen || settling) return
    const from = current.items.findIndex((item) => item.id === current.heldId)
    if (from < 0) return
    const meta = event.ctrlKey || event.metaKey
    let to: number | null = null
    if (meta && event.key === 'ArrowLeft') to = from - 1
    else if (meta && event.key === 'ArrowRight') to = from + 1
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = current.items.length - 1
    if (to === null || to === from) return
    event.preventDefault()
    const next = moveHeldItem(current, to)
    if (next === current) return
    setSession(next)
    const movedAt = next.items.findIndex((item) => item.id === current.heldId)
    const moved = next.items[movedAt]
    if (moved) setNote(`Moved “${moved.label}” to position ${movedAt + 1} of ${next.items.length}.`)
    // Keep the held photograph visible and focused: the destination row can
    // sit outside the mounted window, and a remounting row drops focus.
    const nextLayout = layoutPhotoRows(next.items, viewport.width, rowHeight)
    const targetRow = nextLayout.rows.find((row) => row.cells.some((cell) => cell.item.id === current.heldId))
    requestAnimationFrame(() => {
      if (targetRow && scrollRef.current) scrollRef.current.scrollTop = targetRow.top
      requestAnimationFrame(() => {
        sectionRef.current?.querySelector<HTMLElement>(`[data-photo="${current.heldId}"]`)?.focus({ preventScroll: true })
      })
    })
  }

  const dragStart = (photo: EditorPhoto) => (event: DragEvent) => {
    if (!finePointer) return
    event.dataTransfer?.setData('text/plain', photo.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    setDropTarget(null)
    pickUp(photo)
  }
  const dragOver = (photo: EditorPhoto) => (event: DragEvent) => {
    if (!finePointer || !sessionRef.current?.heldId) return
    event.preventDefault()
    if (sessionRef.current.heldId !== photo.id) setDropTarget(photo.id)
  }
  const drop = (photo: EditorPhoto) => (event: DragEvent) => {
    if (!finePointer) return
    event.preventDefault()
    putDown(photo)
  }
  const dragEnd = () => setDropTarget(null)

  return (
    <>
      <section
        ref={sectionRef}
        class={`native-editor${settling ? ' is-settling' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Reorder ${title}`}
        data-gallery-editor
        tabIndex={-1}
        onKeyDown={onSectionKeyDown}
      >
        <TopBar
          start={
            <Button
              variant="quiet"
              class="native-editor-close"
              aria-label="Close the editor"
              onClick={requestClose}
              disabled={busy || settling}
            >
              <CloseIcon />
            </Button>
          }
          title="Reorder"
          end={
            <Button
              variant="quiet"
              class="native-editor-reset"
              onClick={reset}
              disabled={!session || busy || settling}
            >
              Reset
            </Button>
          }
        />
        <div class="native-editor-meta">
          <h2 class="native-editor-title">{title}</h2>
          <p class="native-editor-count">{itemCount} {itemCount === 1 ? 'photograph' : 'photographs'}</p>
          <p class="native-editor-hint">{hint}</p>
        </div>
        <p class="native-editor-note" role="status" aria-live="polite">{note ?? ''}</p>
        <div
          class="native-editor-scroll"
          ref={scrollRef}
          data-editor-scroll
          onScroll={(event) => setScrollTop((event.currentTarget as HTMLDivElement).scrollTop)}
        >
          {layout ? (
            <div class="native-global-grid native-editor-virtual" style={{ height: `${layout.totalHeight}px` }}>
              {layout.rows.slice(Math.max(0, range.start), range.end + 1).map((row, index) => {
                const rowIndex = Math.max(0, range.start) + index
                return (
                  <div key={row.top} class="native-editor-row" data-editor-row={rowIndex} style={{ position: 'absolute', top: `${row.top}px`, left: 0, width: `${row.width}px`, height: `${rowHeight}px` }}>
                    {row.cells.map((cell) => {
                      const photo = cell.item
                      const isHeld = heldId === photo.id
                      return (
                        <button
                          key={photo.id}
                          type="button"
                          class={`native-global-cell native-editor-cell${isHeld ? ' is-active' : ''}${dropTarget === photo.id ? ' is-drop-target' : ''}`}
                          data-photo={photo.id}
                          data-order-key={photo.orderKey}
                          aria-label={`${photo.label}, position ${(indexOf.get(photo.id) ?? 0) + 1} of ${itemCount}`}
                          aria-pressed={isHeld ? 'true' : 'false'}
                          disabled={busy || settling}
                          style={{ width: `${cell.width}px`, height: '100%' }}
                          draggable={finePointer}
                          onDragStart={dragStart(photo)}
                          onDragOver={dragOver(photo)}
                          onDrop={drop(photo)}
                          onDragEnd={dragEnd}
                          onClick={() => (heldId ? putDown(photo) : pickUp(photo))}
                        >
                          <img
                            src={photo.src}
                            width={photo.width}
                            height={photo.height}
                            alt=""
                            loading="lazy"
                            draggable={false}
                          />
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
        <footer class="native-editor-actions">
          <Button
            variant="primary"
            block
            class="native-editor-save"
            disabled={!dirty || busy || settling || !session}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save order'}
          </Button>
        </footer>
      </section>
      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Discard unsaved changes?" size="auto">
        <p class="native-editor-confirm-copy">Your recent reorder is not saved. Discard it and close?</p>
        <div class="native-editor-confirm-actions">
          <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Continue editing</Button>
          <Button
            variant="destructive"
            onClick={() => {
              const current = sessionRef.current
              if (current) setSession(discardReorder(current))
              setConfirmOpen(false)
              onCloseRef.current()
            }}
          >
            Discard
          </Button>
        </div>
      </Sheet>
    </>
  )
}
