import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage, type GalleryMediaItem, type VideoItem } from './imagesource'
import { MAX_RETRY_WAIT_MS, PROBE_RETRY_WAIT_MS, retryAfterMs } from './transient-retry'

/**
 * iCloud public Shared Album scanning via the same `sharedstreams`
 * endpoints Apple's own web viewer uses. No credentials at all — the
 * album token in the public link is the only key.
 *
 * Two caveats this module lives with:
 *  - The API is undocumented and unsupported; Apple can change or break
 *    it without notice. Failures surface as friendly scan errors.
 *  - Legacy sharedstreams albums serve web-optimized JPEG derivatives
 *    (~2048px max). CloudKit shared albums can expose resOriginalRes;
 *    those originals, including HEIC, are streamed without re-encoding.
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

/** The token alphabet: newer Apple tokens use URL-safe base64 —
 *  underscores and hyphens appear in real shared-album links. */
export const isAlbumToken = (s: string) => /^[A-Za-z0-9_-]+$/.test(s)

/** Apple retired the sharedstreams link format with iOS/macOS 26:
 *  icloud.com/sharedalbum/#{token} and share.icloud.com/photos/{token}
 *  are 'legacy' shares; photos.icloud.com/shared/album/{shortGUID} is a
 *  CloudKit share, which the sharedstreams API cannot see at all. */
export type ICloudLinkKind = 'legacy' | 'cloudkit'

export const icloudLinkKind = (input: string): ICloudLinkKind | null => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'icloud.com' && url.pathname.startsWith('/sharedalbum/')) return 'legacy'
  if (host === 'share.icloud.com' && url.pathname.startsWith('/photos/')) return 'legacy'
  if (host === 'photos.icloud.com' && url.pathname.startsWith('/shared/album/')) return 'cloudkit'
  return null
}

/** The album token from any public link spelling — fragment for legacy
 *  shares, path segment for CloudKit ones. */
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
  if (host === 'photos.icloud.com' && url.pathname.startsWith('/shared/album/')) {
    token = url.pathname.slice('/shared/album/'.length).split('/')[0] || null
  }
  return token && isAlbumToken(token) ? token : null
}

export const canonicalICloudUrl = (token: string) => `https://www.icloud.com/sharedalbum/#${token}`
/** CloudKit links keep the token in the path — the canonical form is a
 *  URL a server can actually receive, unlike the fragment kind. */
export const canonicalICloudCloudKitUrl = (token: string) => `https://photos.icloud.com/shared/album/${token}`

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
  let response = await request(fetchImpl, `https://p${partitionFromToken(token)}-sharedstreams.icloud.com/${token}/sharedstreams/${endpoint}`, options)
  let partition = response.headers.get('x-apple-user-partition') || partitionFromToken(token)
  if (response.status === 330) {
    const hint = await response.json() as Record<string, string>
    const host = hint['X-Apple-MMe-Host']
    if (!host) throw new SourceFetchError('iCloud could not locate that shared album', 503)
    response = await request(fetchImpl, `https://${host}/${token}/sharedstreams/${endpoint}`, options)
  }
  if (!response.ok) throw transientError('Manorama could not read that iCloud album — check that it is a public Shared Album link', response)
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

/** The scan path validates references via extractAlbumToken; a hand-built
 *  /api/icloud/* URL reaches the proxies unvetted — a '/' or '?' in the
 *  token escapes the sharedstreams URL structure. */
const validateProxyReference = (kind: 'image' | 'video', token: string, photoGuid: string, checksum: string) => {
  if (!isAlbumToken(token) || !/^[A-Za-z0-9-]+$/.test(photoGuid) || !/^[A-Za-z0-9_-]+$/.test(checksum)) {
    throw new SourceFetchError(`That iCloud ${kind} reference is invalid`, 400)
  }
}

