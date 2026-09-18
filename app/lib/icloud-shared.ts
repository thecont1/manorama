import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage, type GalleryMediaItem, type VideoItem } from './imagesource'

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
  /** Numeric fields arrive as STRINGS in some album vintages
   *  ("fileSize": "3846231") — always read through `num`. */
  fileSize?: number | string
  checksum?: string
  width?: number | string
  height?: number | string
  /** Apple marks video derivatives inconsistently across album vintages:
   *  some carry `fileType: 'public.mpeg-4'`, others only a `mediaAssetType`
   *  or a `Video` value in an opaque `derivativeType`. Every observed
   *  spelling is treated as a hint, never as proof. */
  fileType?: string
  mediaAssetType?: string
  derivativeType?: string
  /** Present on video derivatives in some responses. */
  duration?: number | string
  /** "available" when the derivative can actually be fetched. */
  state?: string
}
type StreamPhoto = {
  photoGuid: string
  caption?: string
  mediaAssetType?: string
  width?: number | string
  height?: number | string
  /** Seconds; spelling varies by album vintage. */
  duration?: number | string
  videoDuration?: number | string
  derivatives?: Record<string, Derivative>
}

/** Coerces Apple's number-or-string fields; anything unusable is undefined. */
const num = (value: number | string | undefined) => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
type StreamResponse = { streamName?: string; photos?: StreamPhoto[] }
type AssetUrls = {
  items?: Record<string, { url_location?: string; url_path?: string; url_expiry?: string }>
  locations?: Record<string, { scheme?: string; hosts?: string[] }>
}

export type ICloudScan = { sourceUrl: string; title: string; images: GalleryMediaItem[]; truncated?: number }

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
 *  thumbnail. For photos the keys are opaque, so we choose on size alone. */
