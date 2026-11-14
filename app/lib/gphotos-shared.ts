import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage, type GalleryMediaItem } from './imagesource'
import { MAX_RETRY_WAIT_MS, retryAfterMs } from './transient-retry'

/**
 * Google Photos public shared-album scanning via the share page's embedded
 * AF_initDataCallback blocks and the same internal `batchexecute` RPC
 * (snAcKc) the Photos web app itself uses to page through large albums.
 * No credentials — the share link's album id and ?key= are the access token.
 *
 * Same risk class as the iCloud sharedstreams scanner: undocumented, and
 * Google can change the shapes without notice. Scan failures surface as
 * friendly errors. Videos in shared albums are out of scope for v1 — items
 * that carry video renditions are skipped rather than treated as photos.
 */

// A desktop UA keeps Google on the web share-page path; Photos answers other
// profiles with a bare app-promo interstitial that carries no album data.
const PAGE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const BATCH_URL = 'https://photos.google.com/_/PhotosUi/data/batchexecute'
const RPC_ID = 'snAcKc'

// Pages carry ~300 items each, so the MAX_GALLERY_ITEMS loop condition binds
// long before this does — it exists only to stop a runaway next-token chain.
const MAX_PAGES = 20

// Album ids and app.goo.gl short tokens are urlsafe slugs; the minimum length
// keeps quick-add from claiming trivial paths like /share/abc as a share.
const TOKEN_ID = /^[A-Za-z0-9_-]{8,}$/

// Continuation tokens look like AH_<40+ urlsafe chars> and are also embedded
// deeper in payloads; the last one in a page payload is the freshest.
const AH_TOKEN = /AH_[A-Za-z0-9_-]{40,}/g

// Rendition params that mark an item as carrying video, not a still photo.
// Google serves video as =m18/=m22/=m28/=m37 or =dv/=vv suffixes on the media
// key — the item also keeps a photo-shaped base URL that renders the poster
// frame, so the marker has to be checked across the whole item subtree.
const VIDEO_RENDITION = /=(?:m18|m22|m28|m37|dv|vv)(?:\?.*)?$/
const VIDEO_HOST = /googlevideo|videoplayback/i

// Renditions the image proxy may request from lh3: width-bound and
// height-bound scaling only — never crops (safety against wrong reported
// dimensions) and never downloads (=d) or videos (=m18/=dv).
const ALLOWED_RENDITION = /^(?:w\d{1,5}|h\d{1,5})$/
const MAX_RENDITION_DIM = 16384

export type GPhotosScan = {
  sourceUrl: string
  title: string
  images: GalleryMediaItem[]
  /** Item count over MAX_GALLERY_ITEMS that was dropped, if any. */
  truncated?: number
}

export const canonicalGPhotosUrl = (albumId: string, key?: string | null) =>
  `https://photos.google.com/share/${albumId}${key ? `?key=${encodeURIComponent(key)}` : ''}`

export type GPhotosShare =
  | { kind: 'share'; albumId: string; key: string | null }
  | { kind: 'short'; token: string }

/** Parse a Google Photos share or photos.app.goo.gl short link into its
 *  parts. Short links carry no checkable shape beyond the token — their real
 *  album id only resolves when the share page answers. */
export const extractGPhotosShare = (input: string): GPhotosShare | null => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'photos.app.goo.gl') {
    const token = /^\/([A-Za-z0-9_-]{8,})/.exec(url.pathname)?.[1]
    return token ? { kind: 'short', token } : null
  }
  if (host === 'photos.google.com') {
    // /share/{albumId} — also accepts the /share/{id}/photo/{itemId} variant,
    // which still names the same album.
    const albumId = /^\/share\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1]
    if (!albumId || !TOKEN_ID.test(albumId)) return null
    return { kind: 'share', albumId, key: url.searchParams.get('key') }
  }
  return null
}

/** Whether a URL looks like a public Google Photos shared-album link — used
 *  by quick-add to claim links before paying a scanner call. */
export const gphotosIsShareResource = (url: URL) =>
  extractGPhotosShare(url.href) !== null

/** The share's stable identity: the album id. The ?key= is access, not
 *  identity — a rotated or keyless link still names the same album. Short
 *  links have no extractable identity and return null. */
export const gphotosAlbumIdOf = (input: string): string | null => {
  const share = extractGPhotosShare(input)
  return share?.kind === 'share' ? share.albumId : null
}

/** A media item node: [uid, [baseUrl, width, height, ...], ...rest]. The uid
 *  is an AF1Qip…-prefixed media key; baseUrl is the lh3 rendition base.
 *  Matched by shape rather than position because the surrounding payload
 *  layout drifts between Photos vintages. */
