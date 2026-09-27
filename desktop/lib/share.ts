import { deviceGalleryInput, type LocalCatalogue, type LocalGalleryRecord } from './catalogue'
import { baseName } from './local-scan'
import { normalizeApiBase } from './session'
import type { ReadFileBytes, UploadFile, UploadProgress, UploadProvider } from './providers/types'

/**
 * The share/upload slice — the ONLY path by which local bytes leave the
 * device. It runs on explicit user action alone: `shareLocalGallery` opens
 * by awaiting the caller's `confirm` gate, and nothing upstream (open,
 * rescan, mount, sync) ever calls into it.
 *
 * What crosses the network:
 *  - to the provider: raw file bytes + sanitized basenames, inside an
 *    app-named folder (manorama/<album>) — provider-hosted originals.
 *  - to the Worker: exactly ONE string, the provider's public share link.
 *    The Worker scans the link server-side; no path, filename, or byte
 *    ever reaches it.
 *
 * A failure aborts cleanly WITHOUT deleting partial provider content —
 * there is no delete call anywhere in this lane. Retrying the share
 * re-adds files (Dropbox autorenames on conflict, Drive allows same-name
 * siblings) and reuses or recreates the folder link.
 */

// --- Names -------------------------------------------------------------------

const UNSAFE_UPLOAD_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g
const MAX_UPLOAD_NAME = 200

/**
 * Provider-safe basename: strips path separators, control characters, and
 * the characters providers or the Drive query language reject. The result
 * is a NAME ONLY — no directory component can survive this.
 */
export const sanitizeUploadName = (name: string): string => {
  const cleaned = baseName(name)
    .replace(UNSAFE_UPLOAD_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_UPLOAD_NAME)
    .trim()
  return cleaned || 'file'
}

/**
 * Deterministic in-album dedupe: the first occurrence keeps its name,
 * collisions become `name (2).ext`, `name (3).ext`. Two files named alike
 * in different subdirectories land as distinct provider objects, and a
 * rescan+reshare produces the same set.
 */
export const dedupeUploadNames = (names: readonly string[]): string[] => {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count === 0) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    return `${stem} (${count + 1})${ext}`
  })
}

/** The album projection handed to the provider — basenames for the folder,
 *  paths only for the local `readFile`. */
export const uploadFilesFor = (record: LocalGalleryRecord): UploadFile[] => {
  const names = dedupeUploadNames(record.items.map((item) => sanitizeUploadName(item.name)))
  return record.items.map((item, index) => ({ name: names[index]!, path: item.path }))
}

// --- The Worker wiring -------------------------------------------------------

type CreateGalleryResponse = {
  gallery?: { slug?: string }
  galleryUrl?: string
  error?: string
}

const slugFromPayload = (payload: CreateGalleryResponse): { slug: string; galleryUrl: string } | null => {
  const slug = payload.gallery?.slug
  if (typeof slug !== 'string' || !slug) return null
  return {
    slug,
    galleryUrl: typeof payload.galleryUrl === 'string' && payload.galleryUrl ? payload.galleryUrl : `/${slug}`,
  }
}

/**
 * POST {apiBase}/api/galleries {url: shareLink}. The body carries the share
 * link and NOTHING else — no path, filename, or identifier can ride along
 * because the request is built from exactly one argument.
 *
 * A 409 means the link was already scanned: the existing gallery's slug and
 * URL come back in the body and are reused, so a re-share links the device
 * record to the gallery that link first produced.
 */
export const createGalleryFromShareLink = async (
  apiBase: string,
  token: string,
  shareUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<{ slug: string; galleryUrl: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url: shareUrl }),
  })
  const payload = (await response.json().catch(() => ({}))) as CreateGalleryResponse
  if (response.ok || response.status === 409) {
    const found = slugFromPayload(payload)
    if (found) return found
  }
  throw new Error(
    typeof payload.error === 'string' && payload.error ? payload.error : 'The share link could not be published.',
  )
}

/**
 * PUT /api/device-galleries/:id with the record's sync projection plus the
 * freshly created gallery's slug — the call that makes the device row
 * tappable on iPhone. Still metadata-only: publicGallerySlug is a slug,
 * never a path.
 */
export const linkDeviceGallery = async (
  apiBase: string,
  token: string,
  record: LocalGalleryRecord,
  catalogue: LocalCatalogue,
  publicGallerySlug: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/device-galleries/${record.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...deviceGalleryInput(record, catalogue), publicGallerySlug }),
  })
  if (!response.ok) {
    throw new Error('The published gallery could not be linked to this device record.')
  }
}

// --- The orchestration ---------------------------------------------------------

export type ShareOutcome =
  | { status: 'cancelled' }
  | { status: 'published'; shareUrl: string; slug: string; galleryUrl: string }
  | { status: 'failed'; message: string }

export type ShareDeps = {
  provider: UploadProvider
  apiBase: string
  token: string
  record: LocalGalleryRecord
  catalogue: LocalCatalogue
  readFile: ReadFileBytes
  /**
   * The confirmation gate. The function awaits this BEFORE the first
   * provider or Worker call — a false resolution means zero network calls
   * were made, which the tests assert.
   */
  confirm: () => Promise<boolean>
  onProgress?: (progress: UploadProgress) => void
  fetcher?: typeof fetch
}

export const shareLocalGallery = async (deps: ShareDeps): Promise<ShareOutcome> => {
  if (!(await deps.confirm())) return { status: 'cancelled' }
  try {
    const album = { name: sanitizeUploadName(deps.record.title), id: deps.record.id, files: uploadFilesFor(deps.record) }
    const { shareUrl } = await deps.provider.uploadAlbum(album, deps.readFile, deps.onProgress)
    const published = await createGalleryFromShareLink(deps.apiBase, deps.token, shareUrl, deps.fetcher ?? fetch)
    await linkDeviceGallery(deps.apiBase, deps.token, deps.record, deps.catalogue, published.slug, deps.fetcher ?? fetch)
    return { status: 'published', shareUrl, slug: published.slug, galleryUrl: published.galleryUrl }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error && error.message.trim() ? error.message : 'The gallery could not be shared.',
    }
  }
}
