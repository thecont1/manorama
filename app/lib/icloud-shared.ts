import { SourceFetchError, type GalleryImage, type GalleryMediaItem, type VideoItem } from './imagesource'

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

type Derivative = {
  fileSize?: number
  checksum?: string
  width?: number
  height?: number
  /** Apple marks video derivatives inconsistently across album vintages:
   *  some carry `fileType: 'public.mpeg-4'`, others only a `mediaAssetType`
   *  or a `Video` value in an opaque `derivativeType`. Every observed
   *  spelling is treated as a hint, never as proof. */
  fileType?: string
  mediaAssetType?: string
  derivativeType?: string
  /** Present on video derivatives in some responses. */
  duration?: number
}
type StreamPhoto = {
  photoGuid: string
  caption?: string
  mediaAssetType?: string
  width?: number
  height?: number
  /** Seconds; spelling varies by album vintage. */
  duration?: number
  videoDuration?: number
  derivatives?: Record<string, Derivative>
}
type StreamResponse = { streamName?: string; photos?: StreamPhoto[] }
type AssetUrls = {
  items?: Record<string, { url_location?: string; url_path?: string; url_expiry?: string }>
  locations?: Record<string, { scheme?: string; hosts?: string[] }>
}

export type ICloudScan = { sourceUrl: string; title: string; images: GalleryMediaItem[] }

/** The album token from either public link spelling:
 *  icloud.com/sharedalbum/#{token} and share.icloud.com/photos/{token}. */
