import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage } from './imagesource'
import { parseJpegDimensions, probeImageDimensions } from './image-dims'
import { createScanBudget, mapWithConcurrency, PROBE_CONCURRENCY, ScanBudgetExhausted } from './scan-budget'

export { parseJpegDimensions }

// Accepted formats only: JPEG, WebP, AVIF, HEIC, HEIF. PNG, GIF, TIFF,
// video, and every other file type are consciously ignored at scan.
const IMAGE_EXTENSIONS = /\.(?:jpe?g|webp|avif|hei[cf])$/i
const HEIC = /\.hei[cf]$/i
const ALLOWED_HOSTS = new Set(['dropbox.com', 'www.dropbox.com'])

type DropboxEnv = { DROPBOX_APP_KEY?: string; DROPBOX_APP_SECRET?: string }
type DropboxEntry = { '.tag': 'file' | 'folder'; name: string; id: string; size?: number; media_info?: { metadata?: { dimensions?: { width?: number; height?: number } } } }
type ListResponse = { entries: DropboxEntry[]; cursor: string; has_more: boolean }
type SharedLinkMetadata = { name?: string }

export type DropboxScan = { sourceUrl: string; title: string; images: GalleryImage[]; truncated?: number }

const validateFolderUrl = (input: string) => {
  const url = new URL(input.trim())
  if (!ALLOWED_HOSTS.has(url.hostname) || !/^\/(?:scl\/fo|sh)\//.test(url.pathname)) throw new Error('Use a public Dropbox folder link')
  url.searchParams.set('dl', '0')
  return url.toString()
}

/** The `filename` query param is spliced into the Dropbox API path —
 *  normalise it so a crafted reference cannot escape the shared link's
 *  root with dot segments or a leading slash. */
const dropboxPath = (filename: string) =>
  '/' + filename.split('/').filter((s) => s && s !== '.' && s !== '..').join('/')

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'
const originalProxy = (sourceUrl: string, filename: string) => `/api/dropbox/file?sourceUrl=${encodeURIComponent(sourceUrl)}&filename=${encodeURIComponent(filename)}`
const thumbnailProxy = (sourceUrl: string, filename: string) => `/api/dropbox/thumbnail?sourceUrl=${encodeURIComponent(sourceUrl)}&filename=${encodeURIComponent(filename)}`
// HEIC can't render in browsers. Dropbox caps its JPEG renditions at
// w1024h768, which reads soft at full bleed — so the display src is the
// raw original and the viewer decodes it client-side (libheif WASM).
// The JPEG variant stays for placeholders and the editor rail.

const authHeaders = (env: DropboxEnv) => {
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) throw new Error('Dropbox app credentials are not configured')
  return { Authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}` }
}

const rpc = async <T>(endpoint: string, body: unknown, env: DropboxEnv, fetchImpl: typeof fetch = fetch) => {
  const response = await fetchImpl(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new SourceFetchError(`Dropbox ${endpoint} failed (${response.status}): ${message.slice(0, 220)}`, response.status)
  }
  return response.json() as Promise<T>
}

const contentRequest = async (endpoint: string, arg: unknown, env: DropboxEnv, fetchImpl: typeof fetch = fetch, headers?: HeadersInit) => {
  const once = () => fetchImpl(`https://content.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(env), 'Dropbox-API-Arg': JSON.stringify(arg), ...headers },
  })
  let response = await once()
  // A gallery open bursts dozens of content calls — Dropbox answers the
  // stampede with 429 or a transient 5xx, so exactly one retry waits out
  // Retry-After (or a short jitter) rather than dropping the photograph.
  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3) * 1000 : 300 + Math.random() * 300
    await new Promise((resolve) => setTimeout(resolve, wait))
    response = await once()
  }
  // Dropbox reports a missing path inside a valid shared folder as 409 —
  // for the proxy that is a confirmed miss, not a conflict.
  if (!response.ok) throw new SourceFetchError(`Dropbox ${endpoint} failed (${response.status})`, response.status === 409 ? 404 : response.status)
  return response
}

/** Resolution order: list_folder's own media_info → a ranged fetch of the
 *  original's head parsed by format → the preview probe → a 4:3 guess.
 *
 *  The original answers the question and the preview cannot. A
 *  `files/get_thumbnail_v2` at `w256h256` returns a correctly-proportioned
 *  *256-pixel* render, and this function used to probe that first and store its
 *  measurements as the photograph's: every Dropbox frame entered the manifest
 *  as 256×171, the info sheet reported that size to the viewer, and the record
 *  carried a thumbnail's pixels where it promised a photograph's. The aspect
 *  was right, which is why it read as plausible for so long.
 *
 *  media_info costs nothing — `collectEntries` already asks for it — and it is
 *  the file's own metadata, so it wins outright. The preview survives as the
 *  last resort, where its proportions still beat a guess. */
const imageDimensions = async (sourceUrl: string, filename: string, env: DropboxEnv, fallback: { width?: number; height?: number } | undefined, fetchImpl: typeof fetch) => {
  if (fallback?.width && fallback?.height) return { width: fallback.width, height: fallback.height }
  try {
    const response = await contentRequest('sharing/get_shared_link_file', { url: sourceUrl, path: dropboxPath(filename) }, env, fetchImpl, { Range: 'bytes=0-131071' })
    const dimensions = probeImageDimensions(new Uint8Array(await response.arrayBuffer()))
    if (dimensions) return dimensions
  } catch (error) {
    // The budget stopping a probe is not a provider failure — let it
    // escape so the scan can drop the tail instead of guessing dims.
    if (error instanceof ScanBudgetExhausted) throw error
    // A provider that refuses a ranged read is not a failed scan — the preview
    // below still shapes the frame.
  }
  try {
    const response = await contentRequest('files/get_thumbnail_v2', {
      resource: { '.tag': 'link', url: sourceUrl, path: dropboxPath(filename) },
      format: { '.tag': 'jpeg' },
      size: 'w256h256',
      mode: 'strict',
    }, env, fetchImpl)
    const dimensions = parseJpegDimensions(new Uint8Array(await response.arrayBuffer()))
    if (dimensions) return dimensions
  } catch (error) {
    if (error instanceof ScanBudgetExhausted) throw error
    // A preview is helpful but not required to validate the folder.
  }
  return { width: 4, height: 3 }
}

