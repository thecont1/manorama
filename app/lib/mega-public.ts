import { SourceFetchError, type GalleryImage } from './imagesource'
import { parseJpegDimensions } from './dropbox-public'
import { b64Encode, b64uDecode, b64uEncode, cbcDecryptZeroIv, ctrCrypt, decryptTlvRecords, ecbDecrypt, foldKey } from './mega-crypto'

/**
 * MEGA public shared-folder scanning. No credentials at all — the share
 * key lives in the link fragment — but everything is end-to-end
 * encrypted, so this adapter does the client-side crypto itself:
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
 * derived from the already-public share key; MAC verification is skipped
 * (Manorama proxies, it does not attest integrity); free accounts hit
 * MEGA bandwidth quotas (509) which surface as temporary failures.
 */

const IMAGE_EXTENSIONS = /\.(?:jpe?g|webp|heic|heif|tiff?|png)$/i
const API = 'https://g.api.mega.co.nz/cs'
// Enough head bytes to find a JPEG SOF marker past typical EXIF APP1.
const DIMS_PROBE_BYTES = 65536
// Whole-file proxy ceiling — keeps Worker memory bounded.
const MAX_FILE_BYTES = 64 * 1024 * 1024

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

export type MegaScan = { sourceUrl: string; title: string; images: GalleryImage[] }

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

/** Decrypts a node's `k` field: alternatives are `handle:encKey` pairs
 *  joined by '/'; the folder share key decrypts the children. */
