import { probeImageDimensions } from './image-dims'
import { MAX_GALLERY_ITEMS, type GalleryMediaItem } from './imagesource'

/**
 * Local-folder source — dev only.
 *
 * The production app ingests public provider links; in `bun run dev` the
 * vite plugin (manoramaDevSeed, apply: 'serve') sets a flag on globalThis
 * that turns this module on, so `localhost:5173//Users/…/album` quick-adds
 * a folder straight off disk and `file:///…` (or a bare absolute path)
 * works in the dashboard paste box too. The flag can never exist in a
 * production build — detection, the catch-all interstitial, and the media
 * route all check it first.
 *
 * Scanned items point at `/api/local/file?path=…`, which serves bytes only
 * for paths inside a directory scanned this dev session (the roots set
 * lives on the same globalThis the SSR graph shares).
 */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v'])

const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
}

/** Enough of every supported still format's headers to probe dimensions —
 *  Lightroom-class EXIF thumbnails can push a JPEG's SOF marker past 256KB. */
const IMAGE_HEAD_BYTES = 4 * 1024 * 1024
/** moov sits at the head for faststart files and the tail otherwise — probe both windows. */
const MP4_PROBE_BYTES = 2 * 1024 * 1024
/** Scan probes run a few files at a time — readdir order, bounded IO. */
const SCAN_CONCURRENCY = 8

type Fs = typeof import('node:fs/promises')

const lowerExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** The dev-only on switch. The vite plugin sets it; nothing else may. */
export const localSourcesEnabled = () =>
  (globalThis as { __manoramaLocalSources?: boolean }).__manoramaLocalSources === true

/** Shapes we treat as a local folder reference rather than a provider link. */
export const isLocalPathInput = (input: string): boolean => {
  const trimmed = input.trim()
  return (
    trimmed.startsWith('/') ||
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    /^file:\/\//i.test(trimmed) ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  )
}

/**
 * Network-free canonical form for dedupe: scheme stripped, escapes decoded,
 * leading and trailing slashes collapsed. No filesystem access — path
 * resolution happens in the scanner.
 */
export const normalizeLocalPathString = (input: string): string => {
  let candidate = input.trim()
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname
    } catch {
      // Malformed file URL — compare the raw string.
    }
  }
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // A stray % stays literal.
  }
  return candidate.replace(/^\/+/, '/').replace(/\/+$/, '')
}

const resolveLocalPath = async (input: string): Promise<string> => {
  const path = await import('node:path')
  let candidate = normalizeLocalPathString(input)
  if (candidate === '~' || candidate.startsWith('~/')) {
    const os = await import('node:os')
    candidate = os.homedir() + candidate.slice(1)
  }
  return path.resolve(candidate)
}

/** The proxy URL stored on every manifest item. */
const localFileUrl = (filePath: string) =>
  `/api/local/file?path=${encodeURIComponent(filePath)}`

