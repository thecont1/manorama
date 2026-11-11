import { MAX_GALLERY_ITEMS, SourceFetchError, type GalleryImage } from './imagesource'
import { protonIdentityFromUrl, keylessSourceUrl } from '../../packages/core/encrypted-source'
import { displayedImageDimensions } from './image-dims'
import { createScanBudget, ScanBudgetExhausted } from './scan-budget'
import type {
  NodeEntity,
  ProtonDriveAccount,
  ProtonDriveClient,
  ProtonDriveClientContructorParameters,
  ProtonDriveHTTPClient,
} from '@protontech/drive-sdk'

/**
 * Browser/native Proton Drive public-link client, built on
 * @protontech/drive-sdk's anonymous URL-access path — the same path the
 * first-party web app uses. The link's `#password` fragment authenticates
 * and decrypts on-device only; published manifests contain keyless
 * `{urls token, nodeUid}` references.
 *
 *  - Links: drive.proton.me/urls/{token}#{password}. SRP-authenticated
 *    against the token+password, then the share key unwraps node keys
 *    and content locally — Proton's servers only ever see ciphertext.
 *  - Listing: getRootNode() → iterateFolderChildrenNodeUids →
 *    iterateNodes; `mediaType` (a mime string) marks the images.
 *  - Media: getFileDownloader(uid).downloadToStream decrypts AND verifies
 *    blocks into a WritableStream; iterateThumbnails returns decrypted
 *    thumbnail bytes. getSeekableStream does ranged decrypted reads for
 *    the dimension probe.
 *
 * Caveats: the SDK is CJS-only and ships raw-TS crypto deps, so every SDK
 * import stays behind dynamic import() — this file must never enter the
 * Worker graph (the architecture test enforces it). `@protontech/crypto`
 * calls the TC39 array-buffer-base64 methods, which only landed in
 * mid-2025 engines — `ensureUint8ArrayCodecs` shims the three spellings
 * it uses on older WebViews. The `account` module is a throwing stub:
 * nothing on the anonymous public-link read path dereferences it (only
 * share-member management does). Custom-password and legacy (pre-token)
 * links are refused up front via getURLAccessInfo.
 */

// The TC39 Uint8Array base64/hex methods @protontech/crypto calls. The
// ambient declarations keep tsc honest on the package's shipped .ts
// source; the runtime shim covers WebViews older than mid-2025.
declare global {
  interface Uint8ArrayConstructor {
    fromBase64(value: string, options?: { alphabet?: string; lastChunkHandling?: string }): Uint8Array<ArrayBuffer>
    fromHex(value: string): Uint8Array<ArrayBuffer>
  }
  interface Uint8Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
    toBase64(options?: { alphabet?: string; omitPadding?: boolean }): string
    toHex(): string
  }
}

/** Install the TC39 Uint8Array base64/hex methods the crypto package
 *  calls when the engine predates them (WebViews older than mid-2025).
 *  No-ops where the methods already exist. */