const pickDerivative = (derivatives: Record<string, Derivative>, pick: 'largest' | 'smallest') => {
  const entries = Object.values(derivatives).filter((d) => d.checksum && num(d.width) && num(d.height))
  if (!entries.length) return null
  return entries.reduce((best, d) => {
    const area = (num(d.width) ?? 0) * (num(d.height) ?? 0)
    const bestArea = (num(best.width) ?? 0) * (num(best.height) ?? 0)
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
  const seconds = num(derivative?.duration) ?? num(photo.duration) ?? num(photo.videoDuration)
  return seconds !== undefined && seconds > 0 ? seconds : undefined
}

/** Video rendition keys observed in the wild: `720p`, `360p`, `240p`. */
const VIDEO_DERIVATIVE_KEY = /^\d{3,4}p$|video|mp4|movie|quicktime/i
/** Poster keys observed in the wild: `PosterFrame`, `Poster`, `thumbnail`. */
const POSTER_DERIVATIVE_KEY = /poster|frame|still|thumb/i

/**
 * Splits a video entry's derivatives into the MP4 and its poster still.
 *
 * Four signals, tried strongest-first: explicit marker fields (some
 * vintages); the derivative's own key name (`720p` vs `PosterFrame` —
 * other vintages carry roles there and nothing else); byte size (an
 * H.264 clip dwarfs its own poster frame); and finally `probe`, a live
 * content-type check via webasseturls, consulted only when every cheaper
 * signal was inconclusive.
 */
const splitVideoDerivatives = async (
  derivatives: Record<string, Derivative>,
  probe?: (checksum: string) => Promise<boolean>,
): Promise<{ video: Derivative; poster: Derivative } | null> => {
  const entries = Object.entries(derivatives).filter(([, d]) => d.checksum && (!d.state || d.state === 'available'))
  if (entries.length < 2) return null
  const posterCandidates = entries.filter(([, d]) => num(d.width) && num(d.height))
  const bytes = (d: Derivative) => num(d.fileSize) ?? 0
  const area = (d: Derivative) => (num(d.width) ?? 0) * (num(d.height) ?? 0)
  const heaviestOf = (list: [string, Derivative][]) =>
    list.reduce((best, entry) => (bytes(entry[1]) > bytes(best[1]) ? entry : best))[1]

  // The poster: a poster-named key when one exists, else the largest
  // frame among whatever the video did not claim.
  const pickPoster = (video: Derivative) => {
    const rest = posterCandidates.filter(([, d]) => d.checksum !== video.checksum)
    if (!rest.length) return null
    const named = rest.filter(([key]) => POSTER_DERIVATIVE_KEY.test(key))
    const pool = named.length ? named : rest
    return pool.reduce((best, entry) => (area(entry[1]) > area(best[1]) ? entry : best))[1]
  }

  const candidates: Derivative[] = []
  const marked = entries.filter(([, d]) => looksLikeVideoDerivative(d))
  if (marked.length) candidates.push(heaviestOf(marked))
  const keyed = entries.filter(([key]) => VIDEO_DERIVATIVE_KEY.test(key))
  if (keyed.length) candidates.push(heaviestOf(keyed))

  // Heaviest derivative wins when byte sizes are present and unambiguous:
  // an H.264 clip dwarfs its own poster frame.
  const sized = entries.filter(([, d]) => bytes(d) > 0)
  if (sized.length >= 2) {
    const heaviest = sized.reduce((best, entry) => (bytes(entry[1]) > bytes(best[1]) ? entry : best))[1]
    const nextSize = Math.max(...sized.filter(([, d]) => d.checksum !== heaviest.checksum).map(([, d]) => bytes(d)))
    if (bytes(heaviest) >= nextSize * 2) candidates.push(heaviest)
  }

  for (const video of candidates) {
    const poster = pickPoster(video)
    if (poster) return { video, poster }
  }

  // Last resort: ask the CDN what each candidate actually is. Ordered
  // heaviest-first so the probable video is probed on the first call.
  if (probe) {
    const ordered = [...entries].sort(([, a], [, b]) => bytes(b) - bytes(a))
    for (const [, candidate] of ordered) {
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
 *  tie the album metadata left ambiguous. The asset map is fetched once
 *  for all candidates; the url_path's own filename (.mp4 vs .JPG) answers
 *  most probes without touching the CDN, and when it can't, a HEAD is
 *  tried and then a 1-byte Range GET — some CDN vintages refuse HEAD
 *  outright (501) while happily serving ranged GETs. */
const probeDerivativeIsVideo = (token: string, photoGuid: string, fetchImpl: typeof fetch) => {
  let paths: Promise<Map<string, string>> | undefined
  const assetPaths = () => (paths ??= postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl)
    .then((assets) => {
      const map = new Map<string, string>()
      for (const [checksum, item] of Object.entries(assets.items ?? {})) {
        const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
        if (item?.url_path && location?.scheme && location.hosts?.length) {
          map.set(checksum, `${location.scheme}://${location.hosts[0]}${item.url_path}`)
        }
      }
      return map
    }))
  return async (checksum: string) => {
    const url = (await assetPaths()).get(checksum)
    if (!url) return false
    const extension = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase()
    if (extension && /^(mp4|mov|m4v|qt)$/.test(extension)) return true
    if (extension && /^(jpe?g|png|webp|heic|heif|gif|tiff?)$/.test(extension)) return false
    let response = await fetchImpl(url, { method: 'HEAD' })
    if (response.status === 501 || response.status === 405) {
      response = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } })
    }
    return /^video\//i.test(response.headers.get('Content-Type') ?? '')
  }
}

export const scanICloudAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<ICloudScan> => {
  const token = extractAlbumToken(input)
  if (!token) throw new Error('Use a public iCloud shared album link')
  const stream = await postSharedstreams<StreamResponse>(token, 'webstream', { streamCtag: null }, fetchImpl)
  const found = (stream.photos ?? []).filter((photo) => photo.derivatives && Object.keys(photo.derivatives).length)
  // Cap before the per-item loop — video candidates each cost a HEAD or
  // ranged probe against Apple's CDN, so an uncapped album multiplies
  // into minutes.
  const entries = found.slice(0, MAX_GALLERY_ITEMS)

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
      const width = num(video.width) || num(poster.width) || num(photo.width) || 16
      const height = num(video.height) || num(poster.height) || num(photo.height) || 9
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
          width: num(poster.width) || width,
          height: num(poster.height) || height,
        },
        alt: caption || 'Video',
        c2pa: false,
        placeholder: placeholderFor(width, height),
        // The poster doubles as the rail/strip thumbnail, so every
        // `variants?.[0]?.src` consumer keeps working untouched.
        variants: [{ width: num(poster.width) || width, src: imageProxy(token, photo.photoGuid, poster.checksum!), format: 'jpeg' }],
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
    const width = num(largest.width) || num(photo.width) || 4
    const height = num(largest.height) || num(photo.height) || 3
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
      variants: [{ width: num(smallest.width) || 256, src: imageProxy(token, photo.photoGuid, smallest.checksum!), format: 'jpeg' }],
    }
    items.push(image)
    index += 1
  }

  if (!items.length) throw new Error('No photos or videos were found in that public iCloud album')
  return { sourceUrl: canonicalICloudUrl(token), title: stream.streamName?.trim() || 'Shared album', images: items, ...(found.length > entries.length ? { truncated: found.length } : {}) }
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
