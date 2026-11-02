import { FREE_RETAINED_LIMIT, type AccountTier } from './account'

/** How many galleries earn a photo-strip card for a Visionary owner, and
 *  how many items a strip rail renders before its "+N" tile. Together they
 *  bound the Library payload: strips ship at most this many preview items
 *  and compact galleries ship only their cover. */
export const STRIP_LIMIT_PRO = 10
export const STRIP_PREVIEW_ITEMS = 12

type LibraryLayoutEntry = {
  slug: string
  retention?: 'retained' | 'pipeline'
  pinnedAt?: string | null
}

/** Which of the owner's galleries render as full photo strips and which
 *  collapse to compact rows. `entries` must arrive newest-first, the same
 *  order listGalleries/sortRecent produce; both output lists preserve it.
 *
 *  Free: retained galleries strip (the policy already caps them at
 *  FREE_RETAINED_LIMIT), temporary galleries compact.
 *
 *  Visionary: pinned galleries strip first — oldest pin first, so the top
 *  of the Library is stable until the owner re-pins — then the most recent
 *  unpinned until the cap; everything else compacts. */
export const libraryLayout = (
  entries: readonly LibraryLayoutEntry[],
  tier: AccountTier,
): { strips: string[]; compact: string[] } => {
  if (tier !== 'pro') {
    const strips = entries
      .filter((entry) => entry.retention !== 'pipeline')
      .slice(0, FREE_RETAINED_LIMIT)
      .map((entry) => entry.slug)
    return { strips, compact: entries.filter((entry) => entry.retention === 'pipeline').map((entry) => entry.slug) }
  }
  const pinned = entries
    .filter((entry) => Boolean(entry.pinnedAt))
    .sort((a, b) => String(a.pinnedAt) < String(b.pinnedAt) ? -1 : 1)
  const unpinned = entries.filter((entry) => !entry.pinnedAt)
  const strips = [...pinned, ...unpinned].slice(0, STRIP_LIMIT_PRO).map((entry) => entry.slug)
  const stripSet = new Set(strips)
  return { strips, compact: entries.filter((entry) => !stripSet.has(entry.slug)).map((entry) => entry.slug) }
}