const isMediaItem = (node: unknown): node is [string, [string, number, number, ...unknown[]], ...unknown[]] =>
  Array.isArray(node) && node.length >= 2 &&
  typeof node[0] === 'string' && node[0].startsWith('AF1Qip') &&
  Array.isArray(node[1]) && node[1].length >= 3 &&
  typeof node[1][0] === 'string' && node[1][0].startsWith('http') &&
  typeof node[1][1] === 'number' && typeof node[1][2] === 'number'

type MediaItemNode = [string, [string, number, number, ...unknown[]], ...unknown[]]

/** Depth-first collect of media-item nodes anywhere in a decoded payload.
 *  Photos nests the item list under different indices across page variants;
 *  the node shape is the stable part. Album details (cover, owner avatar)
 *  never carry the [AF1Qip…, [http…, w, h]] shape. */
const walkItems = (node: unknown, out: MediaItemNode[]) => {
  if (!Array.isArray(node)) return
  if (isMediaItem(node)) {
    out.push(node)
    return
  }
  for (const child of node) walkItems(child, out)
}

/** Bounded recursive check for video markers inside an item subtree. */
const hasVideoMarker = (node: unknown, depth = 0): boolean => {
  if (depth > 8) return false
  if (typeof node === 'string') return VIDEO_RENDITION.test(node) || VIDEO_HOST.test(node)
  if (Array.isArray(node)) return node.some((child) => hasVideoMarker(child, depth + 1))
  if (typeof node === 'object' && node !== null) return Object.values(node).some((child) => hasVideoMarker(child, depth + 1))
  return false
}

const lastAhToken = (text: string): string | null => {
  AH_TOKEN.lastIndex = 0
  let token: string | null = null
  for (const match of text.matchAll(AH_TOKEN)) token = match[0]
  return token
}

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

/** A transient error carries the server's requested backoff so the retry
 *  can honour it; beyond the latency budget the request is not retried. */
const transientError = (what: string, response: Response) =>
  Object.assign(new SourceFetchError(`${what} (${response.status})`, response.status), {
    retryAfterMs: retryAfterMs(response.headers),
  })

/** Transient statuses and dead sockets get exactly one retry, waiting the
 *  server's requested delay when it names one (jitter otherwise), rather
 *  than leaving a hole in the album. Parse and validation failures never
 *  retry — re-asking cannot fix them. */
const retryOnceOnTransient = async <T>(run: () => Promise<T>, maxWaitMs = MAX_RETRY_WAIT_MS): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    const status = error instanceof SourceFetchError ? error.status : undefined
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

/** Extract every `data:` literal from AF_initDataCallback blocks, walking
 *  balanced brackets so nested arrays inside the literal don't end the slice
 *  early. Returns [key, parsed-data] pairs for blocks that decode as arrays. */
const initDataBlocks = (html: string): [string, unknown[]][] => {
  const blocks: [string, unknown[]][] = []
  const re = /AF_initDataCallback\s*\(\s*\{[^}]*?key\s*:\s*['"](ds:\d+)['"]/g
  for (const match of html.matchAll(re)) {
    const dataAt = /data\s*:/.exec(html.slice(match.index, match.index + 5000))
    if (!dataAt) continue
    const start = match.index + dataAt.index + dataAt[0].length
    const open = html.indexOf('[', start)
    if (open < 0 || open > start + 200) continue
    let depth = 0
    let end = -1
    let inString: string | null = null
    for (let i = open; i < html.length; i++) {
      const ch = html[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === inString) inString = null
        continue
      }
      if (ch === '"' || ch === "'") { inString = ch; continue }
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }
    if (end < 0) continue
    try {
      const data = JSON.parse(html.slice(open, end))
      if (Array.isArray(data)) blocks.push([match[1], data])
    } catch {
      // Unparseable block — other ds:* blocks may still carry the album.
    }
  }
  return blocks
}

type SharePage = { items: MediaItemNode[]; token: string | null; title?: string; albumFound: boolean }

/** The album block's details slot: data[3] opens with the AF1Qip album id,
 *  which marks the block as the album payload even when the item list is
 *  empty — the difference between "empty album" and "page we cannot read". */
const looksAlbum = (data: unknown[]) =>
  Array.isArray(data[3]) && typeof data[3][0] === 'string' && data[3][0].startsWith('AF1Qip')

/** Parse the share page HTML: pick the AF_initDataCallback block carrying the
 *  item list (an empty-album block still qualifies through its details slot),
 *  then read the continuation token and album title from their positional
 *  slots with the AH_ regex as the token fallback. */
export const parseSharePage = (html: string): SharePage => {
  let best: { data: unknown[]; items: MediaItemNode[] } | null = null
  for (const [, data] of initDataBlocks(html)) {
    const items: MediaItemNode[] = []
    walkItems(data, items)
    if (items.length > (best?.items.length ?? 0) || (!best && looksAlbum(data))) best = { data, items }
  }
  if (!best) return { items: [], token: null, albumFound: false }

  const details = Array.isArray(best.data[3]) ? best.data[3] : undefined
  const title = typeof details?.[1] === 'string' && details[1].trim() ? details[1].trim() : undefined
  const token = typeof best.data[2] === 'string' && best.data[2]
    ? best.data[2]
    : lastAhToken(html)
  return { items: best.items, token, title, albumFound: true }
}

/** Decode a batchexecute response: skip the )]}' anti-XSSI line, find the
 *  wrb.fr/snAcKc entry, unwrap its JSON-encoded payload string. Returns
 *  [inner payload, raw payload string] or nulls when no entry answers. */
const batchPayload = (text: string): { inner: unknown[]; raw: string } | null => {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    let envelope: unknown
    try {
      envelope = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!Array.isArray(envelope)) continue
    for (const entry of envelope) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== RPC_ID) continue
      if (typeof entry[2] !== 'string' || !entry[2]) return null
      try {
        const inner = JSON.parse(entry[2])
        return Array.isArray(inner) ? { inner, raw: entry[2] } : null
      } catch {
        return null
      }
    }
  }
  return null
}

