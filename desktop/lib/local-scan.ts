import { MAX_GALLERY_ITEMS, type GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * Local folder/card scanning for the Tauri shell — pure logic. Directory
 * access is injected (`ReadDir`), so the Tauri fs plugin stays behind the
 * adapter in `tauri.ts` and this module runs unchanged in `bun test`.
 *
 * The product contract: a scanned gallery references originals in place.
 * Nothing here copies, moves, renames, or deletes a byte.
 */

/**
 * Still formats the first Mac build displays. Matches the plan in
 * docs/native-launch-plan.md §I: RAW and TIFF are out of scope (WKWebView
 * cannot decode TIFF either, so listing it would produce dead frames).
 */
export const DESKTOP_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.heic',
  '.heif',
])

export const lowerExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

export const isDesktopImageName = (name: string): boolean =>
  !name.startsWith('.') && DESKTOP_IMAGE_EXTENSIONS.has(lowerExtension(name))

/** A flattened dir-entry the scanner understands — mirrors what
 *  `@tauri-apps/plugin-fs` `readDir` returns. */
export type LocalScanEntry = {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export type ReadDir = (dir: string) => Promise<LocalScanEntry[]>

/** One referenced original. `path` never leaves the device — the sync
 *  payload is built from the record, not from items. */
export type LocalGalleryItem = {
  /** Relative path inside the root — the stable id across rescans. */
  id: string
  name: string
  path: string
  /** Filled when a rendered thumb reports natural dims; the viewer heals
   *  the placeholder guess the same way it heals stale provider records. */
  width?: number
  height?: number
}

export type LocalScan = {
  items: LocalGalleryItem[]
  /** Uncapped match count when it exceeded MAX_GALLERY_ITEMS. */
  truncated?: number
}

/** Join without depending on a path module — the desktop targets macOS
 *  separators only, and a trailing-separator root stays clean. */
export const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/[\\/]+$/, '')}/${name}`

export const baseName = (path: string): string => {
  const cleaned = path.replace(/[\\/]+$/, '')
  const slash = cleaned.lastIndexOf('/')
  const backslash = cleaned.lastIndexOf('\\')
  return cleaned.slice(Math.max(slash, backslash) + 1)
}

export const galleryTitleForRoot = (root: string): string =>
  baseName(root) || 'Local folder'

/**
 * Source classification: anything under a non-boot mount in /Volumes is a
 * card or removable drive — the distinction the catalogue labels and the
 * "unavailable until the source returns" state care about. The mount point
 * is the volume root itself.
 */
export const classifyRoot = (root: string): { sourceKind: 'folder' | 'card'; mountPoint?: string } => {
  const match = /^\/Volumes\/([^/]+)/.exec(root)
  if (match) return { sourceKind: 'card', mountPoint: `/Volumes/${match[1]}` }
  return { sourceKind: 'folder' }
}

const collectImages = async (dir: string, prefix: string, readDir: ReadDir, out: LocalGalleryItem[]) => {
  const entries = await readDir(dir)
  for (const entry of entries) {
    if (!entry.isFile || !isDesktopImageName(entry.name)) continue
    const id = prefix ? `${prefix}/${entry.name}` : entry.name
    out.push({ id, name: entry.name, path: joinPath(dir, entry.name) })
  }
}

/**
 * Reads the root and exactly one level of subdirectories — deep enough for
 * DCIM/<camera>/ layouts on cards, shallow enough that picking a large
 * tree (Pictures, a drive root) never becomes a filesystem crawl.
 */
export const scanLocalDirectory = async (root: string, readDir: ReadDir): Promise<LocalScan> => {
  const entries = await readDir(root)
  const collected: LocalGalleryItem[] = []
  for (const entry of entries) {
    if (entry.isFile && isDesktopImageName(entry.name)) {
      collected.push({ id: entry.name, name: entry.name, path: joinPath(root, entry.name) })
    }
  }
  const subdirs = entries
    .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  for (const subdir of subdirs) {
    // A subdir that vanished mid-scan (ejected card) contributes nothing —
    // the rescan treats it as absent rather than fatal.
    await collectImages(joinPath(root, subdir), subdir, readDir, collected).catch(() => {})
  }
  // One deterministic order: relative path, natural collation, so IMG_2
  // precedes IMG_10 and a rescan preserves positions for surviving files.
  collected.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  const truncated = collected.length > MAX_GALLERY_ITEMS ? collected.length : undefined
  return { items: truncated ? collected.slice(0, MAX_GALLERY_ITEMS) : collected, ...(truncated ? { truncated } : {}) }
}

/** Same placeholder tile the dev local-source serves — a dark aspect box,
 *  never a fabricated image. */
export const placeholderFor = (width: number, height: number): string =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`

/** Seed dims when a file has not decoded yet. The viewer's healed-dims path
 *  reshapes the frame on `load` with the real natural size — the guess only
 *  decides the pre-decode box. */
const GUESSED_WIDTH = 1200
const GUESSED_HEIGHT = 800

/**
 * Project a local item into the manifest shape the shared Viewer consumes.
 * `srcFor` is the platform seam — production passes `convertFileSrc`, tests
 * pass an identity. No re-encode, no thumbnail generation: the viewer and
 * the grid both render the original file via the asset protocol.
 */
export const toGalleryMediaItem = (item: LocalGalleryItem, srcFor: (path: string) => string): GalleryMediaItem => {
  const width = item.width && item.width > 0 ? item.width : GUESSED_WIDTH
  const height = item.height && item.height > 0 ? item.height : GUESSED_HEIGHT
  return {
    id: item.id,
    filename: item.name,
    src: srcFor(item.path),
    width,
    height,
    alt: item.name,
    // Bytes are referenced, never re-encoded — provenance survives intact.
    c2pa: true,
    placeholder: placeholderFor(width, height),
  }
}