/** Apple's known CDN host set for shared-album assets. A resolved host
 *  outside it — a spoofed asset map, a wrong partition — is refused; widen
 *  this only if a real album misses. */
const APPLE_ASSET_HOST = /(^|\.)(icloud\.com|icloud-content\.com|apple\.com|cdn-apple\.com|mzstatic\.com)$/i

/** A complete DNS hostname: dot-separated labels of valid characters only.
 *  The suffix allowlist alone cannot reject a host that is not parseable
 *  DNS at all. */
const DNS_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i

/** The single gate for asset-map locations: https only, a well-formed
 *  hostname, and inside the Apple CDN set. Everything else is refused
 *  before a URL is ever built. */
const assetLocationUrl = (location: { scheme?: string; hosts?: string[] } | undefined, path: string) => {
  const host = location?.hosts?.[0]
  if (location?.scheme !== 'https' || !host || !DNS_HOSTNAME.test(host) || !APPLE_ASSET_HOST.test(host)) return null
  return `https://${host}${path}`
}

/** Resolves a derivative's real CDN content type. Used only to break a
 *  tie the album metadata left ambiguous. The asset map is fetched once
 *  for all candidates; the url_path's own filename (.mp4 vs .JPG) answers
 *  most probes without touching the CDN, and when it can't, a HEAD is
 *  tried and then a 1-byte Range GET — some CDN vintages refuse HEAD
 *  outright (501) while happily serving ranged GETs. */
