import { SourceFetchError, type GalleryImage } from './imagesource'

/**
 * Google Drive "anyone with the link" folder scanning. Mirrors the Dropbox
 * model: no per-user OAuth — a single API key (GOOGLE_DRIVE_API_KEY) reads
 * link-shared folders. The Drive API requires every request to identify a
 * Google Cloud project; the key does that without impersonating a user.
 *
 * File IDs are globally unique in Drive, so the proxy routes key on the
 * file ID alone — the folder context is only needed at scan time.
 */

// Accepted formats only: JPEG, WebP, AVIF, HEIC, HEIF. PNG, GIF, TIFF,
// video, and every other file type are consciously ignored at scan.
const SUPPORTED_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
])
// Browsers can't render HEIC/HEIF; Drive transcodes them to JPEG via
// the thumbnail endpoint, so those display through a large rendition.
const NEEDS_JPEG_DERIVATIVE = /^image\/hei[cf]$/i

type GDriveEnv = { GOOGLE_DRIVE_API_KEY?: string }

type DriveFile = {
  id: string
  name: string
  mimeType?: string
  resourceKey?: string
  imageMediaMetadata?: { width?: number; height?: number }
}
type DriveList = { files?: DriveFile[]; nextPageToken?: string }

export type DriveScan = { sourceUrl: string; title: string; images: GalleryImage[] }

/** Extracts the folder ID and optional resource key from the common
 *  sharing URL spellings: drive.google.com/drive/folders/{id},
 *  /drive/u/{n}/folders/{id}, open?id={id}. Newer Drive links carry a
 *  ?resourcekey= that the API requires via X-Goog-Drive-Resource-Keys. */
export const extractDriveFolderId = (input: string) => {
  const url = new URL(input.trim())
  if (url.hostname !== 'drive.google.com') return null
  const resourceKey = url.searchParams.get('resourcekey') ?? undefined
  const folders = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (folders) return { id: folders[1], resourceKey }
  const openId = url.pathname === '/open' ? url.searchParams.get('id') : null
  if (openId) return { id: openId, resourceKey }
  return null
}

export const canonicalDriveUrl = (folderId: string, resourceKey?: string) =>
  `https://drive.google.com/drive/folders/${folderId}${resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : ''}`

const apiKey = (env: GDriveEnv) => {
  if (!env.GOOGLE_DRIVE_API_KEY) throw new Error('Google Drive access is not configured')
  return env.GOOGLE_DRIVE_API_KEY
}

/** X-Goog-Drive-Resource-Keys carries id/key pairs for resource-keyed
 *  files — the API key alone does not authorize them. */
const resourceKeyHeaders = (pairs: [string, string | undefined][]): Record<string, string> => {
  const value = pairs.filter((pair): pair is [string, string] => Boolean(pair[1])).map(([id, key]) => `${id}/${key}`).join(',')
  return value ? { 'X-Goog-Drive-Resource-Keys': value } : {}
}

