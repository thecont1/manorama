import type { ExpiredGalleryKey } from './gallery-repository'

type ExpiryRepository = {
  list: (now: string, after?: ExpiredGalleryKey, limit?: number) => Promise<ExpiredGalleryKey[]>
  remove: (key: ExpiredGalleryKey, now: string) => Promise<boolean>
}

const PAGE_SIZE = 100
const MAX_PAGES = 100

export async function expirePipelineGalleries(
  repository: ExpiryRepository,
  now: string,
): Promise<{ scanned: number; deleted: number; skipped: number; failed: number }> {
  let scanned = 0
  let deleted = 0
  let skipped = 0
  let failed = 0
  let after: ExpiredGalleryKey | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
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
  return { scanned, deleted, skipped, failed }
}
