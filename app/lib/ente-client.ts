import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage } from './imagesource'
import { enteIdentityFromUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import { probeImageDimensions } from './image-dims'
import { createScanBudget, ScanBudgetExhausted } from './scan-budget'

/**
 * Browser/native Ente public-album client. The album key stays in this
 * module's in-memory session; published manifests contain only keyless
 * references. Upstream requests carry ciphertext and the public access
 * token only.
 *
 * Wire format (implemented against ente-io/ente's documented protocol —
 * upstream is AGPL-3.0, so this is a clean-room implementation, not a
 * port; verified against ente-io/ente @ main, web/packages/base/crypto +
 * apps/embed public-collection service):
 *
 *  - Links: albums.ente.io/{token}#{albumKey} (current) or
 *    albums.ente.io/?t={token}#{albumKey} (legacy). The fragment is a
 *    base58-encoded 32-byte album key (hex on some older links); it is
 *    client-side only and never reaches Ente's servers.
 *  - API: api.ente.io /public-collection/{info,diff,verify-password}.
 *    Auth is the access token in X-Auth-Access-Token; password-protected
 *    links add X-Auth-Access-Token-JWT; device-limited links issue a
 *    token in the X-Link-Device-Token response header which the client
 *    returns as X-Auth-Link-Device-Token.
 *  - Media: public-albums.ente.com/download/?fileID=N (originals) and
 *    /preview/?fileID=N (thumbnails), both ciphertext.
 *  - Crypto (libsodium): file keys, the album name, and file metadata are
 *    XSalsa20-Poly1305 secretbox under the album key (metadata and public
 *    magic metadata are single-chunk secretstream blobs); file and
 *    thumbnail bytes are XChaCha20-Poly1305 secretstream in 4 MiB chunks.
 *    Password links derive a verifier via Argon2id (pwhash) with
 *    server-supplied limits.
 *
 * Caveats: video and Live Photos are out of scope; `enableDownload:
 * false` changes nothing for us because we never expose a download
 * affordance — the bytes still flow for display, exactly as they do for
 * ente's own album app.
 */

const API = 'https://api.ente.io'
const CDN = 'https://public-albums.ente.com'
// A single secretstream chunk authenticates whole: a ranged probe needs
// the first chunk intact (4 MiB of plaintext plus per-chunk overhead).
const STREAM_CHUNK = 4 * 1024 * 1024
const STREAM_ABYTES = 17
const MAX_FILE_BYTES = 48 * 1024 * 1024
const IMAGE_EXTENSIONS = /\.(?:jpe?g|webp|avif|hei[cf])$/i
// Client-side scans have no subrequest ceiling; the budget is a backstop
// against runaway fan-out. ~1-2 requests per item (diff page plus an
// optional dims probe) leaves generous headroom.
const ENTE_SCAN_REQUEST_BUDGET = MAX_GALLERY_ITEMS * 3

const b58decode = (input: string): Uint8Array => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const digits = new Map([...alphabet].map((char, i) => [char, i]))
  const bytes: number[] = []
  for (const char of input.trim()) {
    const value = digits.get(char)
    if (value === undefined) throw new SourceFetchError('That Ente album key is malformed', 400)
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  for (const char of input.trim()) { if (char !== '1') break; bytes.push(0) }
  return Uint8Array.from(bytes.reverse())
}

const albumKeyFromFragment = (fragment: string): Uint8Array => {
  const trimmed = fragment.trim()
  // Older links hex-encode the key; everything newer is base58.
  const bytes = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length >= 50
    ? Uint8Array.from(trimmed.match(/../g)!.map((pair) => parseInt(pair, 16)))
    : b58decode(trimmed)
  if (bytes.length !== 32) throw new SourceFetchError('That Ente album key is malformed', 400)
  return bytes
}

export type EnteLink = { token: string; key: Uint8Array }

/** albums.ente.io|com/{token}#{key} and the legacy ?t={token}#{key} form. */
export const extractEnteLink = (input: string): EnteLink | null => {
  const identity = enteIdentityFromUrl(input)
  if (!identity) return null
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : ''
  if (!fragment) return null
  return { token: identity.id, key: albumKeyFromFragment(fragment) }
}

/** Thrown when the album advertises password protection — the caller
 *  prompts locally and retries with `verifyEntePassword`'s JWT; the
 *  password itself never leaves the session. */
export class EntePasswordRequired extends Error {
  constructor(public readonly kdf: { nonce: string; opsLimit: number; memLimit: number }) {
    super('That Ente album is password-protected')
    this.name = 'EntePasswordRequired'
  }
}

type Credentials = { accessToken: string; accessTokenJWT?: string; linkDeviceToken?: string }

const requestHeaders = (credentials: Credentials): Record<string, string> => ({
  'X-Auth-Access-Token': credentials.accessToken,
  ...(credentials.accessTokenJWT ? { 'X-Auth-Access-Token-JWT': credentials.accessTokenJWT } : {}),
  ...(credentials.linkDeviceToken ? { 'X-Auth-Link-Device-Token': credentials.linkDeviceToken } : {}),
})

const ensureOk = (response: Response, context: string): Response => {
  if (response.ok) return response
  if (response.status === 410) throw new SourceFetchError('That Ente album link has expired or was revoked', 410)
  if (response.status === 401 || response.status === 403) throw new SourceFetchError(`That Ente album refused access (${context})`, response.status)
  throw new SourceFetchError(`Ente ${context} failed (${response.status})`, response.status)
}

/** Exchanges a locally entered password for the JWT a protected link
 *  wants on subsequent requests. KDF parameters come from the album's
 *  /info response, which remote deliberately serves pre-unlock. */
export const verifyEntePassword = async (token: string, password: string, kdf: { nonce: string; opsLimit: number; memLimit: number }, fetchImpl: typeof fetch = fetch): Promise<string> => {
  const sodium = (await import('libsodium-wrappers-sumo')).default
  await sodium.ready
  const hash = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string(password),
    sodium.from_base64(kdf.nonce, sodium.base64_variants.ORIGINAL),
    kdf.opsLimit,
    kdf.memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
  const response = await fetchImpl(`${API}/public-collection/verify-password`, {
    method: 'POST',
    headers: requestHeaders({ accessToken: token }),
    body: JSON.stringify({ passHash: sodium.to_base64(hash, sodium.base64_variants.ORIGINAL) }),
  })
  ensureOk(response, 'password check')
  const parsed = await response.json() as { jwtToken?: string }
  if (!parsed.jwtToken) throw new SourceFetchError('That Ente album password was refused', 401)
  return parsed.jwtToken
}

type RemotePublicURL = {
  url?: string
  deviceLimit?: number
  validTill?: number
  enableDownload?: boolean
  passwordEnabled?: boolean
  nonce?: string
  opsLimit?: number
  memLimit?: number
}

type RemoteCollection = {
  name?: string
  encryptedName?: string
  nameDecryptionNonce?: string
  publicURLs?: RemotePublicURL[]
}

type RemoteFile = {
  id: number
  encryptedKey?: string
  keyDecryptionNonce?: string
  file?: { decryptionHeader?: string }
  thumbnail?: { decryptionHeader?: string }
  info?: { fileSize?: number; thumbSize?: number }
  metadata?: { encryptedData?: string; decryptionHeader?: string }
  pubMagicMetadata?: { data?: { encryptedData?: string; header?: string } }
  updationTime?: number
  isDeleted?: boolean
}

type Sodium = typeof import('libsodium-wrappers-sumo').default

const b64 = (sodium: Sodium, input: string) => sodium.from_base64(input, sodium.base64_variants.ORIGINAL)

const decryptBox = (sodium: Sodium, box: { encryptedData: string; nonce: string }, key: Uint8Array): Uint8Array =>
  sodium.crypto_secretbox_open_easy(b64(sodium, box.encryptedData), b64(sodium, box.nonce), key)

/** Album-key-scoped decryptions: a secretbox auth failure here means the
 *  link's fragment key is wrong for this album, not that a record is
 *  corrupt — surface it as the key error, not a generic crypto throw. */
const decryptWithAlbumKey = (sodium: Sodium, box: { encryptedData: string; nonce: string }, albumKey: Uint8Array): Uint8Array => {
  try {
    return decryptBox(sodium, box, albumKey)
  } catch {
    throw new SourceFetchError('That Ente album key is malformed', 400)
  }
}

const decryptBlob = (sodium: Sodium, blob: { encryptedData: Uint8Array; decryptionHeader: Uint8Array }, key: Uint8Array): Uint8Array => {
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(blob.decryptionHeader, key)
  const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, blob.encryptedData, null)
  if (!pulled) throw new SourceFetchError('That Ente album record failed to decrypt', 502)
  return pulled.message
}

