import type { AccountTier } from './account'

type LibraryLayoutEntry = {
  slug: string
  retention?: 'retained' | 'pipeline'
  pinnedAt?: string | null
  /** The owner's manual rank inside whichever section the entry sits in.
   *  For an unpinned entry that is its home section; for a pinned one it
   *  is the strip section alone — the pin adds a strip view, it never
   *  reorders the home section, so a pinned entry's rank is ignored
   *  there and the card keeps its arrival slot. Absent keeps the default
   *  order — pin date for strips, arrival for home cards — and sorts
   *  after every positioned sibling, so a gallery added later lands at
   *  the end of its section rather than jumping into the middle of an
   *  arrangement the owner already made. */
  position?: number | null
}

/** Which of the owner's galleries render as full photo strips and which
 *  collapse to compact cover cards. `entries` must arrive newest-first,
 *  the same order listGalleries/sortRecent produce; both output lists
 *  preserve it.
 *
 *  The pin is a display choice only — "Pinned galleries" is the strip
 *  section, and every gallery also keeps its compact card back in its
 *  own section (Cloud, Local, or the single list). Permanence is a
 *  separate axis: it changes through the temporary↔permanent swap or a
 *  tier change, never through the pin, so a temporary gallery can sit
 *  pinned and still carry its stopwatch. Pinned rows lead by pinnedAt so
 *  the top of the Library is stable until the owner re-pins — unless a
 *  manual position says otherwise: a dragged strip card writes its rank
 *  into `position`, which outranks the default in the strip section
 *  while leaving every home section's ordering untouched. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  const rank = (entry: LibraryLayoutEntry) => entry.position ?? Number.POSITIVE_INFINITY
  const pinned = entries
    .filter((entry) => Boolean(entry.pinnedAt))
    .sort((a, b) => rank(a) - rank(b) || (String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1))
  // Every entry keeps a home card — pinned ones included. A pinned entry
  // sorts as unpositioned here: its `position` belongs to the strip
  // section's rank space, and reading it in the home section would let a
  // strip reorder leak into the owner's own arrangement. Ties fall back
  // to arrival order, so the pinned card sits exactly where it would if
  // it were not pinned.
  const homeRank = (entry: LibraryLayoutEntry) =>
    entry.pinnedAt ? Number.POSITIVE_INFINITY : rank(entry)
  // Array.prototype.sort is stable, so entries sharing a rank — every
  // unpositioned and every pinned one — keep their arrival order.
  const compact = entries
    .slice()
    .sort((a, b) => homeRank(a) - homeRank(b))
  return {
    strips: pinned.map((entry) => entry.slug),
    compact: compact.map((entry) => entry.slug),
  }
}
