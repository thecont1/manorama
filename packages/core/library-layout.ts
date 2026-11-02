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
 *  A pin is a claim on permanence: "Your galleries" is the permanent
 *  section, so what strips is what is permanent. For Visionary every
 *  gallery is retained already, so the pin itself decides — pinned
 *  galleries strip, oldest pin first so the top of the Library is stable
 *  until the owner re-pins; every unpinned gallery compacts, and there is
 *  no cap on how many strips an owner keeps.
 *
 *  For Free the retained set *is* the pinned set — pinning a temporary
 *  gallery is the only way it becomes permanent, and unpinning hands it
 *  back to the pipeline. Strips therefore follow retention rather than
 *  the flag alone, so a legacy retained row missing its pinned_at still
 *  renders where it belongs; pinned rows lead by pinnedAt for the same
 *  stability. Everything in the pipeline compacts. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  if (tier === 'pro') {
    const pinned = entries
      .filter((entry) => Boolean(entry.pinnedAt))
      .sort((a, b) => String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1)
    const stripSet = new Set(pinned.map((entry) => entry.slug))
    return {
      strips: pinned.map((entry) => entry.slug),
      compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug),
    }
  }
  const retained = entries.filter((entry) => entry.retention !== 'pipeline')
  const strips = [
    ...retained.filter((entry) => Boolean(entry.pinnedAt)).sort((a, b) => String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1),
    ...retained.filter((entry) => !entry.pinnedAt),
  ]
  const stripSet = new Set(strips.map((entry) => entry.slug))
  return {
    strips: strips.map((entry) => entry.slug),
    compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug),
  }
}