const ensureUint8ArrayCodecs = () => {
  const ctor = Uint8Array as unknown as { fromBase64?: (input: string) => Uint8Array }
  if (typeof ctor.fromBase64 !== 'function') {
    ctor.fromBase64 = (input: string) => {
      const binary = atob(input)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
      return out
    }
  }
  const proto = Uint8Array.prototype as unknown as { toBase64?: () => string; toHex?: () => string }
  if (typeof proto.toBase64 !== 'function') {
    proto.toBase64 = function (this: Uint8Array) {
      let binary = ''
      for (const byte of this) binary += String.fromCharCode(byte)
      return btoa(binary)
    }
  }
  if (typeof proto.toHex !== 'function') {
    proto.toHex = function (this: Uint8Array) {
      return [...this].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  }
}

// Accepted formats only, mirroring the MEGA scan: JPEG, WebP, AVIF, HEIC,
// HEIF. PNG/GIF/TIFF/video are consciously ignored — the encrypted
// manifest is a GalleryImage list and Proton video rides its own future
// path (seekable streams serve <video> well enough, but that is out of
// this change's scope).
const IMAGE_MEDIA_TYPES = /^image\/(?:jpeg|webp|avif|hei[cf])$/i
const IMAGE_EXTENSIONS = /\.(?:jpe?g|webp|avif|hei[cf])$/i
// Enough head bytes to find a JPEG SOF marker past typical EXIF APP1 —
// the same window the MEGA head probe reads.
const DIMS_PROBE_BYTES = 65536
// Whole-file ceiling — ciphertext fetch buffer and decrypted plaintext
// coexist in the collector, matching the MEGA/Ente cap.
const MAX_FILE_BYTES = 48 * 1024 * 1024
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
// Client-side scans have no subrequest ceiling; the budgets are backstops
// against runaway fan-out, same posture as the MEGA/Ente clients. JSON
// metadata (auth, listings, node keys, block tokens) spends the scan
// budget — a few calls per node. Binary content (blocks, thumbnails)
// spends the independent media budget so a viewer materializing mid-scan
// can never starve the listing, and a finished scan cannot cap later
// downloads; ~2 thumbnail fetches plus a block chain per item bounds it.
const PROTON_SCAN_REQUEST_BUDGET = MAX_GALLERY_ITEMS * 5
const PROTON_MEDIA_REQUEST_BUDGET = MAX_GALLERY_ITEMS * 16
// The SDK's download queue admits five concurrent file downloads — stay
// inside it so probe batches never block on queue capacity.
const PROBE_BATCH = 5
// A head probe is one block round-trip; the abort also bounds the SDK's
// internal wait for download-queue capacity.
const PROBE_TIMEOUT_MS = 20_000
// Stamped on every request through our ProtonDriveHTTPClient — the
// SDK terms ask third-party clients to identify themselves honestly.
const MANORAMA_SDK_APP_VERSION = '1.0.0'

type ProtonLink = { token: string; password: string }
// The authenticated anonymous share-session client returned by
// experimental.authURLAccess — the class itself is not index-exported,
// so its type is derived from the method signature.
type PublicLinkSession = Awaited<ReturnType<ProtonDriveClient['experimental']['authURLAccess']>>

/** drive.proton.me/urls/{token}#{password} — the password is the
 *  decryption secret and never leaves the session. */
export const extractProtonLink = (input: string): ProtonLink | null => {
  const identity = protonIdentityFromUrl(input)
  if (!identity) return null
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  const password = url.hash.startsWith('#') ? url.hash.slice(1) : ''
  if (!password) return null
  return { token: identity.id, password }
}

type ClaimedAdditionalMetadata = {
  Media?: { Width?: number; Height?: number; Duration?: number }
  Camera?: { Orientation?: number }
}

type ThumbnailListing = { thumbnails?: { uid: string; type: number }[] }

/** The public Revision type omits `thumbnails`, but the runtime entity
 *  carries the list the SDK's own iterateThumbnails filters on. A node
 *  whose share generated no preview has an empty or missing list. */
const thumbnailsFor = (revision: object | undefined) =>
  (revision as ThumbnailListing | undefined)?.thumbnails ?? []

/** Proton stores photo dims in the revision's encrypted extended
 *  attributes. Orientation 5–8 transposes the frame, matching the swap
 *  displayedImageDimensions applies to EXIF bytes. */
const claimedMediaDims = (claimed: object | undefined): { width: number; height: number } | null => {
  const media = (claimed as ClaimedAdditionalMetadata | undefined)?.Media
  const orientation = (claimed as ClaimedAdditionalMetadata | undefined)?.Camera?.Orientation
  const width = media?.Width
  const height = media?.Height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height) return null
  return orientation && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}

/** The node's decrypted display name, or the unverified placeholder the
 *  SDK carries when name decryption fails — trimmed, never an empty
 *  string. */
