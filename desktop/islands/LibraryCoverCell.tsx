import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { JSX } from 'hono/jsx/jsx-runtime'

import { cacheFillRegistry } from '../../native/lib/cache-fill'
import { coverSourceIdentity, mimeTypeForItem, type LibraryMediaCell, type LibraryMediaLease, type LibraryMediaLoader } from '../../native/lib/library-media'
import { coverEntryId, thumbnailEntryId } from '../../native/lib/thumbs'
import type { MediaReference } from '../../packages/core/encrypted-source'

type CellImage = {
  id: string
  filename?: string
  src?: string
  contentVersion?: string
  variants?: readonly { src: string; format?: string }[]
  media?: MediaReference
}

/**
 * One Library cell for an account-gallery image — a compact cover or a strip
 * frame. The vault is probed first; a miss paints the provider preview while
 * the loader's `onRemoteFallback` vaults those bytes once, so every later
 * visit reads locally — the same bargain the native rail runs. Encrypted
 * manifests probe too: a kept gallery's `thumb:` entries — and `cover:`
 * entries left by a previous visit — already hold renderable bytes, so a
 * hit skips the materialize entirely. Their `remote` is a dead URL by
 * design, so callers pass '' and no remote fetch ever runs.
 *
 * The probe itself is bounded to the visible window (with a preload
 * margin): a library of hundreds must not acquire every cell at once —
 * leaving the window releases the lease so a later gallery can use the
 * bytes. The pin is dropped but the frame stays painted: an already-decoded
 * <img> survives object-URL revocation, and blanking on exit would
 * collapse the box and drag the element across the margin again.
 *
 * `render` receives the vaulted object URL when the probe hits (and `true`),
 * so the caller can hand it to the img's preview slot; on a miss it gets
 * `undefined` and the caller's remote URL keeps painting.
 */
export function AccountCellImg({
  loader,
  vaultGalleryId,
  image,
  remote,
  render,
}: {
  loader: LibraryMediaLoader
  /** The gallery's vault identity — `offlineGalleryId(owner, slug)`. Empty
   *  until the digest resolves; the remote paint carries that gap. */
  vaultGalleryId: string | undefined
  image: CellImage
  remote: string
  render: (src: string | undefined, vaulted: boolean) => JSX.Element
}) {
  const cell = useMemo<LibraryMediaCell | null>(() => {
    if (!vaultGalleryId) return null
    return {
      galleryId: vaultGalleryId,
      // Encrypted items probe cover first: a `cover:` entry is a preview-sized
      // rendition (remote-fetched, or vaulted from a resolved frame), while
      // `thumb:` holds the materialized original — the heavier fallback a
      // saved gallery resolves when no preview was ever kept.
      entryId: image.media ? coverEntryId(image.id) : thumbnailEntryId(image.id),
      coverId: image.media ? thumbnailEntryId(image.id) : coverEntryId(image.id),
      // Manifests guarantee a filename, but sync-built records may omit it —
      // '' degrades to application/octet-stream rather than throwing.
      mimeType: mimeTypeForItem({ filename: image.filename ?? '', variants: image.variants }),
      remote,
      // The stamp names the source the cover bytes were fetched for: the
      // ref coordinates (or contentVersion) for encrypted items — whose
      // remote is a dead URL — and the rendition URL actually fetched for
      // plain ones, so a rendition swap reads as a new source.
      identity: image.media ? coverSourceIdentity(image) : remote ? `src:${remote}` : undefined,
    }
  }, [vaultGalleryId, image.id, image.media, image.src, image.contentVersion, remote])
  const [leaseSrc, setLeaseSrc] = useState<{
    galleryId: string
    entryId: string
    kind: string
    src: string | undefined
  } | null>(null)
  const leaseRef = useRef<LibraryMediaLease | null>(null)
  // The acquire is bounded to the visible window — the sentinel owns the
  // box because the img lives inside the caller's render.
  const hostRef = useRef<HTMLElement | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) setInView(entry.isIntersecting)
    }, { rootMargin: '400px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!cell || !inView) return
    let cancelled = false
    const acquire = async () => {
      const lease = await loader.acquire(cell)
      if (cancelled) {
        lease?.release()
        return
      }
      leaseRef.current?.release()
      leaseRef.current = lease ?? null
      setLeaseSrc(lease ? { galleryId: cell.galleryId, entryId: cell.entryId, kind: lease.kind, src: lease.src } : null)
    }
    void acquire()
    const off = cacheFillRegistry.subscribe(cell.galleryId, (item) => {
      // A cover fill publishes its `cover:` id; a kept fill the `thumb:` id —
      // either landing means better bytes exist now.
      if (item.entryId === cell.entryId || item.entryId === cell.coverId) void acquire()
    })
    return () => {
      cancelled = true
      off()
      leaseRef.current?.release()
      leaseRef.current = null
      // The pin is freed, but the frame stays painted: release only makes
      // the entry evictable, and an already-decoded <img> survives object-URL
      // revocation. Blanking the src here is what fed the layout flicker —
      // the box must not collapse as the cell crosses the margin.
    }
    // The cell identity is stable for a mounted cell; `cell` rebuilds per
    // render but describes the same frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell?.galleryId, cell?.entryId, loader, inView])
  // A lease belongs to the cell that acquired it — a rebuilt cell must not
  // paint the previous gallery's vaulted bytes while its own read is out.
  const vaulted = cell && leaseSrc?.kind === 'vault' &&
    leaseSrc.galleryId === cell.galleryId && leaseSrc.entryId === cell.entryId
    ? leaseSrc.src
    : undefined
  return <>
    <span ref={hostRef} aria-hidden="true" style={{ display: 'block' }} />
    {render(vaulted, vaulted !== undefined)}
  </>
}
