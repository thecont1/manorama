import {
  baseName,
  classifyRoot,
  galleryTitleForRoot,
  scanLocalDirectory,
  type LocalGalleryItem,
  type LocalScan,
  type ReadDir,
} from './local-scan'
import { coverItemFor, type LocalGalleryRecord } from './catalogue'

/**
 * Drag-and-drop folder add — the pure half. The shell reports directory
 * paths it has security-scoped but not yet committed; this module normalises,
 * de-dupes, scans them through the same `scanLocalDirectory` the picker uses,
 * classifies each row, and builds the catalogue records a commit persists.
 *
 * Nothing here touches the filesystem directly — `readDir` is injected, the
 * same seam `local-scan.ts` already keeps for `bun test`. Nothing is copied,
 * moved or re-encoded: a committed record references the originals in place,
 * exactly like a picked folder.
 */

/** The sheet lists at most this many rows; a bigger drop says so quietly. */
export const DROP_FOLDER_LIMIT = 24

/** Strip trailing separators — the shared dedupe key. The picker never
 *  hands back a trailing slash, so `addFolder`'s record is unchanged. */
export const normalizeRootPath = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** De-dupe identical dropped paths, preserving first-seen order. The shell
 *  already caps the pending set; this is the page's own guard. */
export const dedupeDroppedPaths = (paths: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of paths) {
    const path = normalizeRootPath(raw)
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** normalized rootPath → the record already holding it, for duplicate rows
 *  and the single-drop "already in your library" answer. */
export const existingRootMap = (
  records: readonly LocalGalleryRecord[],
): Map<string, LocalGalleryRecord> => {
  const map = new Map<string, LocalGalleryRecord>()
  for (const record of records) map.set(normalizeRootPath(record.rootPath), record)
  return map
}

export const findExistingRecord = (
  records: readonly LocalGalleryRecord[],
  path: string,
): LocalGalleryRecord | null =>
  existingRootMap(records).get(normalizeRootPath(path)) ?? null

export type DroppedFolderState = 'new' | 'duplicate' | 'empty' | 'unreadable'

/** One row of the drop sheet — or the single-drop decision. `items` is the
 *  capped scan result (at most MAX_GALLERY_ITEMS); `truncated` is the
 *  uncapped match count when the cap cut anything. */
export type DroppedFolderCandidate = {
  /** Normalized absolute root — the dedupe key and the commit lookup. */
  path: string
  /** The folder's own name, like every other surface names a source. */
  title: string
  sourceKind: 'folder' | 'card'
  mountPoint?: string
  items: LocalGalleryItem[]
  truncated?: number
  /** The gallery's true total — the record's `itemCount` parity: the
   *  uncapped count when the scan truncated, else the item count. */
  itemCount: number
  state: DroppedFolderState
  /** The record a duplicate points at — its cover is the card's cover. */
  existing?: LocalGalleryRecord
}

export type ScanDroppedDeps = {
  readDir: ReadDir
  /** normalized rootPath → record, for duplicate rows that need no scan. */
  existing?: ReadonlyMap<string, LocalGalleryRecord>
  /** Fires as each folder resolves — the sheet fills in progressively. */
  onCandidate?: (candidate: DroppedFolderCandidate) => void
  /** Scan concurrency — a big drop must not serialize the filesystem. */
  concurrency?: number
}

const scanOne = async (path: string, deps: ScanDroppedDeps): Promise<DroppedFolderCandidate> => {
  const title = galleryTitleForRoot(path)
  const existing = deps.existing?.get(path)
  if (existing) {
    // A duplicate needs no scan: the row borrows the live record's count,
    // kind and cover — it IS that gallery, seen again.
    return {
      path,
      title,
      sourceKind: existing.sourceKind,
      ...(existing.mountPoint ? { mountPoint: existing.mountPoint } : {}),
      items: [],
      itemCount: existing.itemCount,
      state: 'duplicate',
      existing,
    }
  }
  const { sourceKind, mountPoint } = classifyRoot(path)
  const kind = { sourceKind, ...(mountPoint ? { mountPoint } : {}) }
  let scan: LocalScan
  try {
    scan = await scanLocalDirectory(path, deps.readDir)
  } catch {
    return { path, title, ...kind, items: [], itemCount: 0, state: 'unreadable' }
  }
  if (!scan.items.length) {
    return { path, title, ...kind, items: [], itemCount: 0, state: 'empty' }
  }
  return {
    path,
    title,
    ...kind,
    items: scan.items,
    itemCount: scan.truncated ?? scan.items.length,
    ...(scan.truncated !== undefined ? { truncated: scan.truncated } : {}),
    state: 'new',
  }
}

/**
 * Scan the dropped folders — de-duped, capped at DROP_FOLDER_LIMIT, at most
 * `concurrency` (default 3) scans in flight. Per-folder failures become
 * 'unreadable' rows; the batch itself never rejects. The returned array is
 * in dropped order regardless of which scan finished first.
 */
export const scanDroppedFolders = async (
  paths: readonly string[],
  deps: ScanDroppedDeps,
): Promise<DroppedFolderCandidate[]> => {
  const unique = dedupeDroppedPaths(paths).slice(0, DROP_FOLDER_LIMIT)
  const results: (DroppedFolderCandidate | undefined)[] = new Array(unique.length)
  const limit = Math.max(1, deps.concurrency ?? 3)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, unique.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= unique.length) return
      const candidate = await scanOne(unique[index], deps)
      results[index] = candidate
      deps.onCandidate?.(candidate)
    }
  })
  await Promise.all(workers)
  return results as DroppedFolderCandidate[]
}

