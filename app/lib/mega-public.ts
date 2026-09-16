import { SourceFetchError, type GalleryImage } from './imagesource'
import { parseJpegDimensions } from './dropbox-public'
import { b64uDecode, b64uEncode, cbcDecryptZeroIv, ctrCrypt, ecbDecrypt, foldKey } from './mega-crypto'

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
  ts?: number
}

export type MegaScan = { sourceUrl: string; title: string; images: GalleryImage[] }

/** Public folder link spellings: mega.nz/folder/{id}#{key} and the
 *  legacy mega.nz/#F!{id}!{key}. Optional /file/{id} tails are ignored —
 *  the gallery is the folder. */
export const extractMegaFolder = (input: string) => {
  const url = new URL(input.trim())
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'mega.nz' && host !== 'mega.co.nz') return null
  const modern = url.pathname.match(/^\/folder\/([0-9A-Za-z_-]+)/)
  if (modern) {
    const key = url.hash.replace(/^#/, '').split('/')[0] || ''
    return key ? { folder: modern[1]!, key } : null
  }
  const legacy = url.hash.match(/^#F!([0-9A-Za-z_-]+)[!#]([0-9A-Za-z_-]+)/)
  return legacy ? { folder: legacy[1]!, key: legacy[2]! } : null
}

export const canonicalMegaUrl = (folder: string, key: string) =>
  `https://mega.nz/folder/${folder}#${key}`

/** MEGA answers API failures as bare negative numbers (-9 not found,
 *  -11 access denied, -18 link expired, -4/-17 rate limits). */
const megaRequest = async <T>(commands: Record<string, unknown>[], folder: string | undefined, fetchImpl: typeof fetch): Promise<T> => {
  const url = `${API}?id=0${folder ? `&n=${encodeURIComponent(folder)}` : ''}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  })
  if (!response.ok) throw new SourceFetchError(`MEGA request failed (${response.status})`, response.status)
  const payload = await response.json() as unknown
  const head = Array.isArray(payload) ? payload[0] : payload
  if (typeof head === 'number' && head < 0) {
    if (head === -9 || head === -18) throw new SourceFetchError('That MEGA folder was not found — check the link is a public folder link', 404)
    if (head === -11) throw new SourceFetchError('Manorama could not read that MEGA folder — check the link is a public folder link', 403)
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
const fileProxy = (folder: string, node: string, nodeKey: Uint8Array) =>
  `/api/mega/file?folder=${encodeURIComponent(folder)}&node=${encodeURIComponent(node)}&k=${b64uEncode(nodeKey)}`

/** Resolves a node to its CDN URL and size. */
const downloadInfo = async (folder: string, node: string, fetchImpl: typeof fetch) =>
  megaRequest<{ g?: string; s?: number }>([{ a: 'g', g: 1, ssl: 2, n: node }], folder, fetchImpl)

const fetchRange = async (g: string, start: number, end: number, fetchImpl: typeof fetch) => {
  const response = await fetchImpl(`${g}/${start}-${end}`)
  if (response.status === 509) throw new SourceFetchError('MEGA bandwidth limit reached — try again later', 503)
  if (!response.ok) throw new SourceFetchError(`MEGA download failed (${response.status})`, response.status)
  return new Uint8Array(await response.arrayBuffer())
}

const decryptContent = (bytes: Uint8Array, nodeKey: Uint8Array) =>
  ctrCrypt(foldKey(nodeKey), nodeKey.subarray(16, 24), bytes)

/** Best-effort dimensions: fetch the head of JPEG files and parse the
 *  SOF marker; anything else falls back to a 4:3 placeholder. */
const probeDimensions = async (folder: string, node: MegaNode, nodeKey: Uint8Array, fetchImpl: typeof fetch) => {
  try {
    const info = await downloadInfo(folder, node.h, fetchImpl)
    if (!info.g) return { width: 4, height: 3 }
    const head = await fetchRange(info.g, 0, DIMS_PROBE_BYTES - 1, fetchImpl)
    const dimensions = parseJpegDimensions(decryptContent(head, nodeKey))
    if (dimensions) return dimensions
  } catch {
    // Dimensions are a nicety — never fail a scan over them.
  }
  return { width: 4, height: 3 }
}

export const scanMegaFolder = async (input: string, fetchImpl: typeof fetch = fetch): Promise<MegaScan> => {
  const link = extractMegaFolder(input)
  if (!link) throw new Error('Use a public MEGA folder link')
  const shareKey = b64uDecode(link.key)
  if (shareKey.length !== 16 && shareKey.length !== 32) throw new Error('That MEGA link does not carry a usable key')
  const listing = await megaRequest<{ f?: MegaNode[] }>([{ a: 'f', c: 1, ca: 1, r: 1 }], link.folder, fetchImpl)
  const nodes = listing.f ?? []

  const files = nodes
    .filter((node) => node.t === 0 && node.p === link.folder && node.a && node.k)
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
  const root = nodes.find((node) => node.h === link.folder) ?? nodes.find((node) => node.t === 1)
  const rootKey = root ? decryptNodeKey(root.k, shareKey) ?? shareKey : shareKey
  const title = (root ? decryptAttributes(root.a, rootKey)?.n?.trim() : '') || 'Untitled gallery'

  const images = await Promise.all(files.map(async ({ node, nodeKey, name }, index): Promise<GalleryImage> => {
    const { width, height } = /\.jpe?g$/i.test(name)
      ? await probeDimensions(link.folder, node, nodeKey, fetchImpl)
      : { width: 4, height: 3 }
    return {
      id: `mega-${node.h.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
      ref: node.h,
      filename: name,
      src: fileProxy(link.folder, node.h, nodeKey),
      width,
      height,
      alt: filenameLabel(name),
      // CTR decryption happens at proxy time — bytes are the MEGA
      // originals, so embedded credentials survive.
      c2pa: true,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
    }
  }))
  return { sourceUrl: canonicalMegaUrl(link.folder, link.key), title, images }
}

export const fetchMegaFile = async (folder: string, node: string, keyB64: string, fetchImpl: typeof fetch = fetch) => {
  const nodeKey = b64uDecode(keyB64)
  const info = await downloadInfo(folder, node, fetchImpl)
  if (!info.g) throw new SourceFetchError('That MEGA image is unavailable', 404)
  const size = info.s ?? 0
  if (size === 0) throw new SourceFetchError('That MEGA image is unavailable', 404)
  if (size > MAX_FILE_BYTES) throw new SourceFetchError('That MEGA image is too large to proxy', 413)
  const bytes = await fetchRange(info.g, 0, size - 1, fetchImpl)
  const plain = decryptContent(bytes, nodeKey)
  return new Response(plain, { status: 200 })
}