const placeholderFor = (width: number, height: number) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`

/** Directories scanned this dev session — the media route serves nothing
 *  outside them, so a crafted ?path= can't read arbitrary files. */
const mediaRoots = (): Set<string> => {
  const g = globalThis as { __manoramaLocalRoots?: Set<string> }
  return (g.__manoramaLocalRoots ??= new Set())
}

const readAt = async (fs: Fs, filePath: string, position: number, length: number) => {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!

/** MP4 track extents: tkhd's final 8 bytes are 16.16 fixed width/height.
 *  Audio tracks carry 0×0 and are skipped over. */
const findTkhdDimensions = (bytes: Uint8Array) => {
  for (let i = 4; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== 0x74 || bytes[i + 1] !== 0x6b || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue
    const size = u32be(bytes, i - 4)
    if (size < 8 || i - 4 + size > bytes.length) continue
    const width = u32be(bytes, i - 4 + size - 8) >>> 16
    const height = u32be(bytes, i - 4 + size - 4) >>> 16
    if (width > 0 && height > 0) return { width, height }
  }
  return null
}

const probeMp4Dimensions = async (fs: Fs, filePath: string) => {
  const stat = await fs.stat(filePath)
  const head = await readAt(fs, filePath, 0, Math.min(MP4_PROBE_BYTES, stat.size))
  const found = findTkhdDimensions(head)
  if (found || stat.size <= MP4_PROBE_BYTES) return found
  // moov-at-tail: read the last window too.
  return findTkhdDimensions(await readAt(fs, filePath, stat.size - MP4_PROBE_BYTES, MP4_PROBE_BYTES))
}

const scanLocalFile = async (dir: string, name: string): Promise<GalleryMediaItem | null> => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const filePath = path.join(dir, name)
  const ext = lowerExt(name)
  try {
    if (IMAGE_EXTENSIONS.has(ext)) {
      const dims = probeImageDimensions(await readAt(fs, filePath, 0, IMAGE_HEAD_BYTES))
      // Undimensionable files can't be laid out — same bar as the providers.
      if (!dims) return null
      return {
        id: name,
        filename: name,
        src: localFileUrl(filePath),
        width: dims.width,
        height: dims.height,
        alt: name,
        c2pa: true,
        placeholder: placeholderFor(dims.width, dims.height),
        variants: [{ width: 256, src: `${localFileUrl(filePath)}&w=256`, format: 'webp' }],
      }
    }
    const dims = await probeMp4Dimensions(fs, filePath)
    if (!dims) return null
    // Local videos carry no derivative to use as a poster — an aspect-correct
    // placeholder stands in (dev-only; the "real provider derivative" rule
    // exists because remote posters must stream from the provider).
    const poster = { src: placeholderFor(dims.width, dims.height), width: dims.width, height: dims.height }
    return {
      type: 'video',
      id: name,
      filename: name,
      src: localFileUrl(filePath),
      mimeType: 'video/mp4',
      width: dims.width,
      height: dims.height,
      poster,
      alt: name,
      c2pa: false,
      placeholder: poster.src,
      variants: [{ width: 256, src: poster.src, format: 'svg' }],
    }
  } catch {
    return null
  }
}

export const scanLocalFolder = async (input: string) => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = await resolveLocalPath(input)
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat?.isDirectory()) {
    throw new Error('That local folder could not be read — check that the path exists')
  }
  // Scanning the filesystem root would register '/' as a media root and
  // unconfine the file route — refuse it outright.
  if (dir === '/' || /^[A-Za-z]:[\\/]?$/.test(dir)) {
    throw new Error('Pick a folder, not the filesystem root')
  }
  const names = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => IMAGE_EXTENSIONS.has(lowerExt(name)) || VIDEO_EXTENSIONS.has(lowerExt(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (!names.length) {
    throw new Error('That folder has no photos or videos Manorama can display')
  }
  const truncated = names.length > MAX_GALLERY_ITEMS ? names.length : undefined
  const capped = truncated ? names.slice(0, MAX_GALLERY_ITEMS) : names
  const images: GalleryMediaItem[] = []
  for (let i = 0; i < capped.length; i += SCAN_CONCURRENCY) {
    const batch = await Promise.all(capped.slice(i, i + SCAN_CONCURRENCY).map((name) => scanLocalFile(dir, name)))
    for (const item of batch) if (item) images.push(item)
  }
  if (!images.length) {
    throw new Error('That folder has no photos or videos Manorama can display')
  }
  // Confine media delivery to the real path — the file route realpaths
  // every request, so a symlinked folder must register resolved.
  mediaRoots().add(await fs.realpath(dir).catch(() => dir))
  return { sourceUrl: `file://${dir}`, title: path.basename(dir), images, truncated }
}

/**
 * Catch-all companion to embeddedSourceCandidate: claims a request path
 * only when it resolves to a real directory on disk. URL-shaped provider
 * links never reach this — it runs after the provider check returns null.
 */
export const localFolderCandidate = async (rawPath: string) => {
  if (!localSourcesEnabled() || !rawPath || rawPath === '/') return null
  try {
    const dir = await resolveLocalPath(rawPath)
    // Never claim the filesystem root itself.
    if (dir === '/' || /^[A-Za-z]:[\\/]?$/.test(dir)) return null
    const fs = await import('node:fs/promises')
    return (await fs.stat(dir)).isDirectory() ? { candidate: dir, provider: 'local' as const } : null
  } catch {
    return null
  }
}

const notFound = () => new Response(JSON.stringify({ error: 'That file is unavailable' }), {
  status: 404,
  headers: { 'Content-Type': 'application/json' },
})

const svgResponse = (width: number, height: number) => new Response(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#111212"/></svg>`,
  { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' } },
)

/**
 * GET /api/local/file?path=…[&w=256] — dev-only media delivery for
 * local-sourced galleries. Confined to directories scanned this session,
 * extension-allowlisted, and Range-capable so video seeking works.
 * `?w=` produces a resized WebP thumbnail via sharp (already a lazy dep of
 * the OG compositor); formats sharp can't decode fall back to a
 * placeholder tile rather than breaking the admin rail.
 */
export const serveLocalMedia = async (url: URL, rangeHeader: string | null): Promise<Response> => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const requested = url.searchParams.get('path')
  if (!requested) return notFound()
  let filePath: string
  try {
    filePath = await fs.realpath(requested)
  } catch {
    return notFound()
  }
  const ext = lowerExt(filePath)
  const contentType = CONTENT_TYPE[ext]
  if (!contentType) return notFound()
  const inside = [...mediaRoots()].some((root) => filePath.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
  if (!inside) return notFound()
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) return notFound()

  const thumbWidth = Number(url.searchParams.get('w'))
  if (thumbWidth > 0 && IMAGE_EXTENSIONS.has(ext)) {
    try {
      const sharp = (await import('sharp')).default
      const buffer = await sharp(filePath)
        .resize({ width: Math.min(2048, Math.floor(thumbWidth)), withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer()
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=300' },
      })
    } catch {
      return svgResponse(thumbWidth, Math.round(thumbWidth * 0.67))
    }
  }

  const { createReadStream } = await import('node:fs')
  const { Readable } = await import('node:stream')
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
    'Accept-Ranges': 'bytes',
  })
  const range = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
    if (start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
    }
    end = Math.min(end, stat.size - 1)
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
    headers.set('Content-Length', String(end - start + 1))
    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
  }
  headers.set('Content-Length', String(stat.size))
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { status: 200, headers })
}
