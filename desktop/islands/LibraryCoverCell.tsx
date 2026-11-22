import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { JSX } from 'hono/jsx/jsx-runtime'

import { cacheFillRegistry } from '../../native/lib/cache-fill'
import { mimeTypeForItem, type LibraryMediaCell, type LibraryMediaLease, type LibraryMediaLoader } from '../../native/lib/library-media'
import { coverEntryId, thumbnailEntryId } from '../../native/lib/thumbs'
import type { MediaReference } from '../../packages/core/encrypted-source'

type CellImage = {
  id: string
  filename?: string
  variants?: readonly { src: string; format?: string }[]
  media?: MediaReference
}

/**
 * One Library cell for an account-gallery image — a compact cover or a strip
 * frame. The vault is probed first; a miss paints the provider preview while
 * the loader's `onRemoteFallback` vaults those bytes once, so every later
 * visit reads locally — the same bargain the native rail runs. Encrypted
 * manifests already resolve through the key/vault path in HeicImg, so cells
 * skip them entirely.
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
    if (!vaultGalleryId || image.media) return null
    return {
      galleryId: vaultGalleryId,
      entryId: thumbnailEntryId(image.id),
      coverId: coverEntryId(image.id),
      // Manifests guarantee a filename, but sync-built records may omit it —
      // '' degrades to application/octet-stream rather than throwing.
      mimeType: mimeTypeForItem({ filename: image.filename ?? '', variants: image.variants }),
      remote,
    }
  }, [vaultGalleryId, image.id, image.media, remote])
  const [leaseSrc, setLeaseSrc] = useState<{ kind: string; src: string | undefined } | null>(null)
  const leaseRef = useRef<LibraryMediaLease | null>(null)
  useEffect(() => {
    if (!cell) return
    let cancelled = false
    const acquire = async () => {
      const lease = await loader.acquire(cell)
      if (cancelled) {
        lease?.release()
        return
      }
      leaseRef.current?.release()
      leaseRef.current = lease ?? null
      setLeaseSrc(lease ? { kind: lease.kind, src: lease.src } : null)
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
    }
    // The cell identity is stable for a mounted cell; `cell` rebuilds per
    // render but describes the same frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell?.galleryId, cell?.entryId, loader])
  const vaulted = cell && leaseSrc?.kind === 'vault' ? leaseSrc.src : undefined
  return render(vaulted, vaulted !== undefined)
}
