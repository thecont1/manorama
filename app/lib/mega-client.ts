import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage } from './imagesource'
import { keylessSourceUrl } from '../../packages/core/encrypted-source'
import { parseJpegDimensions, parseWebpDimensions, probeImageDimensions } from './image-dims'
import { b64Encode, b64uDecode, b64uEncode, cbcDecryptZeroIv, decryptTlvRecords, ecbDecrypt, foldKey, metaMacMatches } from './mega-crypto'
import { createScanBudget, ScanBudgetExhausted } from './scan-budget'
import { cbcDecryptClient, ctrDecryptClient, ctrDecryptMetaMacClient } from './mega-decrypt'

/**
 * Browser/native MEGA client. Share and per-node keys stay in this module's
 * in-memory session; published manifests contain only keyless references.
 * Upstream API and CDN requests carry ciphertext and public handles only.
 *
 *  - Folder listing: POST g.api.mega.co.nz/cs [{a:'f',c:1,ca:1,r:1}]
 *    with ?n={folder}. Returns encrypted node records.
 *  - Node `k` fields hold the per-node key, AES-ECB encrypted with the
 *    share key (or a parent folder key). Attributes `a` are AES-CBC
 *    (zero IV, zero padding) with the folded node key.
 *  - Downloads: {a:'g'} returns a CDN URL; content is AES-128-CTR with
 *    the file's folded key + 8-byte nonce, decrypted at proxy time.
 *
 * Caveats: undocumented API; the `k` key embedded in proxy URLs is
 * derived from the already-public share key; the file meta-MAC is
 * verified on whole-file retrieval (ranged reads fetch windows the
 * MAC cannot cover); free accounts hit MEGA bandwidth quotas (509)
 * which surface as temporary failures.
 */

// Accepted formats only: JPEG, WebP, AVIF, HEIC, HEIF. PNG, GIF, TIFF,
// video, and every other file type are consciously ignored at scan.
const IMAGE_EXTENSIONS = /\.(?:jpe?g|webp|avif|hei[cf])$/i
const API = 'https://g.api.mega.co.nz/cs'
// Enough head bytes to find a JPEG SOF marker past typical EXIF APP1.
const DIMS_PROBE_BYTES = 65536
// Whole-file proxy ceiling — the encrypted fetch buffer and the decrypted
// buffer coexist, so the cap must stay well under half the 128MB isolate limit.
const MAX_FILE_BYTES = 48 * 1024 * 1024
// File-attribute (preview/thumbnail) ceiling — these are decrypted into
// memory and cached, so an unbounded one would balloon the isolate.
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
// The shared 950-request default in scan-budget is the Workers subrequest
// ceiling; the client scan runs in a browser, which has none. Measured on
// a live share the probe pass costs ~2 requests per item (ufa+POST or
// g+range), so 3×MAX bounds the pass with headroom and stays a backstop
// against runaway fan-out rather than a platform limit.
const MEGA_SCAN_REQUEST_BUDGET = MAX_GALLERY_ITEMS * 3

type MegaNode = {
  h: string
  p: string
  t: number // 0 = file, 1 = folder
  a?: string // base64url encrypted attributes
  k?: string // "handle:encKey" alternatives joined by '/'
  s?: number
  fa?: string // "type*fahandle" entries, '/'-joined, first may carry a "cluster:" prefix
  ts?: number
}

type MegaElement = {
  id?: string // element handle
  s?: string // owning set handle
  h?: string // node handle
  k?: string // element key (= node file key), AES-CBC-encrypted with the set key
  o?: number // owner-set ordering
  ts?: number
}

type MegaNodeMeta = {
  h?: string
  s?: number // size
  at?: string // standard MEGA{...} attrs encrypted with the element key
  fa?: string
  ts?: number
}

type MegaSet = {
  id?: string
  at?: string // encrypted TLV attribute container
}

export type MegaScan = { sourceUrl: string; title: string; images: GalleryImage[]; truncated?: number }

export type MegaLink =
  | { kind: 'folder'; id: string; key: string }
  | { kind: 'collection'; id: string; key: string }

/** Public link spellings: mega.nz/folder/{id}#{key} and
 *  mega.nz/collection/{id}#{key}, plus the legacy #F! and #C!
 *  fragment forms. Optional /file/{id} tails are ignored. */
