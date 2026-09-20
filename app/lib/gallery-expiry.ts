import type { ExpiredGalleryKey } from './gallery-repository'

type ExpiryRepository = {
  list: (now: string, after?: ExpiredGalleryKey, limit?: number) => Promise<ExpiredGalleryKey[]>
  remove: (key: ExpiredGalleryKey, now: string) => Promise<boolean>
}

const PAGE_SIZE = 100
const MAX_PAGES = 100

/** Removes expired pipeline galleries in bounded keyset pages. Individual
 *  removal failures are counted and do not stop later entries; list failures
 *  reject the run because its coverage is unknown. */
export async function expirePipelineGalleries(
  repository: ExpiryRepository,
  now: string,
): Promise<{ scanned: number; deleted: number; skipped: number; failed: number; truncated: boolean }> {
  let scanned = 0
  let deleted = 0
  let skipped = 0
  let failed = 0
  let after: ExpiredGalleryKey | undefined
  let page = 0
  for (; page < MAX_PAGES; page++) {
    const keys = await repository.list(now, after, PAGE_SIZE)
    if (keys.length === 0) break
    for (const key of keys) {
      scanned += 1
      try {
        if (await repository.remove(key, now)) deleted += 1
        else skipped += 1
      } catch {
        failed += 1
      }
      after = key
    }
    if (keys.length < PAGE_SIZE) break
  }
  // A run that burns the whole page budget may leave expired rows behind;
  // probe one key past the cursor so callers can report the run truncated
  // rather than silently deferring the remainder to the next day.
  const truncated = page === MAX_PAGES && (await repository.list(now, after, 1)).length > 0
  return { scanned, deleted, skipped, failed, truncated }
}
