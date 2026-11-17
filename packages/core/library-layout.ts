import type { AccountTier } from './account'

type LibraryLayoutEntry = {
  slug: string
  retention?: 'retained' | 'pipeline'
  pinnedAt?: string | null
  /** The owner's manual rank inside whichever section the entry sits in.
   *  Absent keeps the default order — pin date for strips, arrival for
   *  compact — and sorts after every positioned sibling, so a gallery
   *  added later lands at the end of its section rather than jumping
   *  into the middle of an arrangement the owner already made. */
  position?: number | null
}

/** Which of the owner's galleries render as full photo strips and which
 *  collapse to compact cover cards. `entries` must arrive newest-first,
 *  the same order listGalleries/sortRecent produce; both output lists
 *  preserve it.
 *
 *  The pin is a display choice only — "Pinned galleries" is the strip
 *  section, everything else renders as compact cards under "Your
 *  galleries". Permanence is a separate axis: it changes through the
 *  temporary↔permanent swap or a tier change, never through the pin, so
 *  a temporary gallery can sit pinned and still carry its stopwatch.
 *  Pinned rows lead by pinnedAt so the top of the Library is stable
 *  until the owner re-pins — unless a manual position says otherwise:
 *  a dragged card writes its rank into `position`, which outranks the
 *  default in its own section while leaving every other section's
 *  ordering untouched. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  const rank = (entry: LibraryLayoutEntry) => entry.position ?? Number.POSITIVE_INFINITY
  const pinned = entries
    .filter((entry) => Boolean(entry.pinnedAt))
    .sort((a, b) => rank(a) - rank(b) || (String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1))
  const stripSet = new Set(pinned.map((entry) => entry.slug))
  // Array.prototype.sort is stable, so entries sharing a rank — every
  // unpositioned one — keep their arrival order.
  const compact = entries
    .filter((entry) => !stripSet.has(entry.slug))
    .sort((a, b) => rank(a) - rank(b))
  return {
    strips: pinned.map((entry) => entry.slug),
    compact: compact.map((entry) => entry.slug),
  }
}
