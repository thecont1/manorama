import type { GalleryImage } from './imagesource'

/**
 * Google Drive "anyone with the link" folder scanning. Mirrors the Dropbox
 * model: no per-user OAuth — a single API key (GOOGLE_DRIVE_API_KEY) reads
 * link-shared folders. The Drive API requires every request to identify a
 * Google Cloud project; the key does that without impersonating a user.
 *
 * File IDs are globally unique in Drive, so the proxy routes key on the
 * file ID alone — the folder context is only needed at scan time.
 */

const SUPPORTED_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif', 'image/tiff',
])
const HEIC_MIME = /^image\/hei[cf]$/i

type GDriveEnv = { GOOGLE_DRIVE_API_KEY?: string }

type DriveFile = {
  id: string
  name: string
  mimeType?: string
  imageMediaMetadata?: { width?: number; height?: number }
}
type DriveList = { files?: DriveFile[]; nextPageToken?: string }

export type DriveScan = { sourceUrl: string; title: string; images: GalleryImage[] }

/** Extracts the folder ID from the common sharing URL spellings:
 *  drive.google.com/drive/folders/{id}, /drive/u/{n}/folders/{id},
 *  open?id={id}. */
export const extractDriveFolderId = (input: string) => {
  const url = new URL(input.trim())
  if (url.hostname !== 'drive.google.com') return null
  const folders = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (folders) return folders[1]
  if (url.pathname === '/open' && url.searchParams.get('id')) return url.searchParams.get('id')
  return null
}

export const canonicalDriveUrl = (folderId: string) =>
  `https://drive.google.com/drive/folders/${folderId}`

const apiKey = (env: GDriveEnv) => {
  if (!env.GOOGLE_DRIVE_API_KEY) throw new Error('Google Drive access is not configured')
  return env.GOOGLE_DRIVE_API_KEY
}

const driveGet = async <T>(path: string, env: GDriveEnv, fetchImpl: typeof fetch): Promise<T> => {
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/${path}${path.includes('?') ? '&' : '?'}key=${apiKey(env)}`)
  if (!response.ok) {
    const message = await response.text()
    if (response.status === 404) throw new Error('That Google Drive folder was not found — check the link is shared with "Anyone with the link"')
    if (response.status === 403) throw new Error('Manorama could not read that Google Drive folder — check the link is shared with "Anyone with the link"')
    throw new Error(`Google Drive request failed (${response.status}): ${message.slice(0, 220)}`)
  }
  return response.json() as Promise<T>
}

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'
const fileProxy = (fileId: string) => `/api/drive/file?id=${encodeURIComponent(fileId)}`
const thumbnailProxy = (fileId: string, size: 'w256' | 'w2048') => `/api/drive/thumbnail?id=${encodeURIComponent(fileId)}&size=${size}`

const collectFiles = async (folderId: string, env: GDriveEnv, fetchImpl: typeof fetch) => {
  const files: DriveFile[] = []
  let pageToken = ''
  do {
    const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
    const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,imageMediaMetadata)')
    const page = await driveGet<DriveList>(`files?q=${query}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`, env, fetchImpl)
    files.push(...(page.files ?? []))
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return files.filter((file) => file.mimeType && SUPPORTED_MIME.has(file.mimeType.toLowerCase()))
}

export const scanDriveFolder = async (input: string, env: GDriveEnv, fetchImpl: typeof fetch = fetch): Promise<DriveScan> => {
  const folderId = extractDriveFolderId(input)
  if (!folderId) throw new Error('Use a public Google Drive folder link')
  const files = await collectFiles(folderId, env, fetchImpl)
  if (!files.length) throw new Error('No image files were found in that public Google Drive folder')
  const folder = await driveGet<{ name?: string }>(`files/${encodeURIComponent(folderId)}?fields=name`, env, fetchImpl).catch(() => ({ name: '' }))
  const title = (folder.name ?? '').trim() || 'Untitled gallery'
  const images = files.map((file, index): GalleryImage => {
    const width = file.imageMediaMetadata?.width || 4
    const height = file.imageMediaMetadata?.height || 3
    // HEIC can't render in browsers; Drive transcodes to JPEG via the
    // thumbnail endpoint, so the display src is a large JPEG rendition —
    // the same treatment Dropbox HEIC files get.
    const heic = Boolean(file.mimeType && HEIC_MIME.test(file.mimeType))
    return {
      id: `gdrive-${file.id.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
      ref: file.id,
      filename: file.name,
      src: heic ? thumbnailProxy(file.id, 'w2048') : fileProxy(file.id),
      width,
      height,
      alt: filenameLabel(file.name),
      c2pa: true,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
      variants: [{ width: 256, src: thumbnailProxy(file.id, 'w256'), format: 'jpeg' }],
    }
  })
  return { sourceUrl: canonicalDriveUrl(folderId), title, images }
}

export const fetchDriveFile = async (fileId: string, env: GDriveEnv, fetchImpl: typeof fetch = fetch) => {
  const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${apiKey(env)}`)
  if (!response.ok) throw new Error(`Google Drive file fetch failed (${response.status})`)
  return response
}

/** Public thumbnail endpoint used by the Drive web UI — serves a JPEG
 *  rendition (transcoding HEIC) for any link-shared file without
 *  credentials. */
export const fetchDriveThumbnail = async (fileId: string, _env: GDriveEnv, size: 'w256' | 'w2048' = 'w256', fetchImpl: typeof fetch = fetch) => {
  const width = size === 'w2048' ? 2048 : 256
  const response = await fetchImpl(`https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`)
  if (!response.ok) throw new Error(`Google Drive thumbnail fetch failed (${response.status})`)
  return response
}