const fetchAlbumPage = async (
  albumId: string,
  key: string | null,
  token: string,
  referer: string,
  fetchImpl: typeof fetch,
): Promise<{ inner: unknown[]; raw: string }> => {
  const args = JSON.stringify([albumId, token, null, key])
  const fReq = JSON.stringify([[[RPC_ID, args, null, 'generic']]])
  const response = await request(fetchImpl, `${BATCH_URL}?rpcids=${RPC_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: 'https://photos.google.com',
      Referer: referer,
      'User-Agent': PAGE_UA,
    },
    body: `f.req=${encodeURIComponent(fReq)}`,
  })
  if (!response.ok) throw transientError('Manorama could not read that Google Photos album', response)
  const payload = batchPayload(await response.text())
  if (!payload) {
    // An absent or null payload is the transient shape Google answers when a
    // page fetch is retried server-side — worth one retry, fatal after.
    throw new SourceFetchError('Manorama could not read that Google Photos album — the album page answered in a shape we could not read', 502)
  }
  return payload
}

const stripGoogleTitle = (title: string) =>
  title.replace(/\s*[-–—]\s*Google Photos\s*$/i, '').trim()

const pageTitleFallback = (html: string): string | undefined => {
  const og = /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i.exec(html)
  if (og?.[1]) return stripGoogleTitle(og[1]) || undefined
  const tag = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  if (tag?.[1]) return stripGoogleTitle(tag[1]) || undefined
  return undefined
}

const placeholderFor = (width: number, height: number) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}"><rect width="100%" height="100%" fill="#141414"/></svg>`,
  )}`

const imageProxy = (baseUrl: string, rendition: string) =>
  `/api/gphotos/image?u=${encodeURIComponent(baseUrl)}&r=${rendition}`

export const scanGPhotosAlbum = async (input: string, fetchImpl: typeof fetch = fetch): Promise<GPhotosScan> => {
  const share = extractGPhotosShare(input)
  if (!share) throw new Error('Use a public Google Photos shared album link')

  // ?_imcp=1 keeps Google on the share-page path — without it short links
  // answer a mobile-app interstitial instead of the album page.
  const pageUrl = share.kind === 'short' ? `https://photos.app.goo.gl/${share.token}` : input.trim()
  const fetchUrl = new URL(pageUrl)
  if (!fetchUrl.searchParams.has('_imcp')) fetchUrl.searchParams.set('_imcp', '1')

  const page = await retryOnceOnTransient(async () => {
    const response = await request(fetchImpl, fetchUrl.href, {
      headers: { 'User-Agent': PAGE_UA, 'Accept-Language': 'en' },
    })
    if (!response.ok) throw transientError('Manorama could not read that Google Photos album', response)
    return response
  })
  const html = await page.text()

  // The real album id + key come from the URL the page landed on after
  // redirects (short links resolve there); fall back to the canonical link,
  // then to whatever a share-form input already carried.
  const resolved = (() => {
    // Google's own markup emits <link href=… rel="canonical">, so match
    // the attribute order both ways.
    const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1]
      ?? /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html)?.[1]
    for (const candidate of [page.url, canonical ?? '', input]) {
      const found = candidate ? extractGPhotosShare(candidate) : null
      if (found?.kind === 'share') return found
    }
    return share.kind === 'share' ? share : null
  })()
  if (!resolved) throw new Error('Manorama could not read that Google Photos album — check that it is shared with "Anyone with the link"')

  const first = parseSharePage(html)
  const rawItems = [...first.items]
  let token = first.token
  const seenTokens = new Set<string>()
  let pages = 0
  while (token && !seenTokens.has(token) && rawItems.length < MAX_GALLERY_ITEMS && pages < MAX_PAGES) {
    seenTokens.add(token)
    const { inner, raw } = await retryOnceOnTransient(() =>
      fetchAlbumPage(resolved.albumId, resolved.key, token!, canonicalGPhotosUrl(resolved.albumId, resolved.key), fetchImpl))
    walkItems(inner, rawItems)
    const positional = inner[2]
    token = (typeof positional === 'string' && positional) || lastAhToken(raw)
    pages += 1
  }

  const seen = new Set<string>()
  const found = rawItems.filter((item) => (seen.has(item[0]) ? false : (seen.add(item[0]), true)))
  const photoItems = found.filter((item) => !hasVideoMarker(item))
  if (found.length === 0) {
    throw new Error(first.albumFound
      ? 'No photos or videos were found in that public Google Photos album'
      : 'Manorama could not read that Google Photos album — check that it is shared with "Anyone with the link"')
  }
  if (photoItems.length === 0) {
    throw new Error('That Google Photos album only contains videos — Google Photos videos are not supported yet')
  }

  const entries = photoItems.slice(0, MAX_GALLERY_ITEMS)
  const images: GalleryImage[] = entries.flatMap((item, position) => {
    const [uid, rendition] = item
    const [baseUrl, width, height] = rendition
    // Only lh3 references can pass through the image proxy — anything else in
    // the item is dropped rather than sent to an unproxyable host.
    let host: string
    try {
      host = new URL(baseUrl).hostname
    } catch {
      return []
    }
    if (host !== 'lh3.googleusercontent.com') return []
    const cleanBase = baseUrl.replace(/=[^/]*$/, '')
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const thumb = Math.min(256, h)
    return [{
      id: `gphotos-${uid.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || position}`,
      ref: uid,
      filename: `Photo ${position + 1}`,
      src: imageProxy(cleanBase, `w${w}`),
      width: w,
      height: h,
      alt: `Photo ${position + 1}`,
      c2pa: false,
      fidelity: 'full-resolution-render' as const,
      thumbnailFidelity: 'display-derivative' as const,
      placeholder: placeholderFor(w, h),
      // Height-bound rendition, never upscaled — h{256} on a shorter side
      // would exceed intrinsic pixels, so the bound clamps to h.
      variants: [{ width: Math.max(1, Math.round(w * thumb / h)), src: imageProxy(cleanBase, `h${thumb}`), format: 'jpeg' }],
    }]
  })
  if (images.length === 0) throw new Error('Manorama could not read that Google Photos album — no usable image references were found at that link')

  return {
    sourceUrl: canonicalGPhotosUrl(resolved.albumId, resolved.key),
    title: first.title ?? pageTitleFallback(html) ?? 'Shared album',
    images,
    truncated: photoItems.length > MAX_GALLERY_ITEMS ? photoItems.length : undefined,
  }
}

