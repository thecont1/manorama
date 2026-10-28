import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import { cacheFillRegistry } from '../lib/cache-fill'
import {
  mimeTypeForItem,
  previewSrcFor,
  type LibraryMediaCell,
  type LibraryMediaLease,
  type LibraryMediaLoader,
} from '../lib/library-media'
import { thumbnailEntryId } from '../lib/thumbs'

export type RailImage = {
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

const fallbackRowHeight = () =>
  typeof window === 'undefined' ? 220 : Math.min(220, window.innerHeight * .34)

/** One rail cell: an aspect-true placeholder that materializes media only
 *  while it sits inside the visible window (plus one viewport of overscan on
 *  either side). Cells with no bytes anywhere keep the stored placeholder —
 *  nothing is fetched or decoded to invent a tone. */
const RailCell = ({
  galleryId,
  image,
  index,
  left,
  width,
  visible,
  loader,
  onOpen,
}: {
  galleryId: string
  image: RailImage
  index: number
  left: number
  width: number
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
      style={{
        position: 'absolute',
        left: `${left}px`,
        width: `${width}px`,
        height: '100%',
        '--ar': `${image.width} / ${image.height}`,
        'background-image': image.placeholder?.startsWith('data:image/') ? `url(${JSON.stringify(image.placeholder)})` : undefined,
      }}
      aria-label={image.alt || `Photograph ${index + 1}`}
      onClick={() => onOpen(index)}
    >
      {src ? <img src={src} alt="" width={image.width} height={image.height} draggable={false} class="on" /> : null}
    </button>
  )
}

const firstOffsetAt = (offsets: readonly number[], target: number) => {
  let low = 0
  let high = offsets.length - 1
  let answer = Math.max(0, offsets.length - 1)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle]! >= target) {
      answer = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return answer
}

/** A virtualised aspect-true rail. Only the visible window plus one viewport
 * on either side is mounted or read; the spacer preserves the full scroll
 * geometry and every image keeps its own proportions. */
export const LibraryRail = ({ galleryId, images, loader, title, onOpen }: Props) => {
  const railRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(fallbackRowHeight)
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set())
  const [range, setRange] = useState({ start: 0, end: Math.min(images.length - 1, 7) })
  const dragRef = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)

  const layout = useMemo(() => {
    const widths = images.map((image) => image.height > 0 && image.width > 0 ? rowHeight * image.width / image.height : rowHeight)
    const offsets: number[] = []
    let totalWidth = 0
    for (const width of widths) {
      offsets.push(totalWidth)
      totalWidth += width
    }
    return { widths, offsets, totalWidth }
  }, [images, rowHeight])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    let frame = 0
    const update = () => {
      frame = 0
      const measuredHeight = rail.clientHeight
      if (measuredHeight > 0 && Math.abs(measuredHeight - rowHeight) > .5) {
        setRowHeight(measuredHeight)
        return
      }
      const viewport = rail.clientWidth || layout.totalWidth
      const left = rail.scrollLeft
      const start = Math.max(0, firstOffsetAt(layout.offsets, left - viewport))
      const end = Math.min(images.length - 1, firstOffsetAt(layout.offsets, left + viewport * 2))
      setRange((previous) => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    rail.addEventListener('scroll', schedule, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(rail)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      rail.removeEventListener('scroll', schedule)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [galleryId, images.length, layout, rowHeight])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const mounted = images.slice(range.start, range.end + 1).map((_, index) => range.start + index)
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(mounted))
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
      { root: rail, rootMargin: '0px 100%' },
    )
    for (const cell of cells) observer.observe(cell)
    return () => observer.disconnect()
  }, [galleryId, images, range.start, range.end])

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
      data-rail-total={images.length}
      data-window-start={range.start}
      data-window-end={range.end}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        if (dragRef.current?.moved) suppressClickRef.current = true
        endDrag()
      }}
      onPointerCancel={endDrag}
      onClick={(event: MouseEvent) => {
        if ((event.target as HTMLElement).closest('[data-rail-cell]')) return
        openAt(0)
      }}
    >
      <div class="lib-rail-spacer" style={{ width: `${Math.ceil(layout.totalWidth)}px`, height: '100%', position: 'relative' }}>
        {images.slice(range.start, range.end + 1).map((image, offset) => {
          const index = range.start + offset
          return (
            <RailCell
              key={image.id}
              galleryId={galleryId}
              image={image}
              index={index}
              left={layout.offsets[index]!}
              width={layout.widths[index]!}
              visible={visible.has(index)}
              loader={loader}
              onOpen={openAt}
            />
          )
        })}
      </div>
    </div>
  )
}