const nodeName = (node: NodeEntity): string | null => {
  if (node.name.ok) return node.name.value.trim() || null
  const placeholder = (node.name.error as { name?: unknown }).name
  return typeof placeholder === 'string' && placeholder.trim() ? placeholder.trim() : null
}

/** Whether a node belongs in the gallery: its `mediaType` mime wins, with
 *  the filename extension as the fallback for nodes that claim none. */
const isImageNode = (node: NodeEntity, name: string | null): boolean => {
  if (node.mediaType) return IMAGE_MEDIA_TYPES.test(node.mediaType)
  return Boolean(name && IMAGE_EXTENSIONS.test(name))
}

/** A human alt label from a filename: strips the extension, turns
 *  separators into spaces, and falls back to 'Photograph'. */
const filenameLabel = (filename: string) => filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Photograph'

/** Content type from magic bytes — Proton thumbnails carry no declared
 *  mime, so the first four bytes decide. */
const sniffContentType = (bytes: Uint8Array) =>
  bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes[0] === 0x52 && bytes[1] === 0x49 ? 'image/webp'
      : bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : 'application/octet-stream'

/** The slice of @capacitor/core's CapacitorHttp plugin the native
 *  transport needs — structural so a stub can stand in under test. */
type CapacitorHttpRequest = (options: {
  url: string
  method?: string
  headers?: Record<string, string>
  data?: unknown
  responseType?: 'arraybuffer'
}) => Promise<{ status: number; headers: Record<string, string>; data: unknown }>

/** CapacitorHttp drives the native network stack — outside the WebView,
 *  so drive-api.proton.me's CORS rules never apply — but answers with a
 *  bare status/headers envelope whose body arrives base64-encoded; this
 *  folds it back into the fetch/Response shape the SDK's httpClient is
 *  written against. There is no streaming and no real cancellation: an
 *  aborted signal only stops us waiting on a request the native stack may
 *  still finish, which is enough to release the SDK's download-queue
 *  slot. */
export const capacitorHttpFetch = (request: CapacitorHttpRequest): typeof fetch => {
  ensureUint8ArrayCodecs()
  return async (input, init = {}) => {
    const source = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
    const headers: Record<string, string> = {}
    new Headers(source?.headers).forEach((value, key) => { headers[key] = value })
    new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    const signal = init.signal
    if (signal?.aborted) throw signal.reason
    const pending = request({
      url: source?.url ?? String(input),
      method: init.method ?? source?.method ?? 'GET',
      headers,
      data: init.body ?? undefined,
      responseType: 'arraybuffer',
    })
    const response = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
        ])
      : await pending
    const body = response.data instanceof ArrayBuffer
      ? response.data
      : typeof response.data === 'string'
        ? Uint8Array.fromBase64(response.data).buffer as ArrayBuffer
        : new ArrayBuffer(0)
    return new Response(body, { status: response.status, headers: response.headers })
  }
}

/** drive-api.proton.me answers CORS only for drive.proton.me itself — a
 *  fetch from any other origin is refused before it leaves the machine,
 *  and a WKWebView is as much a browser as Safari is. Inside the
 *  Capacitor shell the SDK's calls ride native networking instead, which
 *  knows nothing of CORS; runtimes with no DOM (bun, SSR, tests) enforce
 *  none either. A real browser gets the honest refusal up front rather
 *  than a guaranteed opaque fetch failure. */

/** The verdict `protonTransport` enforces, without the throw — UI surfaces
 *  gate on this to explain the limitation up front instead of letting a
 *  session attempt end at the refusal. Same three runtimes: native shells
 *  and non-DOM environments answer true, a real browser false. */
export const protonTransportAvailable = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return true
  const { Capacitor } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) return true
  return '__TAURI_INTERNALS__' in window
}

