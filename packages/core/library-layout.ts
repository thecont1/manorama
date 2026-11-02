import type { AccountTier } from './account'

/** How many galleries earn a photo-strip card, for every tier. The rail
 *  shows the whole gallery — this bounds only how many cards get one;
 *  everything past the limit becomes a compact card. The same number caps
 *  pins: a pin is a claim on a strip slot, so a fourth pin has nowhere to
 *  go. */
export const LIBRARY_STRIP_LIMIT = 3
export const PIN_LIMIT = LIBRARY_STRIP_LIMIT

type LibraryLayoutEntry = {
  slug: string
  retention?: 'retained' | 'pipeline'
  pinnedAt?: string | null
}

/** Which of the owner's galleries render as full photo strips and which
 *  collapse to compact rows. `entries` must arrive newest-first, the same
 *  order listGalleries/sortRecent produce; both output lists preserve it.
 *
 *  Free: the first LIBRARY_STRIP_LIMIT retained galleries strip; every
 *  other gallery compacts — pipeline rows plus any retained surplus a
 *  downgrade left behind (the retained cap binds at creation, not
 *  retroactively).
 *
 *  Visionary: pinned galleries strip first — oldest pin first, so the top
 *  of the Library is stable until the owner re-pins — then the most recent
 *  unpinned until the limit; everything else compacts. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  if (tier !== 'pro') {
    const strips = entries
      .filter((entry) => entry.retention !== 'pipeline')
      .slice(0, LIBRARY_STRIP_LIMIT)
      .map((entry) => entry.slug)
    const stripSet = new Set(strips)
    return { strips, compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug) }
  }
  const pinned = entries
    .filter((entry) => Boolean(entry.pinnedAt))
    .sort((a, b) => String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1)
  const unpinned = entries.filter((entry) => !entry.pinnedAt)
  const strips = [...pinned, ...unpinned].slice(0, LIBRARY_STRIP_LIMIT).map((entry) => entry.slug)
  const stripSet = new Set(strips)
  return { strips, compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug) }
}