// MARK: - Selection

/** Only a folder that scanned clean and is not already catalogued can be
 *  added — every other row is information, not a choice. */
export const isSelectable = (candidate: DroppedFolderCandidate): boolean =>
  candidate.state === 'new'

/** Every selectable row starts selected — the common drop adds all of them
 *  and deselecting is the exception. */
export const defaultSelection = (candidates: readonly DroppedFolderCandidate[]): Set<string> =>
  new Set(candidates.filter(isSelectable).map((candidate) => candidate.path))

export const toggleSelection = (
  selection: ReadonlySet<string>,
  candidate: DroppedFolderCandidate,
): Set<string> => {
  const next = new Set(selection)
  if (!isSelectable(candidate)) return next
  if (next.has(candidate.path)) next.delete(candidate.path)
  else next.add(candidate.path)
  return next
}

export const selectAllSelection = (
  candidates: readonly DroppedFolderCandidate[],
  select: boolean,
): Set<string> => (select ? defaultSelection(candidates) : new Set())

// MARK: - Records

/**
 * The record a committed folder becomes — the same shape `addFolder`
 * persisted, built in one place so a picked folder and a dropped folder can
 * never drift apart. `now` is injected like the scan's clock.
 */
export const buildLocalRecord = (root: string, scan: LocalScan, now: string): LocalGalleryRecord => {
  const normalized = normalizeRootPath(root)
  const { sourceKind, mountPoint } = classifyRoot(normalized)
  return {
    id: crypto.randomUUID(),
    title: galleryTitleForRoot(normalized),
    rootPath: normalized,
    sourceKind,
    ...(mountPoint ? { mountPoint } : {}),
    itemCount: scan.truncated ?? scan.items.length,
    items: scan.items,
    addedAt: now,
    lastSeenAt: now,
  }
}

/** The record a committed candidate becomes — its scan already ran, so the
 *  record is rebuilt from the row rather than scanning again. */
export const recordForCandidate = (candidate: DroppedFolderCandidate, now: string): LocalGalleryRecord =>
  buildLocalRecord(candidate.path, {
    items: candidate.items,
    ...(candidate.truncated !== undefined ? { truncated: candidate.truncated } : {}),
  }, now)

/** The cover a row previews — for a new folder its first scanned item,
 *  which is exactly the cover the card will wear (`coverItemFor` on the
 *  record about to exist); for a duplicate, the existing record's own. */
export const coverForCandidate = (candidate: DroppedFolderCandidate): LocalGalleryItem | undefined => {
  if (candidate.state === 'duplicate' && candidate.existing) return coverItemFor(candidate.existing)
  return candidate.items[0]
}

/** "128 photographs" / "1 photograph"; a capped scan reads
 *  "1,000 of 1,432 photographs" — the honest total, not the stored cap. */
export const candidateCountText = (candidate: DroppedFolderCandidate): string => {
  const shown = candidate.items.length
  const total = candidate.itemCount
  const noun = total === 1 ? 'photograph' : 'photographs'
  if (candidate.truncated !== undefined && candidate.truncated > shown) {
    return `${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
  }
  return `${total.toLocaleString()} ${noun}`
}

/** "in Pictures" — the dropped folder's parent, named the way Finder names
 *  it. Absent for a filesystem root or an unreadable path shape. */
export const parentFolderName = (path: string): string | undefined => {
  const parent = normalizeRootPath(path).replace(/[^\\/]+$/, '').replace(/[\\/]+$/, '')
  const name = baseName(parent)
  return name || undefined
}