const protonTransport = async (): Promise<typeof fetch> => {
  if (typeof window === 'undefined') return fetch
  if (!(await protonTransportAvailable())) {
    throw new SourceFetchError('Proton Drive does not let websites call its API — add this link in the manorama app instead')
  }
  const { Capacitor, CapacitorHttp } = await import('@capacitor/core')
  if (Capacitor.isNativePlatform()) return capacitorHttpFetch((options) => CapacitorHttp.request(options))
  // Tauri's http plugin rides reqwest — the same outside-the-WebView
  // transport CapacitorHttp provides on iOS, so the desktop shell answers
  // links the browser build must refuse.
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch as unknown as typeof fetch
}

export type ProtonScan = { sourceUrl: string; title: string; images: GalleryImage[]; truncated?: number }

export type ProtonClientSession = {
  sourceUrl: string
  /** Folder listing plus dims pass, running in the background. A viewer's
   *  materialize resolves any node in the share once the session is
   *  authed — only manifest submitters wait on `scan`. */
  scan: Promise<ProtonScan>
  materialize(nodeUid: string, preview: boolean, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>
  dispose(): void
}

/** The anonymous URL-access client carries every key inside the SDK
 *  session, so unlike MEGA/Ente there is no per-node key map to feed —
 *  materialize works off whichever uids the caller holds the moment
 *  authURLAccess returns. `fetchImpl` overrides the transport for tests
 *  and harnesses; callers normally leave it to `protonTransport`. */
export const openProtonSession = async (input: string, fetchImpl?: typeof fetch): Promise<ProtonClientSession> => {
  const link = extractProtonLink(input)
  if (!link) throw new Error('Use a complete public Proton Drive link')
  const sourceUrl = keylessSourceUrl(input)
  const sourceUrlWithKey = new URL(input.trim()).toString()

  ensureUint8ArrayCodecs()
  const { ProtonDriveClient, OpenPGPCryptoWithCryptoProxy, MemoryCache, NodeType, ThumbnailType } = await import('@protontech/drive-sdk')
  const { Api: CryptoApi } = await import('@protontech/crypto/proxy/endpoint/api.ts')
  const { CryptoProxy } = await import('@protontech/crypto')
  const { getSrp, computeKeyPassword, generateKeySalt } = await import('@protontech/crypto/srp')

  const transport = fetchImpl ?? (await protonTransport())
  // JSON metadata rides the scan budget; binary content rides the media
  // budget. The SDK splits its calls the same way — fetchJson for API
  // requests, fetchBlob for block-stream and thumbnail downloads.
  const scanFetch = createScanBudget(PROTON_SCAN_REQUEST_BUDGET).fetch(transport)
  const mediaFetch = createScanBudget(PROTON_MEDIA_REQUEST_BUDGET).fetch(transport)
  /** Every request rides this client, which stamps the honest third-party
   *  identity the SDK terms ask for, honours the SDK's own timeouts, and
   *  spends the caller's request budget. */
  const protonFetch = (meteredFetch: typeof fetch) => (request: { url: string; method: string; headers: Headers; json?: object; body?: XMLHttpRequestBodyInit; timeoutMs: number; signal?: AbortSignal }): Promise<Response> => {
    const headers = new Headers(request.headers)
    headers.set('x-pm-appversion', `external-drive-manorama@${MANORAMA_SDK_APP_VERSION}-stable`)
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
      : AbortSignal.timeout(request.timeoutMs)
    return meteredFetch(request.url, {
      method: request.method,
      headers,
      body: request.json ? JSON.stringify(request.json) : request.body,
      signal,
    })
  }
  const httpClient: ProtonDriveHTTPClient = {
    fetchJson: protonFetch(scanFetch),
    fetchBlob: protonFetch(mediaFetch),
  }

  // Anonymous sessions have no account: every account method throws if a
  // code path ever reaches for one (only share-member management does —
  // nothing on the public-link read path).
  const account: ProtonDriveAccount = {
    getOwnPrimaryAddress: () => Promise.reject(new Error('anonymous')),
    getOwnAddresses: () => Promise.reject(new Error('anonymous')),
    getOwnAddress: () => Promise.reject(new Error('anonymous')),
    hasProtonAccount: () => Promise.reject(new Error('anonymous')),
    getPublicKeys: () => Promise.reject(new Error('anonymous')),
  }

  type SRPModule = ProtonDriveClientContructorParameters['srpModule']
  // The SDK's SRPModule is positional; @protontech/crypto's getSrp takes
  // AuthInfo/AuthCredentials objects. Public-link SRP carries no username
  // (only auth versions ≤2 check one). getSrpVerifier is only called to
  // SET a link password — an account-write that can never happen here.
  const srpModule: SRPModule = {
    getSrp: async (version, modulus, serverEphemeral, salt, password) => {
      const proofs = await getSrp(
        { Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
        { password },
        version,
      )
      return { expectedServerProof: proofs.expectedServerProof, clientProof: proofs.clientProof, clientEphemeral: proofs.clientEphemeral }
    },
    getSrpVerifier: () => Promise.reject(new Error('anonymous')),
    computeKeyPassword,
    generateKeySalt,
  }

  CryptoApi.init({})
  const cryptoApi = new CryptoApi()
  // The SRP helpers go through the global CryptoProxy singleton — point it
  // at our main-thread endpoint (the SDK's own integration test wires the
  // Api class the same way; a worker pool would need bundler-worker plumbing
  // for no benefit on this path). The singleton survives the session that
  // set it — dispose flips only a flag — and setEndpoint refuses a second
  // set with 'already initialised', so a parked or failed session's hold
  // must be released before a retry can open.
  try { CryptoProxy.releaseEndpoint() } catch { /* nothing held yet */ }
  CryptoProxy.setEndpoint(cryptoApi)
  const client = new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(cryptoApi),
    srpModule,
  })

  let disposed = false

  const info = await client.experimental.getURLAccessInfo(sourceUrlWithKey)
  if (info.isLegacy) throw new SourceFetchError('That Proton Drive link is no longer supported by Proton', 410)
  if (info.isCustomPasswordProtected) {
    throw new SourceFetchError('That Proton Drive link is password-protected — password-protected links are not supported yet', 403)
  }
  const session = await client.experimental.authURLAccess(sourceUrlWithKey, undefined, true)

  const nodes = new Map<string, NodeEntity>()

  /** Walk the share: root node (folder or single file), then every
   *  descendant, keeping file nodes whose mediaType is a supported image
   *  and caching entities for later materialize calls. */
  const collectNodes = async (linkClient: PublicLinkSession): Promise<{ title: string; files: NodeEntity[]; foundTotal: number }> => {
    const root = await linkClient.getRootNode()
    const title = nodeName(root) ?? 'Untitled gallery'
    // A share can anchor on a single file as well as a folder.
    if (root.type === NodeType.File) {
      const name = nodeName(root)
      const files = isImageNode(root, name) ? [root] : []
      for (const file of files) nodes.set(file.uid, file)
      return { title, files, foundTotal: files.length }
    }
    const uids: string[] = []
    for await (const uid of linkClient.iterateFolderChildrenNodeUids(root.uid)) {
      if (disposed) throw new Error('This Proton Drive session is closed')
      uids.push(uid)
    }
    const files: NodeEntity[] = []
    for await (const node of linkClient.iterateNodes(uids)) {
      if (disposed) throw new Error('This Proton Drive session is closed')
      // A node the share no longer serves arrives as { missingUid }.
      if (!('uid' in node)) continue
      if (node.type !== NodeType.File) continue
      const name = nodeName(node)
      if (!isImageNode(node, name)) continue
      nodes.set(node.uid, node)
      files.push(node)
    }
    if (files.length > MAX_GALLERY_ITEMS) {
      throw new SourceFetchError(`That Proton Drive link has ${files.length.toLocaleString()} images — galleries are limited to ${MAX_GALLERY_ITEMS.toLocaleString()} items`, 422)
    }
    return { title, files, foundTotal: files.length }
  }

  /** The scanned entity when listed, a live lookup otherwise — manifest
   *  submitters only ever materialize scanned nodes. */
  const nodeEntity = async (uid: string): Promise<NodeEntity> => nodes.get(uid) ?? session.getNode(uid)

  /** Ranged decrypted head read — the same trick as the MEGA head probe:
   *  enough of the original to read honest dimensions without fetching
   *  the file. getSeekableStream skips integrity verification, which is
   *  fine for a dims window (downloadToStream verifies on real fetch). */
  const probeDimensions = async (node: NodeEntity): Promise<{ width: number; height: number }> => {
    const claimed = claimedMediaDims(node.activeRevision?.claimedAdditionalMetadata)
    if (claimed) return claimed
    for (let attempt = 0; attempt < 2; attempt++) {
      // A FileDownloader holds a download-queue slot until its stream is
      // finished or its signal aborts. The seekable stream locks a reader
      // in its constructor, so stream.cancel() throws "ReadableStream is
      // locked" — aborting is the only release path. The SDK's internal
      // wait for queue capacity does NOT reliably settle on abort, so the
      // whole probe races the signal — a parked queue-wait drops out at
      // the timeout instead of starving every later downloader (viewer
      // media included) on the same queue.
      const probe = new AbortController()
      const timeout = setTimeout(() => probe.abort(), PROBE_TIMEOUT_MS)
      try {
        const { value } = await Promise.race([
          (async () => {
            const downloader = await session.getFileDownloader(node.uid, probe.signal)
            const stream = downloader.getSeekableStream()
            return stream.read(DIMS_PROBE_BYTES)
          })(),
          new Promise<never>((_resolve, reject) => {
            probe.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          }),
        ])
        const dims = displayedImageDimensions(value)
        if (dims) return dims
        break
      } catch (error) {
        if (error instanceof ScanBudgetExhausted) throw error
        // Dimensions are a nicety — never fail a scan over them.
      } finally {
        clearTimeout(timeout)
        probe.abort()
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return { width: 4, height: 3 }
  }

  /** Build the GalleryImage for a scanned file node: keyless proton ref,
   *  sha-256 contentVersion over identity inputs, and a thumbnail variant
   *  materialized lazily by node uid — same shape as Ente. */
  const makeImage = async (node: NodeEntity, index: number, width: number, height: number): Promise<GalleryImage> => {
    const name = nodeName(node) ?? `photo-${index + 1}.jpg`
    const media = { kind: 'encrypted' as const, provider: 'proton' as const, sourceKind: 'urls' as const, sourceId: link.token, nodeId: node.uid, previewId: node.uid }
    const versionInput = new TextEncoder().encode(JSON.stringify({
      uid: node.uid,
      rev: node.activeRevision?.uid ?? null,
      mod: node.modificationTime?.toISOString?.() ?? null,
      size: node.activeRevision?.claimedSize ?? null,
    }))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', versionInput))
    versionInput.fill(0)
    return {
      id: `proton-${node.uid.replace(/[^a-zA-Z0-9]+/g, '').slice(-18) || index + 1}`,
      ref: node.uid,
      filename: name,
      src: '',
      media,
      contentVersion: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      fidelity: 'original',
      thumbnailFidelity: 'display-derivative',
      // The decrypted thumbnail stands in as the rail image — fetched by
      // node uid through materialize(preview), same shape as Ente. Only
      // advertised when the share actually generated one: Proton creates
      // thumbnails on some upload paths only, and a variant without a
      // backing thumbnail leaves the rail permanently blank instead of
      // falling back to the (heavier) original — the MEGA no-attribute rule.
      ...(thumbnailsFor(node.activeRevision).length ? { variants: [{ width, src: '', media, format: 'jpeg' }] } : {}),
      width,
      height,
      alt: filenameLabel(name),
      // Block downloads verify signatures as they decrypt — the bytes are
      // the originals, so embedded credentials survive.
      c2pa: true,
      placeholder: `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'%3E%3Crect width='100%25' height='100%25' fill='%23111212'/%3E%3C/svg%3E`,
    }
  }

  /** The dims pass over the listing, batched to the download queue's
   *  capacity — exhausted budgets truncate rather than fail the scan. */
  const scanImages = async (listed: { title: string; files: NodeEntity[]; foundTotal: number }): Promise<ProtonScan> => {
    const images: GalleryImage[] = []
    let exhausted = false
    for (let i = 0; i < listed.files.length && !exhausted; i += PROBE_BATCH) {
      if (disposed) throw new Error('This Proton Drive session is closed')
      const batch = await Promise.all(listed.files.slice(i, i + PROBE_BATCH).map(async (node, j) => {
        try {
          const dims = await probeDimensions(node)
          return await makeImage(node, i + j, dims.width, dims.height)
        } catch (error) {
          if (error instanceof ScanBudgetExhausted) { exhausted = true; return null }
          throw error
        }
      }))
      images.push(...batch.filter((image): image is GalleryImage => image !== null))
    }
    if (!images.length) throw new Error('No image files were found in that public Proton Drive link')
    const truncated = exhausted ? listed.foundTotal : undefined
    return { sourceUrl, title: listed.title, images, ...(truncated ? { truncated } : {}) }
  }

  /** A WritableStream that accumulates decrypted chunks and enforces the
   *  whole-file byte ceiling and abort — downloadToStream writes into it. */
  const collectDownloaded = (signal?: AbortSignal): { stream: WritableStream<Uint8Array>; bytes: () => Uint8Array } => {
    const chunks: Uint8Array[] = []
    let total = 0
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        total += chunk.byteLength
        if (total > MAX_FILE_BYTES) throw new SourceFetchError('That Proton Drive image is too large to open', 413)
        chunks.push(chunk)
      },
    })
    return {
      stream,
      bytes: () => {
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
        return out
      },
    }
  }

  // The scan — listing plus the dims probe pass — exists for manifest
  // submitters. Viewers materialize off the authed session alone, so the
  // listing defers until first awaited: an open that only needs media never
  // pays the probe pass or risks its downloader waits starving first paint.
  let scanPromise: Promise<ProtonScan> | null = null
  const scan = {
    then: <TResult1 = ProtonScan, TResult2 = never>(
      onFulfilled?: ((value: ProtonScan) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => (scanPromise ??= (async () => scanImages(await collectNodes(session)))()).then(onFulfilled, onRejected),
  } as Promise<ProtonScan>

  return {
    sourceUrl,
    scan,
    async materialize(nodeUid, preview, signal) {
      if (disposed) throw new Error('This Proton Drive session is closed')
      if (preview) {
        for (const type of [ThumbnailType.Type1, ThumbnailType.Type2]) {
          for await (const result of session.iterateThumbnails([nodeUid], type, signal)) {
            if (result.nodeUid !== nodeUid || !result.ok) continue
            if (result.thumbnail.byteLength > MAX_PREVIEW_BYTES) throw new SourceFetchError('That Proton Drive preview is too large to open', 413)
            return { bytes: result.thumbnail, mimeType: sniffContentType(result.thumbnail) }
          }
        }
        // No thumbnail this share can serve — not an error. Manifests
        // written before variants became conditional still point the rail
        // here; fall through to the original so the cell fills, matching
        // the MEGA manifest's answer to a node with no file attribute.
      }
      const node = await nodeEntity(nodeUid)
      const claimed = node.activeRevision?.claimedSize
      if (claimed && claimed > MAX_FILE_BYTES) throw new SourceFetchError('That Proton Drive image is too large to open', 413)
      const downloader = await session.getFileDownloader(nodeUid, signal)
      const collector = collectDownloaded(signal)
      const controller = downloader.downloadToStream(collector.stream)
      try {
        await controller.completion()
      } catch (error) {
        if (disposed) throw new Error('This Proton Drive session is closed')
        throw error
      }
      const bytes = collector.bytes()
      return { bytes, mimeType: node.mediaType && node.mediaType.startsWith('image/') ? node.mediaType : sniffContentType(bytes) }
    },
    dispose() {
      disposed = true
    },
  }
}