const collectEntries = async (sourceUrl: string, env: DropboxEnv, fetchImpl: typeof fetch) => {
  // Top-level of the shared folder only; subfolders are intentionally
  // not descended into. Paging stops once the album provably exceeds the
  // gallery cap, so the filtered count then reads as a lower bound on the
  // album size, not the exact count.
  const entries: DropboxEntry[] = []
  let response = await rpc<ListResponse>('files/list_folder', { path: '', shared_link: { url: sourceUrl }, include_media_info: true }, env, fetchImpl)
  for (;;) {
    entries.push(...response.entries.filter((entry) => entry['.tag'] === 'file' && IMAGE_EXTENSIONS.test(entry.name)))
    if (!response.has_more || entries.length > MAX_GALLERY_ITEMS) break
    response = await rpc<ListResponse>('files/list_folder/continue', { cursor: response.cursor }, env, fetchImpl)
  }
  return entries
}

const sharedLinkName = async (sourceUrl: string, env: DropboxEnv, fetchImpl: typeof fetch) => {
  try {
    const metadata = await rpc<SharedLinkMetadata>("sharing/get_shared_link_metadata", { url: sourceUrl }, env, fetchImpl)
    return metadata.name?.trim() || ""
  } catch {
    return ""
  }
}

const titleFromFolderName = (name: string) => name.replace(/[\-_]+|\s+/g, " ").replace(/\s+/g, " ").trim()

const titleFromEntries = (entries: DropboxEntry[]) => {
  const filename = entries[0]?.name.replace(/\.[^.]+$/, '') || ''
  const match = filename.match(/^MS\d{6,8}-([A-Za-z][A-Za-z _-]*)\d*$/i)
  if (match?.[1]) return match[1].replace(/[-_]+/g, ' ').trim()
  return 'Untitled gallery'
}

export const scanDropboxFolder = async (input: string, env: DropboxEnv, fetchImpl: typeof fetch = fetch): Promise<DropboxScan> => {
  const sourceUrl = validateFolderUrl(input)
  // Listing, title and per-item probes all spend from one per-scan
  // subrequest budget — the Workers ceiling sits under an uncapped album.
  const budgetFetch = createScanBudget().fetch(fetchImpl)
  const found = await collectEntries(sourceUrl, env, budgetFetch)
  if (!found.length) throw new Error('No image files were found in that public Dropbox folder')
  // Cap before the per-item dimension probes — each entry costs one or
  // two Dropbox requests, so an uncapped folder multiplies into minutes.
  const entries = found.slice(0, MAX_GALLERY_ITEMS)
  const folderName = await sharedLinkName(sourceUrl, env, budgetFetch)
  const title = folderName ? titleFromFolderName(folderName) : titleFromEntries(entries)
  let dropped = false
  const images = (await mapWithConcurrency(entries, PROBE_CONCURRENCY, async (entry, index): Promise<GalleryImage | null> => {
    try {
      const dimensions = await imageDimensions(sourceUrl, entry.name, env, entry.media_info?.metadata?.dimensions, budgetFetch)
      return {
        id: `dropbox-${entry.id.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
        filename: entry.name,
        src: originalProxy(sourceUrl, entry.name),
        width: dimensions.width,
        height: dimensions.height,
        alt: filenameLabel(entry.name),
        c2pa: true,
        placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${dimensions.width} ${dimensions.height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
        variants: [{ width: 256, src: thumbnailProxy(sourceUrl, entry.name), format: 'jpeg' }],
      }
    } catch (error) {
      // Budget exhaustion drops the un-probed tail — an invented 4:3
      // geometry would violate invariant 2, so truncating honestly is the
      // only correct behaviour.
      if (error instanceof ScanBudgetExhausted) {
        dropped = true
        return null
      }
      throw error
    }
  })).filter((image): image is GalleryImage => image !== null)
  const truncated = found.length > MAX_GALLERY_ITEMS || dropped ? found.length : undefined
  return { sourceUrl, title, images, ...(truncated ? { truncated } : {}) }
}

export const fetchDropboxFile = async (sourceUrlInput: string, filename: string, env: DropboxEnv, range?: string | null) => {
  const sourceUrl = validateFolderUrl(sourceUrlInput)
  return contentRequest('sharing/get_shared_link_file', { url: sourceUrl, path: dropboxPath(filename) }, env, fetch, range ? { Range: range } : undefined)
}

export const fetchDropboxThumbnail = async (sourceUrlInput: string, filename: string, env: DropboxEnv, size: 'w256h256' | 'w1024h768' | 'w2048h2048' = 'w256h256') => {
  const sourceUrl = validateFolderUrl(sourceUrlInput)
  return contentRequest('files/get_thumbnail_v2', {
    resource: { '.tag': 'link', url: sourceUrl, path: dropboxPath(filename) },
    format: { '.tag': 'jpeg' },
    size,
    mode: 'strict',
  }, env)
}