const decryptMetadataJson = (sodium: Sodium, blob: { encryptedData?: string; decryptionHeader?: string }, key: Uint8Array): Record<string, unknown> | null => {
  if (!blob.encryptedData || !blob.decryptionHeader) return null
  try {
    const plain = decryptBlob(sodium, { encryptedData: b64(sodium, blob.encryptedData), decryptionHeader: b64(sodium, blob.decryptionHeader) }, key)
    const parsed = JSON.parse(new TextDecoder().decode(plain))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

const decryptStream = (sodium: Sodium, header: Uint8Array, encrypted: Uint8Array, fileKey: Uint8Array): Uint8Array => {
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, fileKey)
  const chunkSize = STREAM_CHUNK + STREAM_ABYTES
  const chunks: Uint8Array[] = []
  let read = 0
  let tag = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
  while (read < encrypted.length && tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
    const end = Math.min(read + chunkSize, encrypted.length)
    const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, encrypted.subarray(read, end), null)
    if (!pulled) throw new SourceFetchError('That Ente image failed to decrypt', 502)
    chunks.push(pulled.message)
    tag = pulled.tag
    read = end
  }
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

const sniffContentType = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp'
      : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : bytes[4] === 0x66 && bytes[5] === 0x74 ? 'image/heic'
          : 'application/octet-stream'

const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'

const isStillImage = (metadata: Record<string, unknown> | null, filename: string): boolean => {
  // fileType 0 = image; video (1) and live photos (2) are out of scope.
  if (metadata && typeof metadata.fileType === 'number') return metadata.fileType === 0
  return IMAGE_EXTENSIONS.test(filename)
}

type PendingKey = { resolve: (key: Uint8Array) => void; reject: (error?: unknown) => void }

export type EnteScan = { sourceUrl: string; title: string; images: GalleryImage[]; truncated?: number }

export type EnteClientSession = {
  sourceUrl: string
  /** Diff listing plus dims pass, running in the background. A viewer's
   *  materialize works off whichever file keys have landed so far — only
   *  manifest submitters wait on `scan`. */
  scan: Promise<EnteScan>
  materialize(fileId: string, preview: boolean, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>
  dispose(): void
}

/** The session returns before the diff resolves: a materialize that
 *  names a known item parks on its key rather than waiting for the whole
 *  album to unwrap. Keys and decryption headers land file-by-file
 *  through the notifying map; anything still pending when the listing
 *  settles can never arrive and fails then. Only `scan` output is
 *  eligible for manifest submission; the key map never appears in JSON
 *  or URLs. */
export const openEnteSession = async (input: string, fetchImpl: typeof fetch = fetch): Promise<EnteClientSession> => {
  const link = extractEnteLink(input)
  if (!link) throw new Error('Use a complete public Ente album link')
  const albumKey = link.key
  const sourceUrl = keylessSourceUrl(input)
  const credentials: Credentials = { accessToken: link.token }
  const meteredFetch = createScanBudget(ENTE_SCAN_REQUEST_BUDGET).fetch(fetchImpl)
  const sodium = (await import('libsodium-wrappers-sumo')).default
  await sodium.ready
  const pending = new Map<string, PendingKey[]>()
  const fileHeaders = new Map<string, RemoteFile>()
  const keys = new class extends Map<string, Uint8Array> {
    set(id: string, key: Uint8Array) {
      // A listing that lands after dispose must not leave live key bytes
      // in a session nothing can read.
      if (disposed) key.fill(0)
      const out = super.set(id, key)
      const waiters = pending.get(id)
      if (waiters) {
        pending.delete(id)
        for (const waiter of waiters) waiter.resolve(key)
      }
      return out
    }
  }()
  let disposed = false
  let listed = false
  let listError: unknown
  const failWaiters = (error: unknown) => {
    for (const waiters of pending.values()) for (const waiter of waiters) waiter.reject(error)
    pending.clear()
  }
  const awaitKey = (fileId: string): Promise<Uint8Array> => {
    const hit = keys.get(fileId)
    if (hit) return Promise.resolve(hit)
    if (disposed) return Promise.reject(new Error('This Ente session is closed'))
    if (listed) {
      return Promise.reject(listError instanceof Error ? listError : new Error('This media reference is not present in the opened Ente album'))
    }
    let resolve!: (key: Uint8Array) => void, reject!: (error?: unknown) => void
    const promise = new Promise<Uint8Array>((res, rej) => { resolve = res; reject = rej })
    const waiters = pending.get(fileId)
    if (waiters) waiters.push({ resolve, reject })
    else pending.set(fileId, [{ resolve, reject }])
    return promise
  }

  const noteDeviceToken = (response: Response) => {
    const token = response.headers.get('X-Link-Device-Token')
    if (token) credentials.linkDeviceToken = token
  }

  const listAlbum = async (): Promise<{ title: string; files: { remote: RemoteFile; metadata: Record<string, unknown> | null; width?: number; height?: number }[]; foundTotal: number }> => {
    const infoResponse = ensureOk(await meteredFetch(`${API}/public-collection/info`, { headers: requestHeaders(credentials) }), 'info')
    noteDeviceToken(infoResponse)
    const info = await infoResponse.json() as { collection?: RemoteCollection }
    const collection = info.collection
    if (!collection) throw new SourceFetchError('That Ente album is unavailable', 404)
    const publicUrl = collection.publicURLs?.find((entry) => entry.url?.includes(link.token)) ?? collection.publicURLs?.[0]
    if (publicUrl?.passwordEnabled && !credentials.accessTokenJWT) {
      throw new EntePasswordRequired({ nonce: publicUrl.nonce ?? '', opsLimit: publicUrl.opsLimit ?? 0, memLimit: publicUrl.memLimit ?? 0 })
    }
    const title = collection.name ||
      (collection.encryptedName && collection.nameDecryptionNonce
        ? new TextDecoder().decode(decryptWithAlbumKey(sodium, { encryptedData: collection.encryptedName, nonce: collection.nameDecryptionNonce }, albumKey))
        : 'Ente album')
    const files: { remote: RemoteFile; metadata: Record<string, unknown> | null; width?: number; height?: number }[] = []
    let sinceTime = 0
    let foundTotal = 0
    for (let hasMore = true; hasMore;) {
      if (disposed) throw new Error('This Ente session is closed')
      const diffResponse = ensureOk(await meteredFetch(`${API}/public-collection/diff?sinceTime=${sinceTime}`, { headers: requestHeaders(credentials) }), 'diff')
      noteDeviceToken(diffResponse)
      const body = await diffResponse.json() as { diff?: RemoteFile[]; hasMore?: boolean }
      for (const remote of body.diff ?? []) {
        if (remote.updationTime && remote.updationTime > sinceTime) sinceTime = remote.updationTime
        if (remote.isDeleted || !remote.encryptedKey || !remote.keyDecryptionNonce) continue
        foundTotal += 1
        const fileKey = decryptWithAlbumKey(sodium, { encryptedData: remote.encryptedKey, nonce: remote.keyDecryptionNonce }, albumKey)
        const metadata = decryptMetadataJson(sodium, remote.metadata ?? {}, fileKey)
        const filename = metadata && typeof metadata.title === 'string' && metadata.title ? metadata.title : `photo-${remote.id}.jpg`
        if (!isStillImage(metadata, filename)) { fileKey.fill(0); continue }
        keys.set(String(remote.id), fileKey)
        fileHeaders.set(String(remote.id), remote)
        const pub = decryptMetadataJson(sodium, remote.pubMagicMetadata?.data
          ? { encryptedData: remote.pubMagicMetadata.data.encryptedData, decryptionHeader: remote.pubMagicMetadata.data.header }
          : {}, fileKey)
        files.push({
          remote, metadata,
          width: pub && typeof pub.w === 'number' && pub.w > 0 ? pub.w : undefined,
          height: pub && typeof pub.h === 'number' && pub.h > 0 ? pub.h : undefined,
        })
      }
      hasMore = Boolean(body.hasMore)
    }
    if (files.length > MAX_GALLERY_ITEMS) {
      throw new SourceFetchError(`That Ente album has ${files.length} images — galleries are limited to ${MAX_GALLERY_ITEMS.toLocaleString()} items`, 413)
    }
    return { title, files, foundTotal }
  }

  const decryptFile = async (fileId: string, preview: boolean, signal?: AbortSignal, range?: string, fetcher: typeof fetch = fetchImpl): Promise<Uint8Array> => {
    // Await the key before reading the header map: a parked request resumes
    // the moment its file lands mid-diff instead of waiting for the whole
    // listing to settle.
    const fileKey = await awaitKey(fileId)
    const remote = fileHeaders.get(fileId)
    const header = (preview ? remote?.thumbnail : remote?.file)?.decryptionHeader ?? remote?.file?.decryptionHeader
    if (!remote || !header) throw new SourceFetchError('That Ente image is unavailable', 404)
    const ciphertext = new Uint8Array(await ensureOk(await fetcher(`${CDN}/${preview ? 'preview' : 'download'}/?fileID=${fileId}`, {
      headers: { ...requestHeaders(credentials), ...(range ? { Range: range } : {}) },
      signal,
    }), preview ? 'preview' : 'download').arrayBuffer())
    if (ciphertext.length > MAX_FILE_BYTES) { ciphertext.fill(0); throw new SourceFetchError('That Ente image is too large to open', 413) }
    const plain = decryptStream(sodium, b64(sodium, header), ciphertext, fileKey)
    ciphertext.fill(0)
    return plain
  }

  const probeDimensions = async (fileId: string): Promise<{ width: number; height: number } | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // The first secretstream chunk authenticates on its own — a ranged
        // fetch of it yields enough plaintext for a dimension read without
        // downloading the whole original.
        const head = await decryptFile(fileId, false, undefined, `bytes=0-${STREAM_CHUNK + STREAM_ABYTES - 1}`, meteredFetch)
        const dims = probeImageDimensions(head)
        head.fill(0)
        return dims
      } catch (error) {
        if (error instanceof ScanBudgetExhausted) throw error
        // Dimensions are a nicety — never fail a scan over them.
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }
    return null
  }

  const makeImage = async (remote: RemoteFile, filename: string, width: number, height: number): Promise<GalleryImage> => {
    const fileId = String(remote.id)
    const media = { kind: 'encrypted' as const, provider: 'ente' as const, sourceKind: 'album' as const, sourceId: link.token, nodeId: fileId, previewId: fileId }
    const versionInput = new TextEncoder().encode(JSON.stringify({ id: remote.id, u: remote.updationTime ?? null }))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', versionInput))
    versionInput.fill(0)
    return {
      id: `ente-${fileId}`,
      ref: fileId,
      filename,
      src: '',
      media,
      contentVersion: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      fidelity: 'original',
      thumbnailFidelity: 'display-derivative',
      // The decrypted thumbnail stands in as the rail image so it never
      // pays for a multi-MB original per cell.
      variants: [{ width, src: '', media, format: 'jpeg' }],
      width,
      height,
      alt: filenameLabel(filename),
      c2pa: true,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
    }
  }

  const PROBE_BATCH = 6
  const scanImages = async (listed: Awaited<ReturnType<typeof listAlbum>>): Promise<EnteScan> => {
    const images: GalleryImage[] = []
    let exhausted = false
    for (let i = 0; i < listed.files.length && !exhausted; i += PROBE_BATCH) {
      if (disposed) throw new Error('This Ente session is closed')
      const batch = await Promise.all(listed.files.slice(i, i + PROBE_BATCH).map(async (entry) => {
        const filename = entry.metadata && typeof entry.metadata.title === 'string' && entry.metadata.title
          ? entry.metadata.title
          : `photo-${entry.remote.id}.jpg`
        try {
          const dims = entry.width && entry.height
            ? { width: entry.width, height: entry.height }
            : await probeDimensions(String(entry.remote.id)) ?? { width: 4, height: 3 }
          return await makeImage(entry.remote, filename, dims.width, dims.height)
        } catch (error) {
          if (error instanceof ScanBudgetExhausted) { exhausted = true; return null }
          throw error
        }
      }))
      images.push(...batch.filter((image): image is GalleryImage => image !== null))
    }
    const truncated = exhausted ? listed.files.length - images.length : undefined
    return { sourceUrl, title: listed.title, images, ...(truncated && truncated > 0 ? { truncated } : {}) }
  }

  // The listing settles every parked waiter — a file that never appears
  // is absent — then the dims pass builds manifest fields without
  // holding materialize up.
  const listAndSettle = async () => {
    try {
      return await listAlbum()
    } catch (error) {
      listError = error
      throw error
    } finally {
      listed = true
    }
  }
  const listing = listAndSettle()
  const scan = (async () => {
    const listed = await listing
    return scanImages(listed)
  })()

  return {
    sourceUrl,
    scan: (async () => {
      try {
        return await scan
      } finally {
        failWaiters(listError ?? new Error('This media reference is not present in the opened Ente album'))
      }
    })(),
    materialize: async (fileId, preview, signal) => {
      const bytes = await decryptFile(fileId, preview, signal)
      return { bytes, mimeType: sniffContentType(bytes) }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      albumKey.fill(0)
      for (const key of keys.values()) key.fill(0)
      keys.clear()
      fileHeaders.clear()
      failWaiters(new Error('This Ente session is closed'))
    },
  }
}
