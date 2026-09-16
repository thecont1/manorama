import { SourceFetchError, type GalleryImage } from './imagesource'

/**
 * iCloud public Shared Album scanning via the same `sharedstreams`
 * endpoints Apple's own web viewer uses. No credentials at all — the
 * album token in the public link is the only key.
 *
 * Two caveats this module lives with:
 *  - The API is undocumented and unsupported; Apple can change or break
 *    it without notice. Failures surface as friendly scan errors.
 *  - Shared albums serve web-optimized JPEG derivatives only (~2048px
 *    max) — never originals — so `c2pa` is always false and quality is
 *    capped at web display resolution.
 */

const PHOTOS_UA = 'Photos/5.0 (Macintosh; OS X 10.15.4) AppleWebKit/605.1.15'
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

type Derivative = { fileSize?: number; checksum?: string; width?: number; height?: number }
type StreamPhoto = {
  photoGuid: string
  caption?: string
  mediaAssetType?: string
  width?: number
  height?: number
  derivatives?: Record<string, Derivative>
}
type StreamResponse = { streamName?: string; photos?: StreamPhoto[] }
type AssetUrls = {
  items?: Record<string, { url_location?: string; url_path?: string; url_expiry?: string }>
  locations?: Record<string, { scheme?: string; hosts?: string[] }>
}

export type ICloudScan = { sourceUrl: string; title: string; images: GalleryImage[] }

/** The album token from either public link spelling:
 *  icloud.com/sharedalbum/#{token} and share.icloud.com/photos/{token}. */
export const extractAlbumToken = (input: string) => {
  const url = new URL(input.trim())
  const host = url.hostname.replace(/^www\./, '')
  let token: string | null = null
  if (host === 'icloud.com' && url.pathname.startsWith('/sharedalbum/')) token = url.hash.replace(/^#/, '') || null
  if (host === 'share.icloud.com' && url.pathname.startsWith('/photos/')) token = url.pathname.slice('/photos/'.length).split('/')[0] || null
  return token && /^[A-Za-z0-9]+$/.test(token) ? token : null
}

export const canonicalICloudUrl = (token: string) => `https://www.icloud.com/sharedalbum/#${token}`

/** iCloud Drive share links (icloud.com/iclouddrive/{token}#name) are a
 *  different product from Photos shared albums: folder contents sit behind
 *  CloudKit's authenticated sharing, so they cannot be scanned without a
 *  sign-in. Recognized only to produce a specific error. */
export const isICloudDriveLink = (input: string) => {
  try {
    const url = new URL(input.trim())
    return url.hostname.replace(/^www\./, '') === 'icloud.com' && url.pathname.startsWith('/iclouddrive/')
  } catch {
    return false
  }
}

const base62ToInt = (input: string) =>
  Array.from(input).reduce((result, char) => result * 62 + BASE62.indexOf(char), 0)

/** The server partition is encoded in the token itself: one base62 char
 *  after a leading 'A', two otherwise. */
const partitionFromToken = (token: string) => {
  const value = token[0] === 'A' ? base62ToInt(token[1] ?? '0') : base62ToInt(token.slice(1, 3) || '0')
  return value < 10 ? `0${value}` : `${value}`
}

/** POSTs a sharedstreams call, following Apple's 330 partition redirect
 *  once (the response body carries the real host, the header the real
 *  partition). */
const postSharedstreams = async <T>(token: string, endpoint: string, body: unknown, fetchImpl: typeof fetch): Promise<T & { partition?: string }> => {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache', 'User-Agent': PHOTOS_UA },
    body: JSON.stringify(body),
  }
  let response = await fetchImpl(`https://p${partitionFromToken(token)}-sharedstreams.icloud.com/${token}/sharedstreams/${endpoint}`, options)
  let partition = response.headers.get('x-apple-user-partition') || partitionFromToken(token)
  if (response.status === 330) {
    const hint = await response.json() as Record<string, string>
    const host = hint['X-Apple-MMe-Host']
    if (!host) throw new SourceFetchError('iCloud could not locate that shared album', 503)
    response = await fetchImpl(`https://${host}/${token}/sharedstreams/${endpoint}`, options)
  }
  if (!response.ok) throw new SourceFetchError('Manorama could not read that iCloud album — check that it is a public Shared Album link', response.status)
  const data = await response.json() as T
  return { ...data, partition }
}

const imageProxy = (token: string, guid: string, checksum: string) =>
  `/api/icloud/image?album=${encodeURIComponent(token)}&photo=${encodeURIComponent(guid)}&c=${encodeURIComponent(checksum)}`

/** Largest derivative by pixel area drives display; smallest is the strip
 *  thumbnail. Derivatives have no names — keys are opaque, so we choose
 *  on size alone. */
const pickDerivative = (derivatives: Record<string, Derivative>, pick: 'largest' | 'smallest') => {
  const entries = Object.values(derivatives).filter((d) => d.checksum && d.width && d.height)
  if (!entries.length) return null
  return entries.reduce((best, d) => {
    const area = (d.width ?? 0) * (d.height ?? 0)
    const bestArea = (best.width ?? 0) * (best.height ?? 0)
    return pick === 'largest' ? (area > bestArea ? d : best) : (area < bestArea ? d : best)
  })
}

export const scanICloudAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<ICloudScan> => {
  const token = extractAlbumToken(input)
  if (!token) throw new Error('Use a public iCloud shared album link')
  const stream = await postSharedstreams<StreamResponse>(token, 'webstream', { streamCtag: null }, fetchImpl)
  const photos = (stream.photos ?? [])
    .filter((photo) => photo.mediaAssetType !== 'video' && photo.derivatives && Object.keys(photo.derivatives).length)
    .flatMap((photo) => {
      const largest = pickDerivative(photo.derivatives!, 'largest')
      const smallest = pickDerivative(photo.derivatives!, 'smallest')
      return largest && smallest ? [{ photo, largest, smallest }] : []
    })
  if (!photos.length) throw new Error('No photos were found in that public iCloud album')
  const images = photos.map(({ photo, largest, smallest }, index): GalleryImage => {
    const width = largest.width || photo.width || 4
    const height = largest.height || photo.height || 3
    const caption = photo.caption?.trim()
    return {
      id: `icloud-${photo.photoGuid.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
      ref: photo.photoGuid,
      filename: caption || `Photo ${index + 1}`,
      src: imageProxy(token, photo.photoGuid, largest.checksum!),
      width,
      height,
      alt: caption || 'Photograph',
      caption,
      c2pa: false,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
      variants: [{ width: smallest.width || 256, src: imageProxy(token, photo.photoGuid, smallest.checksum!), format: 'jpeg' }],
    }
  })
  return { sourceUrl: canonicalICloudUrl(token), title: stream.streamName?.trim() || 'Shared album', images }
}

/** Resolves a fresh CDN URL for one derivative and streams it. Asset URLs
 *  carry an expiry, so they are resolved per view and never persisted. */
export const fetchICloudImage = async (token: string, photoGuid: string, checksum: string, fetchImpl: typeof fetch = fetch) => {
  const assets = await postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl)
  const item = assets.items?.[checksum]
  const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
  if (!item?.url_path || !location?.scheme || !location.hosts?.length) throw new SourceFetchError('That iCloud image is unavailable', 404)
  const response = await fetchImpl(`${location.scheme}://${location.hosts[0]}${item.url_path}`)
  if (!response.ok) throw new SourceFetchError(`iCloud image fetch failed (${response.status})`, response.status)
  return response
}
