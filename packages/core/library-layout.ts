import type { AccountTier } from './account'

type LibraryLayoutEntry = {
  slug: string
  retention?: 'retained' | 'pipeline'
  pinnedAt?: string | null
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
 *  until the owner re-pins. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  const pinned = entries
    .filter((entry) => Boolean(entry.pinnedAt))
    .sort((a, b) => String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1)
  const stripSet = new Set(pinned.map((entry) => entry.slug))
  return {
    strips: pinned.map((entry) => entry.slug),
    compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug),
  }
}
