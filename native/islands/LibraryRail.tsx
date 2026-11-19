import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import { cacheFillRegistry } from '../lib/cache-fill'
import {
  mimeTypeForItem,
  railPreviewSrcFor,
  type LibraryMediaCell,
  type LibraryMediaLease,
  type LibraryMediaLoader,
} from '../lib/library-media'
import { thumbnailEntryId } from '../lib/thumbs'
import { deviceImageDpr } from '../../packages/core/image-staging'

export type RailImage = {
  id: string
  filename: string
  src: string
  width: number
  height: number
  alt: string
  placeholder?: string
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
  /** The details surface's preview strip — it never scrolls, so the mounted
   *  window is exactly the cells the visible width can hold (plus the small
   *  lookahead the collapse-cap grants cells still waiting on bytes). */
  preview?: boolean
}

const fallbackRowHeight = () =>
  typeof window === 'undefined' ? 330 : Math.min(330, window.innerHeight * .5)

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
  height,
  visible,
  loader,
  onLoaded,
  onOpen,
  compact = false,
  clipped = false,
}: {
  compact?: boolean
  galleryId: string
  image: RailImage
  index: number
  left: number
  width: number
  /** The row height — every image in a strip is the same height. */
  height?: number
  visible: boolean
  /** Preview cells mounted past the clip paint nothing — keep them out of
   *  the Tab order so keyboard traversal never lands on an invisible thumb. */
  clipped?: boolean
  loader: LibraryMediaLoader
  onLoaded?(index: number, dims: { width: number; height: number }): void
  onOpen(index: number): void
}) => {
  const [src, setSrc] = useState<string | undefined>(undefined)
  const [natural, setNatural] = useState<{ src: string; width: number; height: number } | null>(null)
  const leaseRef = useRef<LibraryMediaLease | null>(null)
  const cell: LibraryMediaCell = {
    galleryId,
    entryId: thumbnailEntryId(image.id),
    mimeType: mimeTypeForItem(image),
    remote: railPreviewSrcFor(image),
  }

  useEffect(() => {
    if (!visible) { setSrc(undefined); return }
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

  const dimensions = natural && natural.src === src ? natural : image
  const dpr = deviceImageDpr(typeof window === 'undefined' ? 1 : window.devicePixelRatio)
  // Only self-contained data-SVG placeholders may paint — a remote URL in a
  // CSS url() would fetch an arbitrary tracker (same safePlaceholder rule the
  // manifest validator enforces). Delivered as a custom property so the
  // url() never passes through a declaration parser on the way in.
  const placeholderPaint = image.placeholder?.startsWith('data:image/svg+xml') && !/["<>\\\n\r]/.test(image.placeholder)
    ? `url("${image.placeholder}")`
    : undefined
  const cellStyle: Record<string, string> = compact
    ? { aspectRatio: `${dimensions.width} / ${dimensions.height}`, ...(natural && natural.src === src ? { maxWidth: `${dimensions.width / dpr}px`, maxHeight: `${dimensions.height / dpr}px` } : {}) }
    : {
        position: 'absolute',
        left: `${left}px`,
        width: `${width}px`,
        height: height !== undefined ? `${height}px` : '100%',
        '--ar': `${image.width} / ${image.height}`,
      }
  if (placeholderPaint) cellStyle['--ph'] = placeholderPaint
  return (
    <button
      type="button"
      class={compact ? 'lib-th native-library-cover' : 'lib-th'}
      data-rail-cell
      data-at={index}
      tabIndex={clipped ? -1 : undefined}
      style={cellStyle}
      aria-label={image.alt || `Photograph ${index + 1}`}
      onClick={() => onOpen(index)}
    >
      {src ? <img src={src} alt="" width={image.width} height={image.height} draggable={false} class="on"
        onLoad={(event: Event) => {
          const img = event.currentTarget as HTMLImageElement
          if (img.naturalWidth && img.naturalHeight) {
            setNatural({ src, width: img.naturalWidth, height: img.naturalHeight })
            onLoaded?.(index, { width: img.naturalWidth, height: img.naturalHeight })
          }
        }}
        onError={() => {
          setSrc(undefined)
          // A failed thumb still resolves the cell at its manifest size —
          // the window calculation advances past it instead of pinning the
          // lookahead cluster on a zero-width gap.
          onLoaded?.(index, { width: Math.max(1, image.width), height: Math.max(1, image.height) })
        }}
      /> : null}
    </button>
  )
}

export const LibraryCover = ({ galleryId, images, loader, title, onOpen }: Props) => {
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const image = images[0]
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => setVisible(Boolean(entries.at(-1)?.isIntersecting)))
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={host} class="native-library-cover-slot" role="group" aria-label={`${title} — cover`}>
    {image ? <RailCell compact galleryId={galleryId} image={image} index={0} left={0} width={0} visible={visible} loader={loader} onOpen={onOpen} /> : null}
  </div>
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
export const LibraryRail = ({ galleryId, images, loader, title, onOpen, preview = false }: Props) => {
  const railRef = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(fallbackRowHeight)
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set())
  // Ids whose bytes have decoded this session, with the bitmap's own size.
  // Cells reserve no space before that — the strip is always a contiguous
  // cluster of real photographs at their honest rendition size, the same
  // contract the desktop strip's width:auto flow produces.
  const [loaded, setLoaded] = useState<ReadonlyMap<string, { width: number; height: number }>>(() => new Map())
  const [range, setRange] = useState({ start: 0, end: Math.min(images.length - 1, 7) })
  const dragRef = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)

  const layout = useMemo(() => {
    const widths = images.map((image) => {
      const dims = loaded.get(image.id)
      // Every image in the strip rides at the strip's height — the decoded
      // bitmap owns the aspect, the row owns the height. Undecoded cells
      // estimate from the manifest until their bytes land.
      if (dims) return rowHeight * dims.width / dims.height
      return image.height > 0 && image.width > 0 ? rowHeight * image.width / image.height : rowHeight
    })
    const offsets: number[] = []
    let totalWidth = 0
    let estTotal = 0
    for (let index = 0; index < images.length; index++) {
      offsets.push(totalWidth)
      totalWidth += loaded.has(images[index]!.id) ? widths[index]! : 0
      estTotal += widths[index]!
    }
    return { widths, offsets, totalWidth, estTotal }
  }, [images, rowHeight, loaded])

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
      // Before layout the rail measures zero; falling back to totalWidth
      // would mount every cell. Bound the overscan to the device width until
      // a real measurement arrives.
      const viewport = rail.clientWidth || window.innerWidth
      const left = preview ? 0 : rail.scrollLeft
      // A cell straddling the overscan boundary starts before it but still
      // paints inside it — keep it mounted or the strip shows a gap.
      const first = firstOffsetAt(layout.offsets, left - viewport)
      const straddler = first > 0 && layout.offsets[first - 1]! + (layout.widths[first - 1] ?? 0) > left - viewport
      const start = preview ? 0 : Math.max(0, straddler ? first - 1 : first)
      // A preview mounts only what the frame can show — one viewport of strip,
      // no overscan. The scrollable rail reads a viewport further ahead.
      let end = firstOffsetAt(layout.offsets, preview ? viewport : left + viewport * 2)
      // Every unloaded cell collapses onto the cluster's end offset, so a
      // target past it finds the last index — cap the lookahead to a handful
      // of cells waiting there instead. Never below start: a scroll beyond
      // the cluster still owns its window.
      if (layout.offsets[end]! >= layout.totalWidth && layout.totalWidth < layout.estTotal) {
        end = Math.max(start, Math.min(end, firstOffsetAt(layout.offsets, layout.totalWidth) + 7))
      }
      end = Math.min(images.length - 1, end)
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
  }, [galleryId, images.length, layout, rowHeight, preview])

  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const mounted = images.slice(range.start, range.end + 1).map((_, index) => range.start + index)
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(mounted))
      return
    }
    const cells = [...rail.querySelectorAll<HTMLElement>('[data-rail-cell]')]
    // root: rail only knows the strip. An offscreen card's cells still
    // intersect that strip, so the page gate has to open the cell watcher.
    // The gate is constructed first so a callback can close over the cell
    // observer, and tests can tell the two apart by construction order.
    let observer!: IntersectionObserver
    // Cell entries already queued when the rail leaves would land after the
    // exit clears the set and reacquire media offscreen. The gate flag drops
    // whatever is still in flight; takeRecords() empties the queue it can.
    let gateOpen = false
    const gate = new IntersectionObserver((entries) => {
      // Batches arrive oldest-first — the last entry is the rail's state
      // now, so a rapid exit-and-return re-watches its cells.
      gateOpen = Boolean(entries.at(-1)?.isIntersecting)
      if (gateOpen) for (const cell of cells) observer.observe(cell)
      else {
        observer.takeRecords()
        observer.disconnect()
        setVisible(new Set())
      }
    })
    observer = new IntersectionObserver(
      (entries) => {
        if (!gateOpen) return
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
    gate.observe(rail)
    return () => { gate.disconnect(); observer.disconnect() }
  }, [galleryId, images, range.start, range.end])

  const onPointerDown = (event: PointerEvent) => {
    if (preview || event.pointerType !== 'mouse' || event.button !== 0) return
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
      class={preview ? 'lib-rail lib-rail--preview' : 'lib-rail'}
      role="group"
      aria-label={`${title} — photographs`}
      data-rail-preview={preview || undefined}
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
              width={loaded.has(image.id) ? layout.widths[index] : 0}
              height={rowHeight}
              visible={visible.has(index)}
              clipped={preview && !visible.has(index)}
              loader={loader}
              onLoaded={(at, dims) => setLoaded((previous) => {
                const stored = previous.get(images[at]!.id)
                return stored && stored.width === dims.width && stored.height === dims.height
                  ? previous
                  : new Map(previous).set(images[at]!.id, dims)
              })}
              onOpen={openAt}
            />
          )
        })}
      </div>
    </div>
  )
}