const driveGet = async <T>(path: string, env: GDriveEnv, fetchImpl: typeof fetch, resourceKeys: [string, string | undefined][] = []): Promise<T> => {
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/${path}${path.includes('?') ? '&' : '?'}supportsAllDrives=true&key=${apiKey(env)}`, {
    headers: resourceKeyHeaders(resourceKeys),
  })
  if (!response.ok) {
    const message = await response.text()
    if (response.status === 404) throw new SourceFetchError('That Google Drive folder was not found — check the link is shared with "Anyone with the link"', 404)
    if (response.status === 403) throw new SourceFetchError('Manorama could not read that Google Drive folder — check the link is shared with "Anyone with the link"', 403)
    throw new SourceFetchError(`Google Drive request failed (${response.status}): ${message.slice(0, 220)}`, response.status)
  }
  return response.json() as Promise<T>
}

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'
const fileProxy = (fileId: string, resourceKey?: string) =>
  `/api/drive/file?id=${encodeURIComponent(fileId)}${resourceKey ? `&rk=${encodeURIComponent(resourceKey)}` : ''}`
const thumbnailProxy = (fileId: string, size: 'w256' | 'w2048', resourceKey?: string) =>
  `/api/drive/thumbnail?id=${encodeURIComponent(fileId)}&size=${size}${resourceKey ? `&rk=${encodeURIComponent(resourceKey)}` : ''}`

const collectFiles = async (folderId: string, folderKey: string | undefined, env: GDriveEnv, fetchImpl: typeof fetch) => {
  const files: DriveFile[] = []
  let pageToken = ''
  do {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,resourceKey,imageMediaMetadata)')
    const page = await driveGet<DriveList>(`files?q=${query}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`, env, fetchImpl, [[folderId, folderKey]])
    files.push(...(page.files ?? []))
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return files.filter((file) => file.mimeType && SUPPORTED_MIME.has(file.mimeType.toLowerCase()))
}

export const scanDriveFolder = async (input: string, env: GDriveEnv, fetchImpl: typeof fetch = fetch): Promise<DriveScan> => {
  const folder = extractDriveFolderId(input)
  if (!folder) throw new Error('Use a public Google Drive folder link')
  const files = await collectFiles(folder.id, folder.resourceKey, env, fetchImpl)
  if (!files.length) throw new Error('No image files were found in that public Google Drive folder')
  const meta = await driveGet<{ name?: string }>(`files/${encodeURIComponent(folder.id)}?fields=name`, env, fetchImpl, [[folder.id, folder.resourceKey]]).catch(() => ({ name: '' }))
  const title = (meta.name ?? '').trim() || 'Untitled gallery'
  const images = files.map((file, index): GalleryImage => {
    const width = file.imageMediaMetadata?.width || 4
    const height = file.imageMediaMetadata?.height || 3
    // HEIC/HEIF can't render in browsers; Drive transcodes to JPEG via
    // the thumbnail endpoint, so the display src is a large rendition —
    // the same treatment Dropbox HEIC files get.
    const viaDerivative = Boolean(file.mimeType && NEEDS_JPEG_DERIVATIVE.test(file.mimeType))
    return {
      id: `gdrive-${file.id.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
      ref: file.id,
      filename: file.name,
      src: viaDerivative ? thumbnailProxy(file.id, 'w2048', file.resourceKey) : fileProxy(file.id, file.resourceKey),
      width,
      height,
      alt: filenameLabel(file.name),
      c2pa: true,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
      variants: [{ width: 256, src: thumbnailProxy(file.id, 'w256', file.resourceKey), format: 'jpeg' }],
    }
  })
  return { sourceUrl: canonicalDriveUrl(folder.id, folder.resourceKey), title, images }
}

export const fetchDriveFile = async (fileId: string, env: GDriveEnv, fetchImpl: typeof fetch = fetch, resourceKey?: string) => {
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&key=${apiKey(env)}`, {
    headers: resourceKeyHeaders([[fileId, resourceKey]]),
  })
  if (!response.ok) throw new SourceFetchError(`Google Drive file fetch failed (${response.status})`, response.status)
  return response
}

/** Public thumbnail endpoint used by the Drive web UI — serves a JPEG
 *  rendition (transcoding HEIC/HEIF) for any link-shared file without
 *  credentials. The resource key rides as a query parameter; the
 *  X-Goog-Drive-Resource-Keys header does not apply to this endpoint. */
export const fetchDriveThumbnail = async (fileId: string, _env: GDriveEnv, size: 'w256' | 'w2048' = 'w256', fetchImpl: typeof fetch = fetch, resourceKey?: string) => {
  const width = size === 'w2048' ? 2048 : 256
  const response = await fetchImpl(`https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}${resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : ''}`)
  if (!response.ok) throw new SourceFetchError(`Google Drive thumbnail fetch failed (${response.status})`, response.status)
  return response
}