export const extractAlbumToken = (input: string) => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  let token: string | null = null
  if (host === 'icloud.com' && url.pathname.startsWith('/sharedalbum/')) token = url.hash.replace(/^#/, '') || null
  if (host === 'share.icloud.com' && url.pathname.startsWith('/photos/')) token = url.pathname.slice('/photos/'.length).split('/')[0] || null
  // Newer Apple tokens use URL-safe base64 — underscores and hyphens
  // appear in real shared-album links.
  return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null
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
  // URL-safe base64 chars (-_) poison the guess — a wrong-but-valid
  // partition is fine because the 330 redirect names the real host.
  if (Number.isNaN(value) || value < 0) return '01'
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

const videoProxy = (token: string, guid: string, checksum: string) =>
  `/api/icloud/video?album=${encodeURIComponent(token)}&photo=${encodeURIComponent(guid)}&c=${encodeURIComponent(checksum)}`

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

/** Does this derivative look like the MP4 rather than the poster? Apple's
 *  marker field is not stable across album vintages, so several observed
 *  spellings count. Unmarked derivatives return false — the caller then
 *  falls back to size heuristics and finally to a content-type probe. */
const looksLikeVideoDerivative = (derivative: Derivative) => {
  const markers = [derivative.fileType, derivative.mediaAssetType, derivative.derivativeType]
  return markers.some((marker) => typeof marker === 'string' && /video|mpeg-4|mp4|movie|quicktime/i.test(marker))
}

/** Videos are entries the album itself marks as video. A `mediaAssetType`
 *  of 'video' is the reliable per-photo signal (the poster/video split
 *  lives one level down, in the derivatives). */
const isVideoEntry = (photo: StreamPhoto) => photo.mediaAssetType === 'video'

const durationOf = (photo: StreamPhoto, derivative?: Derivative) => {
  const seconds = derivative?.duration ?? photo.duration ?? photo.videoDuration
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * Splits a video entry's derivatives into the MP4 and its poster still.
 *
 * Marker fields are tried first. When Apple leaves them ambiguous the
 * split falls back to byte size: a transcoded clip is dramatically
 * heavier than its poster JPEG, so the largest `fileSize` is the video
 * and the largest *image* by pixel area among the rest is the poster.
 * `probe` (a live content-type check via webasseturls) is the final
 * arbiter and is only consulted when both heuristics are inconclusive.
 */
const splitVideoDerivatives = async (
  derivatives: Record<string, Derivative>,
  probe?: (checksum: string) => Promise<boolean>,
): Promise<{ video: Derivative; poster: Derivative } | null> => {
  const entries = Object.values(derivatives).filter((d) => d.checksum)
  if (entries.length < 2) return null
  const posterCandidates = entries.filter((d) => d.width && d.height)

  const marked = entries.filter(looksLikeVideoDerivative)
  const pickPoster = (video: Derivative) => {
    const rest = posterCandidates.filter((d) => d.checksum !== video.checksum)
    if (!rest.length) return null
    return rest.reduce((best, d) => ((d.width ?? 0) * (d.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? d : best))
  }

  if (marked.length === 1) {
    const poster = pickPoster(marked[0])
    return poster ? { video: marked[0], poster } : null
  }

  // Heaviest derivative wins when byte sizes are present and unambiguous:
  // an H.264 clip dwarfs its own poster frame.
  const sized = entries.filter((d) => typeof d.fileSize === 'number' && d.fileSize! > 0)
  if (sized.length >= 2) {
    const heaviest = sized.reduce((best, d) => (d.fileSize! > best.fileSize! ? d : best))
    const nextSize = Math.max(...sized.filter((d) => d.checksum !== heaviest.checksum).map((d) => d.fileSize!))
    if (heaviest.fileSize! >= nextSize * 2) {
      const poster = pickPoster(heaviest)
      if (poster) return { video: heaviest, poster }
    }
  }

  // Last resort: ask the CDN what each candidate actually is. Ordered
  // heaviest-first so the probable video is probed on the first call.
  if (probe) {
    const ordered = [...entries].sort((a, b) => (b.fileSize ?? 0) - (a.fileSize ?? 0))
    for (const candidate of ordered) {
      let confirmed = false
      try {
        confirmed = await probe(candidate.checksum!)
      } catch {
        // A failed probe is inconclusive, not fatal — try the next one.
        continue
      }
      if (!confirmed) continue
      const poster = pickPoster(candidate)
      if (poster) return { video: candidate, poster }
    }
  }
  return null
}

const placeholderFor = (width: number, height: number) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`

/** Resolves a derivative's real CDN content type. Used only to break a
 *  tie the album metadata left ambiguous. */
const probeDerivativeIsVideo = (token: string, photoGuid: string, fetchImpl: typeof fetch) =>
  async (checksum: string) => {
    const assets = await postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl)
    const item = assets.items?.[checksum]
    const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
    if (!item?.url_path || !location?.scheme || !location.hosts?.length) return false
    const url = `${location.scheme}://${location.hosts[0]}${item.url_path}`
    const response = await fetchImpl(url, { method: 'HEAD' })
    const contentType = response.headers.get('Content-Type') ?? ''
    return /^video\//i.test(contentType)
  }

export const scanICloudAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<ICloudScan> => {
  const token = extractAlbumToken(input)
  if (!token) throw new Error('Use a public iCloud shared album link')
  const stream = await postSharedstreams<StreamResponse>(token, 'webstream', { streamCtag: null }, fetchImpl)
  const entries = (stream.photos ?? []).filter((photo) => photo.derivatives && Object.keys(photo.derivatives).length)

  const items: GalleryMediaItem[] = []
  let index = 0
  for (const photo of entries) {
    const caption = photo.caption?.trim()
    const position = index + 1
    const id = `icloud-${photo.photoGuid.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || position}`

    if (isVideoEntry(photo)) {
      // Incomplete video entries are skipped exactly like preview-less
      // images — a gallery never renders a slide it cannot play.
      const split = await splitVideoDerivatives(photo.derivatives!, probeDerivativeIsVideo(token, photo.photoGuid, fetchImpl))
      if (!split) continue
      const { video, poster } = split
      const width = video.width || poster.width || photo.width || 16
      const height = video.height || poster.height || photo.height || 9
      const item: VideoItem = {
        type: 'video',
        id,
        ref: photo.photoGuid,
        filename: caption || `Video ${position}`,
        src: videoProxy(token, photo.photoGuid, video.checksum!),
        mimeType: 'video/mp4',
        width,
        height,
        poster: {
          src: imageProxy(token, photo.photoGuid, poster.checksum!),
          width: poster.width || width,
          height: poster.height || height,
        },
        alt: caption || 'Video',
        c2pa: false,
        placeholder: placeholderFor(width, height),
        // The poster doubles as the rail/strip thumbnail, so every
        // `variants?.[0]?.src` consumer keeps working untouched.
        variants: [{ width: poster.width || width, src: imageProxy(token, photo.photoGuid, poster.checksum!), format: 'jpeg' }],
      }
      const durationSeconds = durationOf(photo, video)
      if (durationSeconds !== undefined) item.durationSeconds = durationSeconds
      if (caption) item.caption = caption
      items.push(item)
      index += 1
      continue
    }

    const largest = pickDerivative(photo.derivatives!, 'largest')
    const smallest = pickDerivative(photo.derivatives!, 'smallest')
    if (!largest || !smallest) continue
    const width = largest.width || photo.width || 4
    const height = largest.height || photo.height || 3
    const image: GalleryImage = {
      id,
      ref: photo.photoGuid,
      filename: caption || `Photo ${position}`,
      src: imageProxy(token, photo.photoGuid, largest.checksum!),
      width,
      height,
      alt: caption || 'Photograph',
      caption,
      c2pa: false,
      placeholder: placeholderFor(width, height),
      variants: [{ width: smallest.width || 256, src: imageProxy(token, photo.photoGuid, smallest.checksum!), format: 'jpeg' }],
    }
    items.push(image)
    index += 1
  }

  if (!items.length) throw new Error('No photos or videos were found in that public iCloud album')
  return { sourceUrl: canonicalICloudUrl(token), title: stream.streamName?.trim() || 'Shared album', images: items }
}

/** Resolves the short-lived CDN URL for one derivative checksum. Asset
 *  URLs carry an expiry, so they are resolved per view and never
 *  persisted. Shared by the image and video proxies. */
const resolveAssetUrl = async (token: string, photoGuid: string, checksum: string, fetchImpl: typeof fetch) => {
  const assets = await postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl)
  const item = assets.items?.[checksum]
  const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
  if (!item?.url_path || !location?.scheme || !location.hosts?.length) return null
  return `${location.scheme}://${location.hosts[0]}${item.url_path}`
}

/** Resolves a fresh CDN URL for one derivative and streams it. Asset URLs
 *  carry an expiry, so they are resolved per view and never persisted. */
export const fetchICloudImage = async (token: string, photoGuid: string, checksum: string, fetchImpl: typeof fetch = fetch) => {
  const url = await resolveAssetUrl(token, photoGuid, checksum, fetchImpl)
  if (!url) throw new SourceFetchError('That iCloud image is unavailable', 404)
  const response = await fetchImpl(url)
  if (!response.ok) throw new SourceFetchError(`iCloud image fetch failed (${response.status})`, response.status)
  return response
}

/**
 * Streams a video derivative, forwarding the visitor's Range header
 * upstream so seeking fetches bytes instead of the whole clip. A 206 from
 * the CDN is passed through intact (status, Content-Range, Accept-Ranges)
 * by the caller; both 200 and 206 are success here.
 */
export const fetchICloudVideo = async (
  token: string,
  photoGuid: string,
  checksum: string,
  range?: string | null,
  fetchImpl: typeof fetch = fetch,
) => {
  const url = await resolveAssetUrl(token, photoGuid, checksum, fetchImpl)
  if (!url) throw new SourceFetchError('That iCloud video is unavailable', 404)
  const response = await fetchImpl(url, range ? { headers: { Range: range } } : undefined)
  // 206 is the expected answer to a Range request and `ok` is false for it.
  if (!response.ok && response.status !== 206) {
    throw new SourceFetchError(`iCloud video fetch failed (${response.status})`, response.status)
  }
  return response
}