/** Fetch an lh3 rendition for the proxy. `u` must be an lh3.googleusercontent
 *  URL — the share page itself emits them, and the check keeps the route from
 *  becoming an open fetcher. `r` is a whitelisted rendition shape. */
export const fetchGPhotosImage = async (u: string, rendition: string, fetchImpl: typeof fetch = fetch) => {
  let url: URL
  try {
    url = new URL(u)
  } catch {
    throw new SourceFetchError('That Google Photos image reference is invalid', 400)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'lh3.googleusercontent.com' || url.username || url.password) {
    throw new SourceFetchError('That Google Photos image reference is invalid', 400)
  }
  const dim = /^(?:w|h)(\d{1,5})$/.exec(rendition)
  if (!dim || !ALLOWED_RENDITION.test(rendition) || Number(dim[1]) > MAX_RENDITION_DIM || Number(dim[1]) === 0) {
    throw new SourceFetchError('That Google Photos rendition is not supported', 400)
  }
  url.search = ''
  url.hash = ''
  const target = `${url.href.replace(/=[^/]*$/, '')}=${rendition}`
  return retryOnceOnTransient(async () => {
    const response = await request(fetchImpl, target)
    if (!response.ok) throw transientError('Google Photos image fetch failed', response)
    return response
  })
}
