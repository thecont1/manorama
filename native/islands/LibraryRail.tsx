import { useEffect, useRef, useState } from 'hono/jsx'
import { cacheFillRegistry } from '../lib/cache-fill'
import {
  mimeTypeForItem,
  previewSrcFor,
  type LibraryMediaCell,
  type LibraryMediaLease,
  type LibraryMediaLoader,
} from '../lib/library-media'
import { thumbnailEntryId } from '../lib/thumbs'

type RailImage = {
  id: string
  filename: string
  src: string
  width: number
  height: number
  alt: string
  placeholder: string
  variants?: readonly { src: string; format?: string }[]
  type?: 'video'
  poster?: { src: string }
}

type Props = {
  /** Vault identity of the gallery — also the cache-fill subscription key. */
  galleryId: string
  images: readonly RailImage[]
  loader: LibraryMediaLoader
  title: string
  /** index is the tapped thumbnail's position; strip background opens 0. */
  onOpen(index: number): void
}

/** One rail cell: an aspect-true placeholder that materializes media only
 *  while it sits inside the visible window (plus one viewport of overscan on
 *  either side). Cells with no bytes anywhere keep the stored placeholder —
 *  nothing is fetched or decoded to invent a tone. */
const RailCell = ({
  galleryId,
  image,
  index,
  visible,
  loader,
  onOpen,
}: {
  galleryId: string
  image: RailImage
  index: number
  visible: boolean
  loader: LibraryMediaLoader
  onOpen(index: number): void
}) => {
  const [src, setSrc] = useState<string | undefined>(undefined)
  const leaseRef = useRef<LibraryMediaLease | null>(null)
  const cell: LibraryMediaCell = {
    galleryId,
    entryId: thumbnailEntryId(image.id),
    mimeType: mimeTypeForItem(image),
    remote: previewSrcFor(image),
  }

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    const acquire = async () => {
      const lease = await loader.acquire(cell)
      if (cancelled) {
        lease?.release()
        return
      }
      leaseRef.current?.release()
      leaseRef.current = lease ?? null
      setSrc(lease?.src)
    }
    void acquire()
    // A mid-fill vault write can make saved bytes available after the remote
    // preview already painted — the registry event re-reads the same cell.
    const off = cacheFillRegistry.subscribe(galleryId, (item) => {
      if (item.entryId === cell.entryId) void acquire()
    })
    return () => {
      cancelled = true
      off()
      leaseRef.current?.release()
      leaseRef.current = null
    }
    // The cell identity is stable for a mounted thumb; `cell` rebuilds per
    // render but describes the same frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, galleryId, image.id])

  return (
    <button
      type="button"
      class="lib-th"
      data-rail-cell
      data-at={index}
      style={{ '--ar': `${image.width} / ${image.height}`, 'background-image': image.placeholder ? `url("${image.placeholder}")` : undefined }}
      aria-label={image.alt || `Photograph ${index + 1}`}
      onClick={() => onOpen(index)}
    >
      {src ? <img src={src} alt="" width={image.width} height={image.height} draggable={false} class="on" /> : null}
    </button>
  )
}

/** The Library rail: every photograph of the gallery at its own proportions,
 *  abutting, pannable by touch, trackpad or a 6px-threshold mouse drag. Only
 *  cells inside the visible window plus one viewport of overscan hold media —
 *  a long rail costs nothing until it is looked along. */
export const LibraryRail = ({ galleryId, images, loader, title, onOpen }: Props) => {
  const railRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set())
  const dragRef = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (test DOMs, very old shells): every cell may materialize —
      // the loader's own budgets still bound what is actually held.
      setVisible(new Set(images.map((_, index) => index)))
      return
    }
    const cells = [...rail.querySelectorAll<HTMLElement>('[data-rail-cell]')]
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          let next: Set<number> | undefined
          for (const entry of entries) {
            const at = Number((entry.target as HTMLElement).dataset.at)
            if (entry.isIntersecting === previous.has(at)) continue
            next ??= new Set(previous)
            if (entry.isIntersecting) next.add(at)
            else next.delete(at)
          }
          return next ?? previous
        })
      },
      // One viewport of overscan either side, so a fast pan meets decoded
      // media instead of watching every cell load at once.
      { root: rail, rootMargin: '0px 100%' },
    )
    for (const cell of cells) observer.observe(cell)
    return () => observer.disconnect()
  }, [galleryId, images.length])

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const rail = railRef.current
    if (!rail) return
    dragRef.current = { x: event.clientX, scroll: rail.scrollLeft, moved: false }
  }
  const onPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current
    const rail = railRef.current
    if (!drag || !rail) return
    const dx = event.clientX - drag.x
    // Capture only after 6px of travel so an ordinary click still opens.
    if (!drag.moved && Math.abs(dx) > 6) {
      drag.moved = true
      rail.classList.add('lib-rail--dragging')
      rail.setPointerCapture?.(event.pointerId)
    }
    if (drag.moved) rail.scrollLeft = drag.scroll - dx
  }
  const endDrag = () => {
    dragRef.current = null
    railRef.current?.classList.remove('lib-rail--dragging')
  }
  const suppressClickRef = useRef(false)
  /** Every open path asks this first — the click after a real pan opens
   *  nothing. */
  const openAt = (index: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onOpen(index)
  }

  return (
    <div
      ref={railRef}
      class="lib-rail"
      role="group"
      aria-label={`${title} — photographs`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        if (dragRef.current?.moved) suppressClickRef.current = true
        endDrag()
      }}
      onPointerCancel={endDrag}
      onClick={(event: MouseEvent) => {
        // Empty rail space (a rail shorter than the card) opens the first
        // photograph — clicks on a thumb are handled by its own button.
        if ((event.target as HTMLElement).closest('[data-rail-cell]')) return
        openAt(0)
      }}
    >
      {images.map((image, index) => (
        <RailCell
          key={image.id}
          galleryId={galleryId}
          image={image}
          index={index}
          visible={visible.has(index)}
          loader={loader}
          onOpen={openAt}
        />
      ))}
    </div>
  )
}