export const extractMegaLink = (input: string): MegaLink | null => {
  const url = new URL(input.trim())
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'mega.nz' && host !== 'mega.co.nz') return null
  const key = url.hash.replace(/^#/, '').split('/')[0] || ''
  const modern = url.pathname.match(/^\/(folder|collection)\/([0-9A-Za-z_-]+)/)
  if (modern) {
    return key ? { kind: modern[1] as 'folder' | 'collection', id: modern[2]!, key } : null
  }
  const legacy = url.hash.match(/^#([FC])!([0-9A-Za-z_-]+)[!#]([0-9A-Za-z_-]+)/)
  return legacy ? { kind: legacy[1] === 'C' ? 'collection' : 'folder', id: legacy[2]!, key: legacy[3]! } : null
}

export const extractMegaFolder = (input: string) => {
  const link = extractMegaLink(input)
  return link?.kind === 'folder' ? { folder: link.id, key: link.key } : null
}

export const canonicalMegaUrl = (link: MegaLink) =>
  `https://mega.nz/${link.kind === 'collection' ? 'collection' : 'folder'}/${link.id}#${link.key}`

/** API auth context: folders authorize via &n={handle}, public Sets
 *  via &s={publicSetHandle}. */
type MegaAuth = { n?: string; s?: string }
const linkAuth = (link: MegaLink): MegaAuth => link.kind === 'folder' ? { n: link.id } : { s: link.id }

/** MEGA answers API failures as bare negative numbers (-9 not found,
 *  -11 access denied, -18 link expired, -4/-17 rate limits). */
const megaRequest = async <T>(commands: Record<string, unknown>[], auth: MegaAuth, fetchImpl: typeof fetch): Promise<T> => {
  const url = `${API}?id=0${auth.n ? `&n=${encodeURIComponent(auth.n)}` : ''}${auth.s ? `&s=${encodeURIComponent(auth.s)}` : ''}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  })
  if (!response.ok) throw new SourceFetchError(`MEGA request failed (${response.status})`, response.status)
  const payload = await response.json() as unknown
  const head = Array.isArray(payload) ? payload[0] : payload
  if (typeof head === 'number' && head < 0) {
    if (head === -9 || head === -18) throw new SourceFetchError('That MEGA link was not found — check it is a public folder or collection link', 404)
    if (head === -11) throw new SourceFetchError('Manorama could not read that MEGA link — check it is a public folder or collection link', 403)
    if (head === -4 || head === -17) throw new SourceFetchError('MEGA is rate limiting requests — try again in a few minutes', 503)
    throw new SourceFetchError(`MEGA request failed (${head})`, 502)
  }
  return head as T
}

/** A node's `k` field lists `handle:encKey` alternatives joined by '/'.
 *  ECB gives no signal that an alternative was wrong — every ciphertext
 *  decrypts to a plausibly-sized key — so all candidates are returned and
 *  the MEGA{ attribute magic picks the real one. */
const decryptNodeKeys = (k: string | undefined, shareKey: Uint8Array) => {
  const keys: Uint8Array[] = []
  for (const part of (k ?? '').split('/')) {
    const enc = part.split(':').pop()
    if (!enc) continue
    try {
      const key = ecbDecrypt(shareKey, b64uDecode(enc))
      if (key.length === 16 || key.length === 32) keys.push(key)
    } catch {
      // Try the next alternative.
    }
  }
  return keys
}

/** Decrypts a node's `a` attribute blob; plaintext is "MEGA" + JSON +
 *  zero padding. Returns null when the key or blob is wrong. */
const decryptAttributes = (a: string | undefined, nodeKey: Uint8Array) => {
  if (!a) return null
  try {
    const plain = cbcDecryptZeroIv(foldKey(nodeKey), b64uDecode(a))
    let end = 0
    while (end < plain.length && plain[end]) end++
    const text = new TextDecoder().decode(plain.subarray(0, end))
    if (!text.startsWith('MEGA{"')) return null
    return JSON.parse(text.slice(4)) as { n?: string }
  } catch {
    return null
  }
}

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'

// Accepted formats browsers render natively; HEIC/HEIF decode client-side
// (libheif) from the same original bytes the file proxy already serves.
const BROWSER_RENDERABLE = /\.(?:jpe?g|webp|avif)$/i

/** Finds the file-attribute handle for a type (0 thumbnail, 1 preview)
 *  in a node's `fa` string ("{type}*{b64handle}" entries). */
const faHandle = (fa: string | undefined, type: number) => {
  if (!fa) return null
  for (const entry of fa.split('/')) {
    const match = entry.match(/(?:^|\/|:)(\d+)\*([0-9A-Za-z_-]+)/)
    if (match && Number(match[1]) === type) return match[2]!
  }
  return null
}

/** Resolves a node to its CDN URL and size. */
const downloadInfo = async (auth: MegaAuth, node: string, fetchImpl: typeof fetch) =>
  megaRequest<{ g?: string; s?: number }>([{ a: 'g', g: 1, ssl: 2, n: node }], auth, fetchImpl)

/** Media bytes only ever come from MEGA's download hosts. The `g`/`p`
 *  addresses in API responses are server-chosen strings — nothing else
 *  checks them before the client GETs/POSTs there, so a poisoned or
 *  compromised response must not be able to aim media fetches at an
 *  arbitrary origin. The family is reviewed in
 *  docs/manorama-operations.md (MEGA CDN allowlist). */
const MEGA_CDN_HOST = 'userstorage.mega.co.nz'
const assertMegaCdnUrl = (raw: string) => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SourceFetchError('That MEGA media address is invalid', 502)
  }
  const allowed = url.protocol === 'https:'
    && (url.hostname === MEGA_CDN_HOST || url.hostname.endsWith(`.${MEGA_CDN_HOST}`))
  if (!allowed) throw new SourceFetchError('That MEGA media address is not an allowed download host', 502)
  return url
}

/** Fetches a CDN URL with redirects under control: every hop — not just
 *  the first — must be an allowlisted host. `redirect: 'manual'` hides
 *  the target entirely in browsers (opaqueredirect), which fails closed;
 *  a Worker or test fetch can read Location and re-validate the hop. */
const CDN_REDIRECT_HOPS = 3
const fetchMegaCdn = async (raw: string, fetchImpl: typeof fetch, init?: RequestInit) => {
  let target = assertMegaCdnUrl(raw).toString()
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(target, { ...init, redirect: 'manual' })
    const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
    if (!redirected) return response
    const location = response.headers.get('location')
    if (!location || hop + 1 >= CDN_REDIRECT_HOPS) throw new SourceFetchError('That MEGA download redirected off its host', 502)
    try {
      target = assertMegaCdnUrl(new URL(location, target).toString()).toString()
    } catch {
      throw new SourceFetchError('That MEGA download redirected off its host', 502)
    }
  }
}

const fetchRange = async (g: string, start: number, end: number, fetchImpl: typeof fetch) => {
  const response = await fetchMegaCdn(`${g}/${start}-${end}`, fetchImpl)
  if (response.status === 509) throw new SourceFetchError('MEGA bandwidth limit reached — try again later', 503)
  if (!response.ok) throw new SourceFetchError(`MEGA download failed (${response.status})`, response.status)
  return new Uint8Array(await response.arrayBuffer())
}

const decryptContent = (bytes: Uint8Array, nodeKey: Uint8Array, offset = 0, signal?: AbortSignal) =>
  ctrDecryptClient(foldKey(nodeKey), nodeKey.subarray(16, 24), bytes, offset, signal)

/** WebP RIFF dims: VP8X (1+LE24 fields), lossy VP8 (14-bit LE after
 *  the 9d 012a start code), VP8L (packed 14-bit fields). */
const parsePreviewDimensions = (bytes: Uint8Array) => parseJpegDimensions(bytes) ?? parseWebpDimensions(bytes)

const sniffContentType = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp'
      : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : 'application/octet-stream'

/** Fetches + decrypts one file attribute (thumbnail/preview): ufa
 *  resolves the attribute URL, a POST of the raw 8-byte handle returns
 *  {handle:8}{len:4}{CBC-encrypted data} records. */
const fetchFileAttribute = async (auth: MegaAuth, fah: string, nodeKey: Uint8Array, fetchImpl: typeof fetch, signal?: AbortSignal) => {
  const handleBytes = b64uDecode(fah)
  if (handleBytes.length !== 8) return null
  const resolved = await megaRequest<{ p?: string }>([{ a: 'ufa', fah: b64Encode(handleBytes), ssl: 2, r: 1, v: 3 }], auth, fetchImpl)
  if (!resolved.p) return null
  const response = await fetchMegaCdn(resolved.p, fetchImpl, { method: 'POST', body: handleBytes })
  if (!response.ok) throw new SourceFetchError(`MEGA preview failed (${response.status})`, response.status)
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES + 12) {
    throw new SourceFetchError('That MEGA preview is too large to proxy', 413)
  }
  const buf = new Uint8Array(await response.arrayBuffer())
  let offset = 0
  while (offset + 12 <= buf.length) {
    const record = buf.subarray(offset, offset + 8)
    const length = new DataView(buf.buffer, buf.byteOffset + offset + 8, 4).getUint32(0, true)
    offset += 12
    if (length > MAX_PREVIEW_BYTES) throw new SourceFetchError('That MEGA preview is too large to proxy', 413)
    if (offset + length > buf.length) return null
    if (b64uEncode(record) === fah) {
      if (length % 16) return null
      return cbcDecryptClient(foldKey(nodeKey), buf.subarray(offset, offset + length), signal)
    }
    offset += length
  }
  return null
}

/** Best-effort dimensions: the decrypted JPEG preview when the node
 *  carries one (small, and works for HEIC/HEIF too), else a ranged
 *  head fetch of the original; anything else gets a 4:3 placeholder.
 *  Reported dims are the rendition's — aspect is what matters for
 *  layout, matching the Dropbox thumbnail-dims precedent. */
const probeDimensions = async (auth: MegaAuth, node: { h: string; fa?: string }, nodeKey: Uint8Array, name: string, fetchImpl: typeof fetch): Promise<{ width: number; height: number; previewFormat?: string }> => {
  // MEGA throttles bursty ufa/range traffic; one retry after a beat
  // recovers most probes, anything still failing falls back to 4:3.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const renderable = BROWSER_RENDERABLE.test(name)
      const fah = faHandle(node.fa, 1) ?? faHandle(node.fa, 0)
      // The preview is the dims source of choice for renderable files. For
      // HEIC/HEIF its dims describe a capped rendition — it still gets
      // fetched to warm the rail cache and to stand in as the fallback,
      // but the original's head is authoritative.
      let previewDims: { width: number; height: number } | null = null
      let previewFormat: string | undefined
      if (fah) {
        const preview = await fetchFileAttribute(auth, fah, nodeKey, fetchImpl)
        if (preview) {
          previewDims = parsePreviewDimensions(preview) ?? null
          previewFormat = sniffContentType(preview)
          if (renderable && previewDims) return { ...previewDims, previewFormat }
        }
      }
      const info = await downloadInfo(auth, node.h, fetchImpl)
      if (info.g) {
        const head = await fetchRange(info.g, 0, DIMS_PROBE_BYTES - 1, fetchImpl)
        const dimensions = probeImageDimensions(await decryptContent(head, nodeKey))
        if (dimensions) return { ...dimensions, previewFormat }
      }
      if (previewDims) return { ...previewDims, previewFormat }
    } catch (error) {
      // The budget stopping a probe is not a transient failure — let it
      // escape so the scan drops the tail instead of retrying it.
      if (error instanceof ScanBudgetExhausted) throw error
      // Dimensions are a nicety — never fail a scan over them.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return { width: 4, height: 3 }
}

/** Probes run in small batches — firing every preview/head fetch at once
 *  trips MEGA rate limits and lands whole galleries on 4:3 guesses. A
 *  budget-exhausted probe drops the file; the un-probed tail is reported
 *  via `truncated` rather than given an invented 4:3 geometry. */
const PROBE_BATCH = 6
const probeImages = async <F>(auth: MegaAuth, files: F[], fetchImpl: typeof fetch, build: (file: F, index: number) => { node: { h: string; fa?: string; s?: number; ts?: number }; nodeKey: Uint8Array; name: string }, closed?: () => boolean) => {
  const images: GalleryImage[] = []
  let exhausted = false
  for (let i = 0; i < files.length && !exhausted; i += PROBE_BATCH) {
    if (closed?.()) throw new Error('This MEGA session is closed')
    const batch = await Promise.all(files.slice(i, i + PROBE_BATCH).map(async (file, j) => {
      const { node, nodeKey, name } = build(file, i + j)
      try {
        const dims = await probeDimensions(auth, node, nodeKey, name, fetchImpl)
        return makeImage(auth, i + j, node, nodeKey, name, dims.width, dims.height, dims.previewFormat)
      } catch (error) {
        if (error instanceof ScanBudgetExhausted) {
          exhausted = true
          return null
        }
        throw error
      }
    }))
    images.push(...batch.filter((image): image is GalleryImage => image !== null))
  }
  // Only budget exhaustion is truncation — nothing is deliberately dropped.
  return { images, truncatedTail: exhausted }
}

const makeImage = async (auth: MegaAuth, index: number, node: { h: string; fa?: string; s?: number; ts?: number }, nodeKey: Uint8Array, name: string, width: number, height: number, previewFormat?: string): Promise<GalleryImage> => {
  const fah = faHandle(node.fa, 1) ?? faHandle(node.fa, 0)
  // Every item serves the original through the file proxy — the viewer
  // decodes HEIC/HEIF client-side, so a capped rendition is never the src.
  // The preview stays as the rail thumbnail when MEGA generated one;
  // without it the rail falls back to the (heavier) original.
  const identity = auth.n ? { sourceKind: 'folder' as const, sourceId: auth.n } : { sourceKind: 'collection' as const, sourceId: auth.s! }
  const versionInput = new TextEncoder().encode(JSON.stringify({ h: node.h, s: node.s ?? null, ts: node.ts ?? null, fa: node.fa ?? null }))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', versionInput))
  const contentVersion = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  versionInput.fill(0)
  return {
    id: `mega-${node.h.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
    ref: node.h,
    filename: name,
    src: '',
    media: { kind: 'encrypted', provider: 'mega', ...identity, nodeId: node.h, previewId: undefined },
    contentVersion,
    fidelity: 'original',
    thumbnailFidelity: 'display-derivative',
    // The JPEG/WebP preview doubles as the rail thumbnail: without a
    // variant, admin's `variants?.[0]?.src ?? src` falls back to the
    // multi-MB decrypted original per image. Declared width is the
    // rendition's and format is sniffed when the dims probe read this
    // preview (the common case), else best-effort.
    ...(fah ? { variants: [{ width, src: '', media: { kind: 'encrypted' as const, provider: 'mega' as const, ...identity, nodeId: node.h, previewId: fah }, format: previewFormat === 'image/webp' ? 'webp' : 'jpeg' }] } : {}),
    width,
    height,
    alt: filenameLabel(name),
    // CTR decryption happens at proxy time — bytes are the MEGA
    // originals, so embedded credentials survive.
    c2pa: true,
    placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
  }
}

type MegaFolderFile = { node: MegaNode; nodeKey: Uint8Array; name: string }
type MegaListed = { auth: MegaAuth; sourceUrl: string; title: string; foundTotal: number }

/** Folder phase one: link parse, `f` listing, per-node key unwrap and
 *  attribute decrypt. Everything a session needs to materialize — the
 *  keys map is full when this returns; the probe pass exists only to
 *  build manifest fields (dimensions, filenames, truncation count). */
const listMegaFolder = async (input: string, fetchImpl: typeof fetch, keys?: Map<string, Uint8Array>) => {
  const link = extractMegaLink(input)
  if (!link || link.kind !== 'folder') throw new Error('Use a public MEGA folder link')
  const auth = linkAuth(link)
  const shareKey = b64uDecode(link.key)
  if (shareKey.length !== 16 && shareKey.length !== 32) throw new Error('That MEGA link does not carry a usable key')
  const listing = await megaRequest<{ f?: MegaNode[] }>([{ a: 'f', c: 1, ca: 1, r: 1 }], auth, fetchImpl)
  const nodes = listing.f ?? []

  // The `f` response is already scoped to the shared subtree — take every
  // image file in it. Requiring `p === link.id` misses shares whose files
  // sit inside a subfolder (the link anchor itself is never listed).
  const found = nodes
    .filter((node) => node.t === 0 && node.a && node.k)
    .flatMap((node) => {
      // Trying every key alternative matters: files nested in subfolders
      // carry one per ancestor scope, and the first is not always valid.
      for (const nodeKey of decryptNodeKeys(node.k, shareKey)) {
        const attributes = decryptAttributes(node.a, nodeKey)
        const name = attributes?.n?.trim()
        if (name && IMAGE_EXTENSIONS.test(name)) {
          if (keys) keys.set(node.h, nodeKey)
          return [{ node, nodeKey, name }]
        }
      }
      return []
    })
  if (!found.length) throw new Error('No image files were found in that public MEGA folder')
  // Cap before probeImages — each file costs a decrypt-and-fetch probe
  // in batches of six, so an uncapped folder multiplies into minutes.
  const files = found.slice(0, MAX_GALLERY_ITEMS)

  // Folder title from the root node's own attributes when decryptable.
  const root = nodes.find((node) => node.h === link.id) ?? nodes.find((node) => node.t === 1)
  const title = (root
    ? [shareKey, ...decryptNodeKeys(root.k, shareKey)]
        .map((key) => decryptAttributes(root.a, key)?.n?.trim())
        .find(Boolean)
    : '') || 'Untitled gallery'

  return { auth, sourceUrl: keylessSourceUrl(canonicalMegaUrl(link)), title, files, foundTotal: found.length }
}

/** Folder phase two: the per-item probes. `closed` stops the pass between
 *  batches — a disposed session rejects its scan rather than finishing
 *  manifest fields nobody can still consume. */
const probeFolderScan = async (listed: MegaListed & { files: MegaFolderFile[] }, fetchImpl: typeof fetch, closed?: () => boolean): Promise<MegaScan> => {
  // A count-capped listing is a hard refusal, not a truncated scan — name
  // the limit instead of probing a thousand items to fail at submit.
  if (listed.foundTotal > MAX_GALLERY_ITEMS) {
    throw new SourceFetchError(`That MEGA folder has ${listed.foundTotal.toLocaleString()} images — galleries are limited to ${MAX_GALLERY_ITEMS.toLocaleString()} items`, 422)
  }
  const budgetFetch = createScanBudget(MEGA_SCAN_REQUEST_BUDGET).fetch(fetchImpl)
  const { images, truncatedTail } = await probeImages(listed.auth, listed.files, budgetFetch, ({ node, nodeKey, name }) => ({ node, nodeKey, name }), closed)
  if (!images.length) throw new Error('No image files were found in that public MEGA folder')
  return { sourceUrl: listed.sourceUrl, title: listed.title, images, ...(truncatedTail ? { truncated: listed.foundTotal } : {}) }
}

export const scanMegaFolder = async (input: string, fetchImpl: typeof fetch = fetch, keys?: Map<string, Uint8Array>): Promise<MegaScan> =>
  probeFolderScan(await listMegaFolder(input, fetchImpl, keys), fetchImpl)

/** Public collections ("Sets") use a different API surface than
 *  folders: a:'aft' with &s={publicSetHandle} returns the set, its
 *  elements, and node metadata. Element keys are AES-CBC-encrypted
 *  with the share key from the link fragment; node metadata attrs use
 *  the ordinary MEGA{...} format decrypted with the element key. */
type MegaCollectionFile = { element: MegaElement; elementKey: Uint8Array; meta: MegaNodeMeta | undefined; name: string }

const listMegaCollection = async (input: string, fetchImpl: typeof fetch, keys?: Map<string, Uint8Array>) => {
  const link = extractMegaLink(input)
  if (!link || link.kind !== 'collection') throw new Error('Use a public MEGA collection link')
  const auth = linkAuth(link)
  const setKey = b64uDecode(link.key)
  if (setKey.length !== 16) throw new Error('That MEGA link does not carry a usable key')
  const result = await megaRequest<{ s?: MegaSet[] | Record<string, MegaSet>; e?: MegaElement[]; n?: MegaNodeMeta[] }>(
    [{ a: 'aft', v: 2 }], auth, fetchImpl)
  // `s` is a bare set object for single-set fetches (tolerate arrays/maps).
  const sets: MegaSet[] = Array.isArray(result.s)
    ? result.s
    : result.s && typeof result.s === 'object' && ('id' in result.s || 'at' in result.s)
      ? [result.s as MegaSet]
      : Object.values(result.s ?? {})
  const elements = result.e ?? []
  const nodeMeta = new Map((result.n ?? []).flatMap((meta) => meta.h ? [[meta.h, meta]] : []))

  // Set title lives in the set's TLV attribute container ("n" record).
  let title = 'Untitled gallery'
  const setAttrs = sets[0]?.at ? await decryptTlvRecords(setKey, b64uDecode(sets[0].at)) : null
  const setName = setAttrs?.get('n')
  if (setName) title = new TextDecoder().decode(setName).trim() || title

  const found = elements.flatMap((element) => {
    if (!element.h || !element.k) return []
    let elementKey: Uint8Array
    try {
      elementKey = cbcDecryptZeroIv(setKey, b64uDecode(element.k))
    } catch {
      return []
    }
    const meta = nodeMeta.get(element.h)
    const name = meta ? decryptAttributes(meta.at, elementKey)?.n?.trim() : null
    if (!name || !IMAGE_EXTENSIONS.test(name)) return []
    if (keys && element.h) keys.set(element.h, elementKey)
    return [{ element, elementKey, meta, name }]
  })
  if (!found.length) throw new Error('No image files were found in that public MEGA collection')

  found.sort((a, b) => (a.element.o ?? 0) - (b.element.o ?? 0))
  const files = found.slice(0, MAX_GALLERY_ITEMS)
  return { auth, sourceUrl: keylessSourceUrl(canonicalMegaUrl(link)), title, files, foundTotal: found.length }
}

const probeCollectionScan = async (listed: MegaListed & { files: MegaCollectionFile[] }, fetchImpl: typeof fetch, closed?: () => boolean): Promise<MegaScan> => {
  if (listed.foundTotal > MAX_GALLERY_ITEMS) {
    throw new SourceFetchError(`That MEGA collection has ${listed.foundTotal.toLocaleString()} images — galleries are limited to ${MAX_GALLERY_ITEMS.toLocaleString()} items`, 422)
  }
  const budgetFetch = createScanBudget(MEGA_SCAN_REQUEST_BUDGET).fetch(fetchImpl)
  const { images, truncatedTail } = await probeImages(listed.auth, listed.files, budgetFetch, ({ element, elementKey, meta, name }) => ({
    node: { h: element.h!, fa: meta?.fa, s: meta?.s, ts: meta?.ts ?? element.ts },
    nodeKey: elementKey,
    name,
  }), closed)
  if (!images.length) throw new Error('No image files were found in that public MEGA collection')
  return { sourceUrl: listed.sourceUrl, title: listed.title, images, ...(truncatedTail ? { truncated: listed.foundTotal } : {}) }
}

export const scanMegaCollection = async (input: string, fetchImpl: typeof fetch = fetch, keys?: Map<string, Uint8Array>): Promise<MegaScan> =>
  probeCollectionScan(await listMegaCollection(input, fetchImpl, keys), fetchImpl)

export const scanMegaSource = (input: string, fetchImpl: typeof fetch = fetch) => {
  const link = extractMegaLink(input)
  if (link?.kind === 'collection') return scanMegaCollection(input, fetchImpl)
  return scanMegaFolder(input, fetchImpl)
}

const megaAuthFromParams = (folder: string | undefined, set: string | undefined): MegaAuth =>
  set ? { s: set } : { n: folder }

/** A single `bytes=` range resolved against the file size. Multi-range and
 *  unparsable headers return null (ignored — the whole file is served);
 *  'unsatisfiable' marks a well-formed range outside the file. */
const parseByteRange = (header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null => {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    // Suffix form: the last N bytes.
    const length = Number(match[2])
    if (!Number.isSafeInteger(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

export const fetchMegaFile = async (folder: string | undefined, set: string | undefined, node: string, keyB64: string, fetchImpl: typeof fetch = fetch, range?: string | null, signal?: AbortSignal) => {
  const nodeKey = b64uDecode(keyB64)
  // A file key is 16 key ∥ 8 nonce ∥ 8 mac bytes; a shorter key decrypts
  // with an empty nonce and answers 200 with garbage instead of a 400.
  if (nodeKey.length !== 32) throw new SourceFetchError('That MEGA image reference is invalid', 400)
  const info = await downloadInfo(megaAuthFromParams(folder, set), node, fetchImpl)
  if (!info.g) throw new SourceFetchError('That MEGA image is unavailable', 404)
  const size = info.s ?? 0
  if (size === 0) throw new SourceFetchError('That MEGA image is unavailable', 404)
  if (size > MAX_FILE_BYTES) throw new SourceFetchError('That MEGA image is too large to proxy', 413)
  const wanted = parseByteRange(range, size)
  if (wanted === 'unsatisfiable') throw new SourceFetchError('That range is unsatisfiable', 416)
  if (wanted) {
    // CTR keystream is block-indexed: the fetch window must start on a
    // 16-byte boundary so the counter stays aligned, then the lead bytes
    // the caller did not ask for are sliced off.
    const alignedStart = wanted.start - (wanted.start % 16)
    const bytes = await fetchRange(info.g, alignedStart, wanted.end, fetchImpl)
    const plain = (await decryptContent(bytes, nodeKey, alignedStart, signal)).subarray(wanted.start - alignedStart)
    return new Response(plain as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${wanted.start}-${wanted.end}/${size}`,
        'Content-Length': String(wanted.end - wanted.start + 1),
        'Accept-Ranges': 'bytes',
      },
    })
  }
  const bytes = await fetchRange(info.g, 0, size - 1, fetchImpl)
  // Whole-file fetch verifies the uploader's meta-MAC before bytes are
  // served; a ranged read skips it — chunk MACs chain across the file.
  const { plain, mac } = await ctrDecryptMetaMacClient(foldKey(nodeKey), nodeKey.subarray(16, 24), bytes, signal)
  if (!metaMacMatches(mac, nodeKey)) throw new SourceFetchError('That MEGA file failed its integrity check', 502)
  return new Response(plain as unknown as BodyInit, { status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(plain.length) } })
}

/** Serves a decrypted JPEG preview/thumbnail for files whose originals
 *  browsers can't render (HEIC, HEIF). */
export const fetchMegaPreview = async (folder: string | undefined, set: string | undefined, fah: string, keyB64: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal) => {
  const nodeKey = b64uDecode(keyB64)
  // Previews are CBC attribute records keyed by foldKey alone, so both the
  // 16-byte element key and the 32-byte file key are legitimate.
  if (nodeKey.length !== 16 && nodeKey.length !== 32) throw new SourceFetchError('That MEGA image reference is invalid', 400)
  const preview = await fetchFileAttribute(megaAuthFromParams(folder, set), fah, nodeKey, fetchImpl, signal)
  if (!preview) throw new SourceFetchError('That MEGA image preview is unavailable', 404)
  return new Response(preview as unknown as BodyInit, { status: 200, headers: { 'Content-Type': sniffContentType(preview) } })
}

export type MegaClientSession = {
  sourceUrl: string
  /** The probe pass, still running when open returns. A viewer's
   *  materialize works off the listed keys immediately — only manifest
   *  submitters wait on `scan`. */
  scan: Promise<MegaScan>
  materialize(nodeId: string, previewId?: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>
  dispose(): void
}

/** Re-listing unwraps per-node keys into a closure. The listing is the
 *  only awaited phase: probes that build manifest fields keep running in
 *  the background as `scan`, so a viewer reaches first media off the
 *  listing alone. Only `scan` output is eligible for manifest submission;
 *  the key map never appears in JSON or URLs. */
export const openMegaSession = async (input: string, fetchImpl: typeof fetch = fetch): Promise<MegaClientSession> => {
  const link = extractMegaLink(input)
  if (!link) throw new Error('Use a complete public MEGA folder or collection link')
  const keys = new Map<string, Uint8Array>()
  let disposed = false
  const closed = () => disposed
  let listed: MegaListed
  let scan: Promise<MegaScan>
  if (link.kind === 'collection') {
    const collection = await listMegaCollection(input, fetchImpl, keys)
    listed = collection
    scan = probeCollectionScan(collection, fetchImpl, closed)
  } else {
    const folder = await listMegaFolder(input, fetchImpl, keys)
    listed = folder
    scan = probeFolderScan(folder, fetchImpl, closed)
  }
  const auth = linkAuth(link)
  return {
    sourceUrl: listed.sourceUrl,
    scan,
    async materialize(nodeId, previewId, signal) {
      if (disposed) throw new Error('This MEGA session is closed')
      const nodeKey = keys.get(nodeId)
      if (!nodeKey) throw new Error('This media reference is not present in the opened MEGA share')
      const signalFetch = ((url: RequestInfo | URL, init?: RequestInit) => fetchImpl(url, { ...init, signal })) as typeof fetch
      const response = previewId
        ? await fetchMegaPreview(auth.n, auth.s, previewId, b64uEncode(nodeKey), signalFetch, signal)
        : await fetchMegaFile(auth.n, auth.s, nodeId, b64uEncode(nodeKey), signalFetch, null, signal)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { bytes, mimeType: response.headers.get('Content-Type')?.split(';', 1)[0] || sniffContentType(bytes) }
    },
    dispose() {
      disposed = true
      for (const key of keys.values()) key.fill(0)
      keys.clear()
    },
  }
}