const probeDerivativeIsVideo = (token: string, photoGuid: string, fetchImpl: typeof fetch) => {
  let paths: Promise<Map<string, string>> | undefined
  const assetPaths = () => (paths ??= retryOnceOnTransient(() => postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl), PROBE_RETRY_WAIT_MS)
    .then((assets) => {
      const map = new Map<string, string>()
      for (const [checksum, item] of Object.entries(assets.items ?? {})) {
        const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
        if (item?.url_path) {
          const url = assetLocationUrl(location, item.url_path)
          if (url) map.set(checksum, url)
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
    let response = await request(fetchImpl, url, { method: 'HEAD' })
    if (response.status === 501 || response.status === 405) {
      response = await request(fetchImpl, url, { headers: { Range: 'bytes=0-0' } })
    }
    return /^video\//i.test(response.headers.get('Content-Type') ?? '')
  }
}

export const scanICloudAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<ICloudScan> => {
  // CloudKit shares are invisible to sharedstreams — same call surface,
  // completely different backend behind it.
  if (icloudLinkKind(input) === 'cloudkit') return scanICloudCloudKitAlbum(input, fetchImpl)
  const token = extractAlbumToken(input)
  if (!token) throw new Error('Use a public iCloud shared album link')
  // The listing itself gets the same single bounded retry the media proxies
  // carry — a transient 429 or 5xx under burst load must not fail the scan.
  // Parsing and validation stay outside the retry wrapper.
  const stream = await retryOnceOnTransient(() => postSharedstreams<StreamResponse>(token, 'webstream', { streamCtag: null }, fetchImpl))
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
        fidelity: 'display-derivative',
        thumbnailFidelity: 'display-derivative',
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
      fidelity: 'full-resolution-render',
      thumbnailFidelity: 'display-derivative',
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
 *  URLs carry an expiry, so they are held only for a short window — long
 *  enough that a video's burst of Range requests resolves once instead
 *  of stampeding the sharedstreams API into a 5xx, never long enough to
 *  outlive the URL. Resolved URLs are pointers, not bytes — nothing is
 *  persisted. Shared by the image and video proxies. */
const ASSET_URL_TTL_MS = 45_000
const assetUrlCache = new Map<string, { url: string; at: number; expiry?: number }>()
// A range burst misses the value cache for its first dozen requests, so the
// in-flight resolution is shared per asset — one webasseturls call, many
// waiters. Entries always settle out of this map.
const assetUrlInflight = new Map<string, Promise<string | null>>()

const resolveAssetUrl = async (token: string, photoGuid: string, checksum: string, fetchImpl: typeof fetch) => {
  // Only the production fetch caches — an injected fetchImpl is a test
  // seam that must observe every upstream call.
  const cacheable = fetchImpl === fetch
  const key = `${token} ${checksum}`
  if (cacheable) {
    const hit = assetUrlCache.get(key)
    if (hit) {
      const now = Date.now()
      // A cached URL is reused only while both clocks hold: the local TTL
      // and the asset's own url_expiry, whichever ends first.
      if (now - hit.at < ASSET_URL_TTL_MS && (hit.expiry === undefined || now < hit.expiry)) return hit.url
      assetUrlCache.delete(key)
    }
    const inflight = assetUrlInflight.get(key)
    if (inflight) return inflight
  }
  const resolve = (async () => {
    const assets = await postSharedstreams<AssetUrls>(token, 'webasseturls', { photoGuids: [photoGuid] }, fetchImpl)
    const item = assets.items?.[checksum]
    const location = item?.url_location ? assets.locations?.[item.url_location] : undefined
    if (!item?.url_path) return null
    const url = assetLocationUrl(location, item.url_path)
    if (!url || !cacheable) return url
    if (assetUrlCache.size > 500) {
      const now = Date.now()
      for (const [k, v] of assetUrlCache) if (now - v.at >= ASSET_URL_TTL_MS) assetUrlCache.delete(k)
    }
    // url_expiry is an ISO timestamp when Apple provides one; an unparseable
    // or absent value keeps the TTL-only behaviour.
    const expiry = item.url_expiry ? Date.parse(item.url_expiry) : NaN
    assetUrlCache.set(key, { url, at: Date.now(), ...(Number.isNaN(expiry) ? {} : { expiry }) })
    return url
  })()
  if (!cacheable) return resolve
  assetUrlInflight.set(key, resolve)
  try {
    return await resolve
  } finally {
    assetUrlInflight.delete(key)
  }
}

/** Drops a cached asset URL whose CDN fetch failed — the next resolve
 *  re-asks upstream instead of replaying a dead URL. The failed URL must
 *  still be the cached one: a concurrent resolver may already have
 *  refreshed the entry, and evicting that would undo its work. */
const evictAssetUrl = (token: string, checksum: string, url: string) => {
  const key = `${token} ${checksum}`
  if (assetUrlCache.get(key)?.url === url) assetUrlCache.delete(key)
}

/** A transient error carries the server's requested backoff so the retry
 *  can honour it; beyond the latency budget the request is not retried. */
const transientError = (what: string, response: Response) =>
  Object.assign(new SourceFetchError(`${what} (${response.status})`, response.status), {
    retryAfterMs: retryAfterMs(response.headers),
  })

/** Apple's sharedstreams endpoints and CDN occasionally answer a healthy
 *  request with a transient 429 or 5xx under burst load — a permanent miss
 *  is a 404, so transient statuses get exactly one retry, waiting the
 *  server's requested delay when it names one (jitter otherwise), rather
 *  than leaving a hole in the page. A rejection from fetch itself — the
 *  connection dying before a status ever arrived — retries on the same
 *  budget; parse and validation failures never do. */
const retryOnceOnTransient = async <T>(run: () => Promise<T>, maxWaitMs = MAX_RETRY_WAIT_MS): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    const status = error instanceof SourceFetchError ? error.status : undefined
    // Fetch-level rejections — DNS, reset, TLS — surface as TypeError and
    // get the same single retry, but only when they were thrown at the
    // fetchImpl boundary; a TypeError raised parsing or validating the
    // answer propagates, since re-asking cannot fix it.
    const transient = status !== undefined
      ? status === 429 || status >= 500
      : error instanceof TypeError && (error as { networkRejection?: boolean }).networkRejection === true
    if (!transient) throw error
    const requested = (error as { retryAfterMs?: number | null }).retryAfterMs
    if (requested != null && requested > maxWaitMs) throw error
    await new Promise((resolve) => setTimeout(resolve, requested ?? 300 + Math.random() * 300))
    return run()
  }
}

/** A rejection thrown by fetchImpl itself is marked — a TypeError raised
 *  while parsing or validating its answer is a bug in this module, not a
 *  dead connection, and retrying it would only repeat the bug. */
const request = async (fetchImpl: typeof fetch, ...args: Parameters<typeof fetch>) => {
  try {
    return await fetchImpl(...args)
  } catch (error) {
    if (error instanceof TypeError) {
      ;(error as { networkRejection?: boolean }).networkRejection = true
    }
    throw error
  }
}

/** Resolves a CDN URL for one derivative (shared short-TTL cache) and
 *  streams it. Asset URLs carry an expiry — see resolveAssetUrl. */
export const fetchICloudImage = async (token: string, photoGuid: string, checksum: string, fetchImpl: typeof fetch = fetch) => {
  validateProxyReference('image', token, photoGuid, checksum)
  return retryOnceOnTransient(async () => {
    const url = await resolveAssetUrl(token, photoGuid, checksum, fetchImpl)
    if (!url) throw new SourceFetchError('That iCloud image is unavailable', 404)
    const response = await request(fetchImpl, url)
    if (!response.ok) {
      evictAssetUrl(token, checksum, url)
      throw transientError('iCloud image fetch failed', response)
    }
    return response
  })
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
  validateProxyReference('video', token, photoGuid, checksum)
  return retryOnceOnTransient(async () => {
    const url = await resolveAssetUrl(token, photoGuid, checksum, fetchImpl)
    if (!url) throw new SourceFetchError('That iCloud video is unavailable', 404)
    const response = await request(fetchImpl, url, range ? { headers: { Range: range } } : undefined)
    // 206 is the expected answer to a Range request and `ok` is false for it.
    if (!response.ok && response.status !== 206) {
      evictAssetUrl(token, checksum, url)
      throw transientError('iCloud video fetch failed', response)
    }
    return response
  })
}

/* ── CloudKit shared albums (iOS/macOS 26 link format) ─────────────────────
 * photos.icloud.com/shared/album/{shortGUID} shares live in the owner's
 * CloudKit zone, exposed to anonymous readers through the public
 * records/resolve endpoint: it mints a short-lived access token and names
 * the partition host that owns the shared zone. Media then comes straight
 * from CloudKit Web Services — sharedstreams never hears about these
 * shares, which is why the legacy scanner cannot see the links at all. */

const CK_HOST = 'https://ckdatabasews.icloud.com'
const CK_CONTAINER = 'com.apple.photos.cloud'
// CloudKit Web Services reads these as telemetry rather than auth — any
// consistent build string is accepted.
const CK_BUILD = '2620BuildBeta48'
const CK_PARAMS = `clientBuildNumber=${CK_BUILD}&clientMasteringNumber=${CK_BUILD}`
// The index the Photos web app itself pages: one CPLMaster plus one
// CPLAsset row per item, ordered by the zone's own direction field.
const CK_RECORD_TYPE = 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted'
const CK_PAGE_SIZE = 200
const CK_MAX_PAGES = 50 // hard stop so a huge zone cannot page forever

type CkZoneID = { zoneName: string; ownerRecordName?: string; zoneType?: string }
type CkShare = { zoneID: CkZoneID; partition: string; authToken: string; title?: string }
type CkFieldValue = { value?: unknown; type?: string }
type CkRecord = { recordName?: string; recordType?: string; fields?: Record<string, CkFieldValue> }

const ckNumber = (field: CkFieldValue | undefined) =>
  typeof field?.value === 'number' && Number.isFinite(field.value) ? field.value : undefined
const ckString = (field: CkFieldValue | undefined) =>
  typeof field?.value === 'string' && field.value ? field.value : undefined

const ckPost = async <T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> => {
  const response = await request(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': PHOTOS_UA },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw transientError('iCloud could not read that shared album', response)
  return (await response.json()) as T
}

/** The anonymous resolve that turns a share GUID into a zone plus the
 *  access token its shared queries need. Also answers at proxy time —
 *  the same call refreshes the resolve when a download URL goes stale. */
const resolveCkShare = async (token: string, fetchImpl: typeof fetch): Promise<CkShare> => {
  const data = await ckPost<{
    results?: {
      zoneID?: CkZoneID
      anonymousPublicAccess?: { token?: string; databasePartition?: string }
      share?: { fields?: Record<string, CkFieldValue> }
    }[]
  }>(fetchImpl, `${CK_HOST}/database/1/${CK_CONTAINER}/production/public/records/resolve?${CK_PARAMS}`, {
    shortGUIDs: [{ value: token }],
  })
  const result = data.results?.[0]
  const zone = result?.zoneID
  const access = result?.anonymousPublicAccess
  if (!zone?.zoneName || !access?.token) throw new SourceFetchError('That iCloud album is not shared publicly', 404)
  // The resolve names the share's partition host. It should always be an
  // Apple host — a value outside that set is refused rather than trusted,
  // same policy as the legacy asset-map locations.
  const raw = (access.databasePartition ?? '').replace(/:443$/, '')
  let partition = CK_HOST
  try {
    const host = new URL(raw).hostname
    if (raw && APPLE_ASSET_HOST.test(host)) partition = raw
  } catch {
    // Unparseable partition hints fall back to the generic host.
  }
  const title = ckString(result?.share?.fields?.['cloudkit.title'])
  return { zoneID: zone, partition, authToken: access.token, ...(title ? { title } : {}) }
}

/** Media derivative fields on a CPLMaster: `res{Name}Res` holds the asset
 *  blob (with a signed downloadURL); siblings `res{Name}Width/Height`
 *  carry its pixels and `res{Name}FileSize` its bytes. `res*Vid*` fields
 *  are video transcodes, never still frames. */
const ckDerivativeFields = (fields: Record<string, CkFieldValue>) => {
  const out: { name: string; downloadURL: string; width?: number; height?: number; video: boolean }[] = []
  for (const [key, field] of Object.entries(fields)) {
    if (!key.startsWith('res') || !key.endsWith('Res')) continue
    const blob = field?.value
    const downloadURL = typeof blob === 'object' && blob !== null ? (blob as { downloadURL?: unknown }).downloadURL : undefined
    if (typeof downloadURL !== 'string' || !downloadURL) continue
    const stem = key.slice(0, -3)
    out.push({
      name: key,
      downloadURL,
      width: ckNumber(fields[`${stem}Width`]),
      height: ckNumber(fields[`${stem}Height`]),
      video: key.includes('Vid'),
    })
  }
  return out
}

const ckImageProxy = (token: string, record: string, resField: string) =>
  `/api/icloud/image?album=${encodeURIComponent(token)}&photo=${encodeURIComponent(record)}&c=${encodeURIComponent(resField)}&v=ck`
const ckVideoProxy = (token: string, record: string, resField: string) =>
  `/api/icloud/video?album=${encodeURIComponent(token)}&photo=${encodeURIComponent(record)}&c=${encodeURIComponent(resField)}&v=ck`

const CK_VIDEO_TYPE = /movie|video/i

const scanICloudCloudKitAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<ICloudScan> => {
  const token = extractAlbumToken(input)
  if (!token) throw new Error('Use a public iCloud shared album link')
  const share = await retryOnceOnTransient(() => resolveCkShare(token, fetchImpl))
  const zoneJson = { zoneName: share.zoneID.zoneName, ownerRecordName: share.zoneID.ownerRecordName, zoneType: share.zoneID.zoneType }
  const queryUrl = `${share.partition}/database/1/${CK_CONTAINER}/production/shared/records/query?${CK_PARAMS}&publicAccessAuthToken=${encodeURIComponent(share.authToken)}`

  const masters: CkRecord[] = []
  let marker: string | undefined
  let pages = 0
  do {
    const page = await retryOnceOnTransient(() => ckPost<{ records?: CkRecord[]; continuationMarker?: string }>(fetchImpl, queryUrl, {
      query: {
        recordType: CK_RECORD_TYPE,
        filterBy: [{ fieldName: 'direction', comparator: 'EQUALS', fieldValue: { value: 'DESCENDING', type: 'STRING' } }],
      },
      zoneID: zoneJson,
      resultsLimit: CK_PAGE_SIZE,
      ...(marker ? { continuationMarker: marker } : {}),
    }))
    masters.push(...(page.records ?? []).filter((record) => record.recordType === 'CPLMaster'))
    marker = page.continuationMarker || undefined
    pages += 1
  } while (marker && pages < CK_MAX_PAGES && masters.length < MAX_GALLERY_ITEMS)

  const found = masters
  const items: GalleryMediaItem[] = []
  let index = 0
  for (const master of found.slice(0, MAX_GALLERY_ITEMS)) {
    const recordName = master.recordName
    const fields = master.fields
    if (!recordName || !fields) continue
    const derivatives = ckDerivativeFields(fields)
    const stills = derivatives.filter((d) => !d.video)
    if (!stills.length) continue
    const position = index + 1
    const id = `icloud-${recordName.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || position}`
    const itemType = ckString(fields.itemType) ?? ''
    const originalWidth = ckNumber(fields.resOriginalWidth)
    const originalHeight = ckNumber(fields.resOriginalHeight)
    const pickArea = (list: typeof stills) =>
      list.reduce((best, d) => ((d.width ?? 0) * (d.height ?? 0) > (best.width ?? 0) * (best.height ?? 0) ? d : best))

    if (CK_VIDEO_TYPE.test(itemType)) {
      const videos = derivatives.filter((d) => d.video)
      const video = videos.length ? videos.reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a)) : stills.find((d) => d.name === 'resOriginalRes')
      // On a movie master resOriginalRes IS the clip, not a frame — the
      // poster comes from the JPEG renditions only. With none, the slide
      // could neither show a frame nor a strip thumb, so it is skipped
      // like a video the legacy split cannot resolve.
      const frames = stills.filter((d) => d.name !== 'resOriginalRes')
      const poster = pickArea(frames.length ? frames : stills)
      if (!video || !frames.length) continue
      const width = originalWidth ?? num(poster.width) ?? 16
      const height = originalHeight ?? num(poster.height) ?? 9
      const item: VideoItem = {
        type: 'video',
        id,
        ref: recordName,
        filename: `Video ${position}`,
        src: ckVideoProxy(token, recordName, video.name),
        mimeType: 'video/mp4',
        width,
        height,
        poster: { src: ckImageProxy(token, recordName, poster.name), width: num(poster.width) || width, height: num(poster.height) || height },
        alt: 'Video',
        c2pa: false,
        fidelity: video.name === 'resOriginalRes' ? 'original' : 'display-derivative',
        thumbnailFidelity: 'display-derivative',
        placeholder: placeholderFor(width, height),
        variants: [{ width: num(poster.width) || 256, src: ckImageProxy(token, recordName, poster.name), format: 'jpeg' }],
      }
      items.push(item)
      index += 1
      continue
    }

    // Original bytes when the viewer can display their format — HEIC goes
    // through the client decoder, browsers cover the rest of this list. A
    // TIFF or RAW original would render nothing, so the JPEG renditions win
    // when they exist; otherwise the largest-rendition fallback stands.
    const ORIGINAL_DISPLAYABLE = /jpe?g|png|webp|gif|hei[cf]/i
    const original = stills.find((d) => d.name === 'resOriginalRes')
    const renditions = stills.filter((d) => d.name !== 'resOriginalRes')
    const primary = original && ORIGINAL_DISPLAYABLE.test(itemType) ? original : pickArea(renditions.length ? renditions : stills)
    const thumb = stills.find((d) => d.name === 'resJPEGThumbRes') ?? stills.reduce((small, d) => ((d.width ?? Infinity) * (d.height ?? Infinity) < (small.width ?? Infinity) * (small.height ?? Infinity) ? d : small))
    const width = originalWidth ?? num(primary.width) ?? 4
    const height = originalHeight ?? num(primary.height) ?? 3
    items.push({
      id,
      ref: recordName,
      filename: primary === original && /hei[cf]/i.test(itemType) ? `Photo ${position}.heic` : `Photo ${position}`,
      src: ckImageProxy(token, recordName, primary.name),
      fidelity: primary === original ? 'original' : primary.name === 'resJPEGThumbRes' ? 'display-derivative' : 'full-resolution-render',
      thumbnailFidelity: 'display-derivative',
      width,
      height,
      alt: 'Photograph',
      c2pa: primary === original,
      placeholder: placeholderFor(width, height),
      variants: [{ width: num(thumb.width) || 256, src: ckImageProxy(token, recordName, thumb.name), format: 'jpeg' }],
    })
    index += 1
  }

  if (!items.length) throw new Error('No photos or videos were found in that public iCloud album')
  return {
    sourceUrl: canonicalICloudCloudKitUrl(token),
    title: share.title?.trim() || 'Shared album',
    images: items,
    ...(found.length > MAX_GALLERY_ITEMS ? { truncated: found.length } : {}),
  }
}

/** Share resolves are cheap and reused by every asset request, but the
 *  anonymous token inside expires — cache briefly, coalesce in-flight,
 *  and re-resolve on any auth-shaped failure. */
const CK_RESOLVE_TTL_MS = 45_000
const ckShareCache = new Map<string, { share: CkShare; at: number }>()
const ckShareInflight = new Map<string, Promise<CkShare>>()

const ckShareFor = (token: string, fetchImpl: typeof fetch) => {
  const cacheable = fetchImpl === fetch
  if (cacheable) {
    const hit = ckShareCache.get(token)
    if (hit && Date.now() - hit.at < CK_RESOLVE_TTL_MS) return Promise.resolve(hit.share)
    ckShareCache.delete(token)
    const inflight = ckShareInflight.get(token)
    if (inflight) return inflight
  }
  const resolve = resolveCkShare(token, fetchImpl)
  if (!cacheable) return resolve
  ckShareInflight.set(token, resolve)
  return resolve.then((share) => {
    ckShareCache.set(token, { share, at: Date.now() })
    return share
  }).finally(() => ckShareInflight.delete(token))
}

/** Looks up a single master in the shared zone and pulls the requested
 *  derivative's signed downloadURL. URLs are pointers, never persisted —
 *  a 45s cache absorbs a page-load's burst of image requests; anything
 *  longer risks serving a dead signature. */
const CK_URL_TTL_MS = 45_000
const ckUrlCache = new Map<string, { url: string; at: number }>()
const ckUrlInflight = new Map<string, Promise<string | null>>()

const resolveCkDerivativeUrl = async (token: string, recordName: string, resField: string, fetchImpl: typeof fetch, refresh = false): Promise<string | null> => {
  const cacheable = fetchImpl === fetch
  const key = `${token} ${recordName} ${resField}`
  if (cacheable && !refresh) {
    const hit = ckUrlCache.get(key)
    if (hit && Date.now() - hit.at < CK_URL_TTL_MS) return hit.url
    const inflight = ckUrlInflight.get(key)
    if (inflight) return inflight
  }
  const resolve = (async () => {
    let share = await ckShareFor(token, fetchImpl)
    const lookup = async () => {
      const url = `${share.partition}/database/1/${CK_CONTAINER}/production/shared/records/lookup?${CK_PARAMS}&publicAccessAuthToken=${encodeURIComponent(share.authToken)}`
      return ckPost<{ records?: CkRecord[] }>(fetchImpl, url, { records: [{ recordName }], zoneID: share.zoneID })
    }
    let data: { records?: CkRecord[] }
    try {
      data = await lookup()
    } catch (error) {
      // An expired anonymous token reads as auth failure, not 5xx — drop
      // the cached resolve and re-resolve once rather than failing.
      const status = error instanceof SourceFetchError ? error.status : 0
      if (status !== 401 && status !== 403 && status !== 421) throw error
      ckShareCache.delete(token)
      share = await ckShareFor(token, fetchImpl)
      data = await lookup()
    }
    const blob = data.records?.[0]?.fields?.[resField]?.value
    const downloadURL = typeof blob === 'object' && blob !== null ? (blob as { downloadURL?: unknown }).downloadURL : undefined
    if (typeof downloadURL !== 'string' || !downloadURL) return null
    try {
      if (!APPLE_ASSET_HOST.test(new URL(downloadURL).hostname)) return null
    } catch {
      return null
    }
    if (cacheable) ckUrlCache.set(key, { url: downloadURL, at: Date.now() })
    return downloadURL
  })()
  if (!cacheable) return resolve
  ckUrlInflight.set(key, resolve)
  try {
    return await resolve
  } finally {
    ckUrlInflight.delete(key)
  }
}

/** A CloudKit share reference is a record name plus a res* field — the
 *  same two-parameter shape as the legacy guid+checksum pair. Record
 *  names ride inside the lookup JSON body, never a URL path, so the
 *  base64 alphabet they actually use (+, /, =) is safe to accept. */
const validateCkReference = (kind: 'image' | 'video', token: string, recordName: string, resField: string) => {
  if (!isAlbumToken(token) || !/^[A-Za-z0-9_+\/=-]{1,128}$/.test(recordName) || !/^res[A-Za-z0-9]+Res$/.test(resField)) {
    throw new SourceFetchError(`That iCloud ${kind} reference is invalid`, 400)
  }
}

const evictCkUrl = (token: string, recordName: string, resField: string, url: string) => {
  const key = `${token} ${recordName} ${resField}`
  if (ckUrlCache.get(key)?.url === url) ckUrlCache.delete(key)
}

export const fetchICloudCkImage = async (token: string, recordName: string, resField: string, fetchImpl: typeof fetch = fetch) => {
  validateCkReference('image', token, recordName, resField)
  return retryOnceOnTransient(async () => {
    const url = await resolveCkDerivativeUrl(token, recordName, resField, fetchImpl)
    if (!url) throw new SourceFetchError('That iCloud image is unavailable', 404)
    const response = await request(fetchImpl, url)
    if (!response.ok) {
      evictCkUrl(token, recordName, resField, url)
      throw transientError('iCloud image fetch failed', response)
    }
    return response
  })
}

export const fetchICloudCkVideo = async (
  token: string,
  recordName: string,
  resField: string,
  range?: string | null,
  fetchImpl: typeof fetch = fetch,
) => {
  validateCkReference('video', token, recordName, resField)
  return retryOnceOnTransient(async () => {
    const url = await resolveCkDerivativeUrl(token, recordName, resField, fetchImpl)
    if (!url) throw new SourceFetchError('That iCloud video is unavailable', 404)
    const response = await request(fetchImpl, url, range ? { headers: { Range: range } } : undefined)
    if (!response.ok && response.status !== 206) {
      evictCkUrl(token, recordName, resField, url)
      throw transientError('iCloud video fetch failed', response)
    }
    return response
  })
}