const decryptNodeKey = (k: string | undefined, shareKey: Uint8Array) => {
  if (!k) return null
  for (const part of k.split('/')) {
    const enc = part.split(':').pop()
    if (!enc) continue
    try {
      const key = ecbDecrypt(shareKey, b64uDecode(enc))
      if (key.length === 16 || key.length === 32) return key
    } catch {
      // Try the next alternative.
    }
  }
  return null
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

const ctxParams = (auth: MegaAuth) =>
  auth.n ? `folder=${encodeURIComponent(auth.n)}` : `set=${encodeURIComponent(auth.s ?? '')}`
const fileProxy = (auth: MegaAuth, node: string, nodeKey: Uint8Array) =>
  `/api/mega/file?${ctxParams(auth)}&node=${encodeURIComponent(node)}&k=${b64uEncode(nodeKey)}`
const previewProxy = (auth: MegaAuth, fah: string, nodeKey: Uint8Array) =>
  `/api/mega/preview?${ctxParams(auth)}&h=${encodeURIComponent(fah)}&k=${b64uEncode(nodeKey)}`

// Formats browsers render natively; everything else goes through the
// decrypted JPEG preview (fa) path.
const BROWSER_RENDERABLE = /\.(?:jpe?g|webp|png|gif|avif)$/i

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

const fetchRange = async (g: string, start: number, end: number, fetchImpl: typeof fetch) => {
  const response = await fetchImpl(`${g}/${start}-${end}`)
  if (response.status === 509) throw new SourceFetchError('MEGA bandwidth limit reached — try again later', 503)
  if (!response.ok) throw new SourceFetchError(`MEGA download failed (${response.status})`, response.status)
  return new Uint8Array(await response.arrayBuffer())
}

const decryptContent = (bytes: Uint8Array, nodeKey: Uint8Array) =>
  ctrCrypt(foldKey(nodeKey), nodeKey.subarray(16, 24), bytes)

/** WebP RIFF dims: VP8X (1+LE24 fields), lossy VP8 (14-bit LE after
 *  the 9d 012a start code), VP8L (packed 14-bit fields). */
const parseWebpDimensions = (bytes: Uint8Array) => {
  if (bytes.length < 30 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const fourcc = String.fromCharCode(...bytes.subarray(12, 16))
  if (fourcc === 'VP8X') {
    return { width: 1 + ((bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16)), height: 1 + ((bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16)) }
  }
  if (fourcc === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

const parsePreviewDimensions = (bytes: Uint8Array) => parseJpegDimensions(bytes) ?? parseWebpDimensions(bytes)

const sniffContentType = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp'
      : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : 'application/octet-stream'

/** Fetches + decrypts one file attribute (thumbnail/preview): ufa
 *  resolves the attribute URL, a POST of the raw 8-byte handle returns
 *  {handle:8}{len:4}{CBC-encrypted data} records. */
const fetchFileAttribute = async (auth: MegaAuth, fah: string, nodeKey: Uint8Array, fetchImpl: typeof fetch) => {
  const handleBytes = b64uDecode(fah)
  if (handleBytes.length !== 8) return null
  const resolved = await megaRequest<{ p?: string }>([{ a: 'ufa', fah: b64Encode(handleBytes), ssl: 2, r: 1, v: 3 }], auth, fetchImpl)
  if (!resolved.p) return null
  const response = await fetchImpl(resolved.p, { method: 'POST', body: handleBytes })
  if (!response.ok) throw new SourceFetchError(`MEGA preview failed (${response.status})`, response.status)
  const buf = new Uint8Array(await response.arrayBuffer())
  let offset = 0
  while (offset + 12 <= buf.length) {
    const record = buf.subarray(offset, offset + 8)
    const length = new DataView(buf.buffer, buf.byteOffset + offset + 8, 4).getUint32(0, true)
    offset += 12
    if (offset + length > buf.length) return null
    if (b64uEncode(record) === fah) {
      if (length % 16) return null
      return cbcDecryptZeroIv(foldKey(nodeKey), buf.subarray(offset, offset + length))
    }
    offset += length
  }
  return null
}

/** Best-effort dimensions: the decrypted JPEG preview when the node
 *  carries one (small, and works for HEIC/TIFF too), else a ranged
 *  head fetch of JPEG originals; anything else gets a 4:3 placeholder.
 *  Reported dims are the rendition's — aspect is what matters for
 *  layout, matching the Dropbox thumbnail-dims precedent. */
const probeDimensions = async (auth: MegaAuth, node: { h: string; fa?: string }, nodeKey: Uint8Array, name: string, fetchImpl: typeof fetch) => {
  try {
    const fah = faHandle(node.fa, 1) ?? faHandle(node.fa, 0)
    if (fah) {
      const preview = await fetchFileAttribute(auth, fah, nodeKey, fetchImpl)
      const dimensions = preview ? parsePreviewDimensions(preview) : null
      if (dimensions) return dimensions
    }
    if (!/\.jpe?g$/i.test(name)) return { width: 4, height: 3 }
    const info = await downloadInfo(auth, node.h, fetchImpl)
    if (!info.g) return { width: 4, height: 3 }
    const head = await fetchRange(info.g, 0, DIMS_PROBE_BYTES - 1, fetchImpl)
    const dimensions = parseJpegDimensions(decryptContent(head, nodeKey))
    if (dimensions) return dimensions
  } catch {
    // Dimensions are a nicety — never fail a scan over them.
  }
  return { width: 4, height: 3 }
}

const makeImage = (auth: MegaAuth, index: number, node: { h: string; fa?: string }, nodeKey: Uint8Array, name: string, width: number, height: number): GalleryImage | null => {
  const renderable = BROWSER_RENDERABLE.test(name)
  const fah = faHandle(node.fa, 1) ?? faHandle(node.fa, 0)
  // HEIC/TIFF originals can't render in browsers — route them through
  // MEGA's JPEG preview. If MEGA generated no preview, drop the image
  // rather than shipping undisplayable bytes.
  if (!renderable && !fah) return null
  return {
    id: `mega-${node.h.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
    ref: node.h,
    filename: name,
    src: renderable ? fileProxy(auth, node.h, nodeKey) : previewProxy(auth, fah!, nodeKey),
    width,
    height,
    alt: filenameLabel(name),
    // CTR decryption happens at proxy time — bytes are the MEGA
    // originals, so embedded credentials survive.
    c2pa: true,
    placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
  }
}

export const scanMegaFolder = async (input: string, fetchImpl: typeof fetch = fetch): Promise<MegaScan> => {
  const link = extractMegaLink(input)
  if (!link || link.kind !== 'folder') throw new Error('Use a public MEGA folder link')
  const auth = linkAuth(link)
  const shareKey = b64uDecode(link.key)
  if (shareKey.length !== 16 && shareKey.length !== 32) throw new Error('That MEGA link does not carry a usable key')
  const listing = await megaRequest<{ f?: MegaNode[] }>([{ a: 'f', c: 1, ca: 1, r: 1 }], auth, fetchImpl)
  const nodes = listing.f ?? []

  const files = nodes
    .filter((node) => node.t === 0 && node.p === link.id && node.a && node.k)
    .flatMap((node) => {
      const nodeKey = decryptNodeKey(node.k, shareKey)
      if (!nodeKey) return []
      const attributes = decryptAttributes(node.a, nodeKey)
      const name = attributes?.n?.trim()
      if (!name || !IMAGE_EXTENSIONS.test(name)) return []
      return [{ node, nodeKey, name }]
    })
  if (!files.length) throw new Error('No image files were found in that public MEGA folder')

  // Folder title from the root node's own attributes when decryptable.
  const root = nodes.find((node) => node.h === link.id) ?? nodes.find((node) => node.t === 1)
  const rootKey = root ? decryptNodeKey(root.k, shareKey) ?? shareKey : shareKey
  const title = (root ? decryptAttributes(root.a, rootKey)?.n?.trim() : '') || 'Untitled gallery'

  const images = (await Promise.all(files.map(async ({ node, nodeKey, name }, index) => {
    const dims = await probeDimensions(auth, node, nodeKey, name, fetchImpl)
    return makeImage(auth, index, node, nodeKey, name, dims.width, dims.height)
  }))).filter((image): image is GalleryImage => image !== null)
  if (!images.length) throw new Error('No image files were found in that public MEGA folder')
  return { sourceUrl: canonicalMegaUrl(link), title, images }
}

/** Public collections ("Sets") use a different API surface than
 *  folders: a:'aft' with &s={publicSetHandle} returns the set, its
 *  elements, and node metadata. Element keys are AES-CBC-encrypted
 *  with the share key from the link fragment; node metadata attrs use
 *  the ordinary MEGA{...} format decrypted with the element key. */
export const scanMegaCollection = async (input: string, fetchImpl: typeof fetch = fetch): Promise<MegaScan> => {
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

  const files = elements.flatMap((element) => {
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
    return [{ element, elementKey, meta, name }]
  })
  if (!files.length) throw new Error('No image files were found in that public MEGA collection')

  files.sort((a, b) => (a.element.o ?? 0) - (b.element.o ?? 0))
  const images = (await Promise.all(files.map(async ({ element, elementKey, meta, name }, index) => {
    const node = { h: element.h!, fa: meta?.fa }
    const dims = await probeDimensions(auth, node, elementKey, name, fetchImpl)
    return makeImage(auth, index, node, elementKey, name, dims.width, dims.height)
  }))).filter((image): image is GalleryImage => image !== null)
  if (!images.length) throw new Error('No image files were found in that public MEGA collection')
  return { sourceUrl: canonicalMegaUrl(link), title, images }
}

export const scanMegaSource = (input: string, fetchImpl: typeof fetch = fetch) => {
  const link = extractMegaLink(input)
  if (link?.kind === 'collection') return scanMegaCollection(input, fetchImpl)
  return scanMegaFolder(input, fetchImpl)
}

const megaAuthFromParams = (folder: string | undefined, set: string | undefined): MegaAuth =>
  set ? { s: set } : { n: folder }

export const fetchMegaFile = async (folder: string | undefined, set: string | undefined, node: string, keyB64: string, fetchImpl: typeof fetch = fetch) => {
  const nodeKey = b64uDecode(keyB64)
  const info = await downloadInfo(megaAuthFromParams(folder, set), node, fetchImpl)
  if (!info.g) throw new SourceFetchError('That MEGA image is unavailable', 404)
  const size = info.s ?? 0
  if (size === 0) throw new SourceFetchError('That MEGA image is unavailable', 404)
  if (size > MAX_FILE_BYTES) throw new SourceFetchError('That MEGA image is too large to proxy', 413)
  const bytes = await fetchRange(info.g, 0, size - 1, fetchImpl)
  const plain = decryptContent(bytes, nodeKey)
  return new Response(plain, { status: 200 })
}

/** Serves a decrypted JPEG preview/thumbnail for files whose originals
 *  browsers can't render (HEIC, TIFF). */
export const fetchMegaPreview = async (folder: string | undefined, set: string | undefined, fah: string, keyB64: string, fetchImpl: typeof fetch = fetch) => {
  const nodeKey = b64uDecode(keyB64)
  const preview = await fetchFileAttribute(megaAuthFromParams(folder, set), fah, nodeKey, fetchImpl)
  if (!preview) throw new SourceFetchError('That MEGA image preview is unavailable', 404)
  return new Response(preview, { status: 200, headers: { 'Content-Type': sniffContentType(preview) } })
}
