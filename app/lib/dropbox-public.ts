import type { GalleryImage } from './imagesource'

const IMAGE_EXTENSIONS = /\.(?:jpe?g|png|webp|gif|tiff?)$/i
const ALLOWED_HOSTS = new Set(['dropbox.com', 'www.dropbox.com'])

type DropboxEnv = { DROPBOX_APP_KEY?: string; DROPBOX_APP_SECRET?: string }
type DropboxEntry = { '.tag': 'file' | 'folder'; name: string; id: string; size?: number; media_info?: { metadata?: { dimensions?: { width?: number; height?: number } } } }
type ListResponse = { entries: DropboxEntry[]; cursor: string; has_more: boolean }

export type DropboxScan = { sourceUrl: string; title: string; images: GalleryImage[] }

const validateFolderUrl = (input: string) => {
  const url = new URL(input.trim())
  if (!ALLOWED_HOSTS.has(url.hostname) || !/^\/(?:scl\/fo|sh)\//.test(url.pathname)) throw new Error('Use a public Dropbox folder link')
  url.searchParams.set('dl', '0')
  return url.toString()
}

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'
const originalProxy = (sourceUrl: string, filename: string) => `/api/dropbox/file?sourceUrl=${encodeURIComponent(sourceUrl)}&filename=${encodeURIComponent(filename)}`
const thumbnailProxy = (sourceUrl: string, filename: string) => `/api/dropbox/thumbnail?sourceUrl=${encodeURIComponent(sourceUrl)}&filename=${encodeURIComponent(filename)}`

const authHeaders = (env: DropboxEnv) => {
  if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) throw new Error('Dropbox app credentials are not configured')
  return { Authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}` }
}

const rpc = async <T>(endpoint: string, body: unknown, env: DropboxEnv) => {
  const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Dropbox ${endpoint} failed (${response.status}): ${message.slice(0, 220)}`)
  }
  return response.json() as Promise<T>
}

const contentRequest = async (endpoint: string, arg: unknown, env: DropboxEnv) => {
  const response = await fetch(`https://content.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { ...authHeaders(env), 'Dropbox-API-Arg': JSON.stringify(arg) },
  })
  if (!response.ok) throw new Error(`Dropbox ${endpoint} failed (${response.status})`)
  return response
}

const parseJpegDimensions = (bytes: Uint8Array) => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3]
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: (bytes[offset + 7] << 8) + bytes[offset + 8], height: (bytes[offset + 5] << 8) + bytes[offset + 6] }
    }
    offset += Math.max(2, length + 2)
  }
  return null
}

const thumbnailDimensions = async (sourceUrl: string, filename: string, env: DropboxEnv, fallback?: { width?: number; height?: number }) => {
  try {
    const response = await contentRequest('files/get_thumbnail_v2', {
      resource: { '.tag': 'link', url: sourceUrl, path: `/${filename}` },
      format: { '.tag': 'jpeg' },
      size: 'w256h256',
      mode: 'strict',
    }, env)
    const dimensions = parseJpegDimensions(new Uint8Array(await response.arrayBuffer()))
    if (dimensions) return dimensions
  } catch {
    // A preview is helpful but not required to validate the folder.
  }
  return { width: fallback?.width || 4, height: fallback?.height || 3 }
}

const collectEntries = async (sourceUrl: string, env: DropboxEnv) => {
  const entries: DropboxEntry[] = []
  let response = await rpc<ListResponse>('files/list_folder', { path: '', shared_link: { url: sourceUrl }, include_media_info: true }, env)
  entries.push(...response.entries)
  while (response.has_more) response = await rpc<ListResponse>('files/list_folder/continue', { cursor: response.cursor }, env), entries.push(...response.entries)
  return entries.filter((entry) => entry['.tag'] === 'file' && IMAGE_EXTENSIONS.test(entry.name))
}

const titleFromEntries = (entries: DropboxEntry[]) => {
  const filename = entries[0]?.name.replace(/\.[^.]+$/, '') || ''
  const match = filename.match(/^MS\d{6,8}-([A-Za-z][A-Za-z _-]*)\d*$/i)
  if (match?.[1]) return match[1].replace(/[-_]+/g, ' ').trim()
  return 'Untitled gallery'
}

export const scanDropboxFolder = async (input: string, env: DropboxEnv): Promise<DropboxScan> => {
  const sourceUrl = validateFolderUrl(input)
  const entries = await collectEntries(sourceUrl, env)
  if (!entries.length) throw new Error('No image files were found in that public Dropbox folder')
  const title = titleFromEntries(entries)
  const images = await Promise.all(entries.map(async (entry, index) => {
    const dimensions = await thumbnailDimensions(sourceUrl, entry.name, env, entry.media_info?.metadata?.dimensions)
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
    } satisfies GalleryImage
  }))
  return { sourceUrl, title, images }
}

export const fetchDropboxFile = async (sourceUrlInput: string, filename: string, env: DropboxEnv) => {
  const sourceUrl = validateFolderUrl(sourceUrlInput)
  return contentRequest('sharing/get_shared_link_file', { url: sourceUrl, path: `/${filename}` }, env)
}

export const fetchDropboxThumbnail = async (sourceUrlInput: string, filename: string, env: DropboxEnv) => {
  const sourceUrl = validateFolderUrl(sourceUrlInput)
  return contentRequest('files/get_thumbnail_v2', {
    resource: { '.tag': 'link', url: sourceUrl, path: `/${filename}` },
    format: { '.tag': 'jpeg' },
    size: 'w256h256',
    mode: 'strict',
  }, env)
}
