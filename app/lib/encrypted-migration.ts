import type { GalleryMediaItem } from './imagesource'

/**
 * The scan is authoritative for membership, but the stored manifest is
 * authoritative for curation: keep the owner's order and hidden flags for
 * every item the scan still reports, then append anything new at the tail.
 * Matching is by node ref, falling back to filename.
 */
export const mergeMigratedImages = (
  existing: readonly GalleryMediaItem[],
  scanned: readonly GalleryMediaItem[],
): GalleryMediaItem[] => {
  const scanByKey = new Map(scanned.map((image) => [image.ref ?? image.filename, image]))
  const keptKeys = new Set(existing.map((image) => image.ref ?? image.filename))
  const retained = existing.flatMap((image) => {
    const fresh = scanByKey.get(image.ref ?? image.filename)
    return fresh ? [{ ...fresh, ...(image.hidden ? { hidden: true as const } : {}) }] : []
  })
  return retained.concat(scanned.filter((image) => !keptKeys.has(image.ref ?? image.filename)))
}
