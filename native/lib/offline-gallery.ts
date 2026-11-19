import type { GalleryImage, GalleryManifest, GalleryMediaItem, ImageVariant, VideoItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import { NativeGalleryHttpError, type NativeGalleryResponse } from './api'
import type { VaultLoadPolicy } from './vault-settings'
import { thumbnailEntryId, videoEntryId } from './thumbs'
import { localComputeEntryId } from './local-compute'
import type { EncryptedVault, VaultEpoch } from './vault'
import { productionVault } from './vault'
import { EncryptedMediaResolver, type EncryptedClientSession } from '../../app/lib/encrypted-resolver'
import { EncryptedSourceLockedError, EncryptedSourceMismatchError, persistEncryptedSourceForSelection } from './encrypted-gallery'
import { nativeGalleryKeyStore } from './gallery-key-store'
import type { CacheFillItem } from './cache-fill'
import { cacheFillRegistry } from './cache-fill'
import { keylessSourceUrl, manifestIsEncryptedSource } from '../../packages/core/encrypted-source'

const METADATA_VERSION = 1
const METADATA_ENTRY_ID = 'offline-gallery:metadata:v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type GallerySelection = { owner: string; slug: string; galleryId?: string; sourceUrl?: string }
export type OfflineCacheResult =
  | { status: 'complete'; images: number }
  | { status: 'skipped-encrypted'; images: 0 }
  | { status: 'over-cap'; images: number }

export type OfflineCacheProgress = { completed: number; total: number }

/** Per-item fill descriptor, emitted right after each successful vault write
 *  so Library rail cells can trade a provider preview for saved bytes as they
 *  land rather than waiting for the whole gallery to commit. */
export type OfflineCacheItemReady = CacheFillItem

export type OfflineCacheInspection =
  | { status: 'complete'; images: number }
  | { status: 'missing' | 'incomplete' | 'corrupt'; images: 0 }

export type OfflineGalleryLease = NativeGalleryResponse & {
  source: 'offline'
  /** The committed manifest verbatim — provider refs intact, before the
   *  lease rewrote every src to a decrypted object URL. A revalidator diffs
   *  it against the fresh network manifest to tell a real change from a
   *  same-bytes re-open. */
  committedManifest: GalleryManifest
  dispose(): void
}

/** What the settings/catalog surfaces may know about a cached gallery:
 *  identity from the vault, title and counts from decrypted metadata. */
export type OfflineGallerySummary =
  | { status: 'cached'; galleryId: string; owner: string; slug: string; title: string; images: number }
  | { status: 'corrupt'; galleryId: string }

/** A frame-level catalog entry for the global grid: honest dimensions and alt
 *  from the manifest, vault addressing from the cached-image record. No object
 *  URLs are minted here — the grid materializes them lazily per visible cell. */
export type OfflineGridFrame = {
  id: string
  entryId: string
  mimeType: string
  /** From the manifest item's `type`, never the cached mimeType — the still
   *  a video caches under is image/jpeg and would miscount as a photo. */
  video: boolean
  width: number
  height: number
  alt: string
  index: number
}

export type OfflineGridGallery = {
  galleryId: string
  owner: string
  slug: string
  title: string
  frames: OfflineGridFrame[]
}

export interface OfflineGalleryStore {
  cache(selection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal, onProgress?: (progress: OfflineCacheProgress) => void, onItemReady?: (item: OfflineCacheItemReady) => void, encryptedSession?: EncryptedClientSession): Promise<OfflineCacheResult>
  inspect(selection: GallerySelection): Promise<OfflineCacheInspection>
  open(selection: GallerySelection): Promise<OfflineGalleryLease | undefined>
  invalidate(selection: GallerySelection): Promise<void>
  /** Every gallery the vault knows about, including ones whose metadata is
   *  missing or unreadable — those are listed as corrupt so they stay purgeable. */
  listGalleries(): Promise<OfflineGallerySummary[]>
  /** Frame catalog for one cached gallery; undefined when its metadata is
   *  missing, corrupt, or still in flight (cache fills write metadata last). */
  gridGallery(galleryId: string): Promise<OfflineGridGallery | undefined>
  /** Frame catalogs for every readable cached gallery; corrupt entries are
   *  skipped rather than listed because their frames cannot be addressed. */
  listGridGalleries(): Promise<OfflineGridGallery[]>
  /** Decrypted thumbnail bytes for one frame. Reads do not touch the LRU:
   *  scanning the grid visits every gallery, and counting that as use would
   *  flush the eviction signal a purge-cap decision relies on. */
  readThumbnail(galleryId: string, entryId: string): Promise<Uint8Array | undefined>
  /** Purge one gallery by vault identity and release its live object URLs. */
  purgeGallery(galleryId: string): Promise<void>
  /** Cryptographic erasure of every cached gallery and every live object URL. */
  purgeAll(): Promise<void>
}

export type OfflineFetchResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer' | 'body'>
export type OfflineImageFetch = (input: string, init?: RequestInit) => Promise<OfflineFetchResponse>
export interface OfflineObjectUrlProvider {
  /** Implementations must snapshot bytes before returning; the store wipes them immediately. */
  create(bytes: Uint8Array, mimeType: string): string
  revoke(url: string): void
}

type OfflineVault = Pick<EncryptedVault, 'read' | 'readMany' | 'write' | 'remove' | 'clearGallery' | 'clear' | 'epoch' | 'listGalleryIds' | 'touch' | 'cap'>

/** The overhead write() adds to every entry — record header, nonce and GCM
 *  tag (HEADER_BYTES + NONCE_BYTES + TAG_BYTES in vault.ts). A body that
 *  would pack over the cap is rejected before it is fully buffered. */
const VAULT_RECORD_OVERHEAD_BYTES = 40

/** The plaintext ceiling a single vault entry accepts. A null cap means the
 *  vault is unbounded and so is the body. */
const vaultEntryPlaintextLimit = (vault: OfflineVault): number | null =>
  vault.cap === null ? null : Math.max(0, vault.cap - VAULT_RECORD_OVERHEAD_BYTES)
/** One record per manifest item, index-aligned with `manifest.images` —
 *  `gridGallery` zips them positionally. `entryId` always holds the still
 *  bytes (the image itself, or a video's poster); `videoEntryId` appears
 *  only on video items and holds the MP4. */
type CachedImage = { id: string; entryId: string; mimeType: string; videoEntryId?: string; videoMimeType?: string }
type OfflineMetadata = {
  version: typeof METADATA_VERSION
  owner: string
  slug: string
  manifest: GalleryManifest
  settings: GallerySettings
  images: CachedImage[]
}

type MetadataRead =
  | { status: 'ready'; value: OfflineMetadata }
  | { status: 'missing' | 'corrupt' }

const defaultFetch: OfflineImageFetch = (input, init) => fetch(input, init)
const defaultObjectUrls: OfflineObjectUrlProvider = {
  create(bytes, mimeType) {
    return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }))
  },
  revoke(url) {
    URL.revokeObjectURL(url)
  },
}

const normalizedSelection = (selection: GallerySelection): GallerySelection => ({
  owner: selection.owner.trim(),
  slug: selection.slug.trim(),
  ...(selection.galleryId ? { galleryId: selection.galleryId } : {}),
  ...(selection.sourceUrl ? { sourceUrl: selection.sourceUrl } : {}),
})

const requireSelection = (selection: GallerySelection): GallerySelection => {
  const normalized = normalizedSelection(selection)
  if (!normalized.owner || !normalized.slug) throw new Error('Offline gallery identity is incomplete')
  return normalized
}

/** The vault index sees only this digest; owner and slug remain inside encrypted metadata. */
export const offlineGalleryId = async (selection: GallerySelection): Promise<string> => {
  const { owner, slug } = requireSelection(selection)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${owner}\u0000${slug}`)))
  return `offline-gallery:v1:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export const openNativeEncryptedSession = async (selection: GallerySelection, compareWith?: string): Promise<EncryptedClientSession> => {
  const sourceUrl = selection.sourceUrl ?? (selection.galleryId ? await nativeGalleryKeyStore().get(selection.galleryId) : null)
  if (!sourceUrl) throw new EncryptedSourceLockedError()
  // A fragment that names a different album must never be adopted into this
  // gallery's custody — compare keyless identities before any decrypt or put.
  if (compareWith !== undefined && keylessSourceUrl(sourceUrl) !== keylessSourceUrl(compareWith)) {
    throw new EncryptedSourceMismatchError()
  }
  const { openEncryptedSource } = await import('../../app/lib/encrypted-client')
  const session = await openEncryptedSource(sourceUrl)
  // Only now adopt the key: custody requires both the fragment and the
  // published manifest agreeing on which source this gallery is.
  if (selection.sourceUrl && selection.galleryId) {
    await persistEncryptedSourceForSelection(selection.galleryId, selection.sourceUrl).catch(() => undefined)
  }
  return session
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

const variantsValid = (value: Record<string, unknown>): boolean =>
  value.variants === undefined || (Array.isArray(value.variants) && value.variants.every((variant) =>
    isRecord(variant) && Number.isFinite(variant.width) && Number(variant.width) > 0 &&
    typeof variant.src === 'string' && typeof variant.format === 'string'))

const isStillItem = (value: unknown): value is GalleryImage => {
  if (!isRecord(value) || (value.type !== undefined && value.type !== 'image')) return false
  return variantsValid(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.filename === 'string' && typeof value.src === 'string' &&
    Number.isFinite(value.width) && Number(value.width) > 0 &&
    Number.isFinite(value.height) && Number(value.height) > 0 &&
    typeof value.alt === 'string' && typeof value.c2pa === 'boolean' &&
    typeof value.placeholder === 'string'
}

const isVideoManifestItem = (value: unknown): value is VideoItem => {
  if (!isRecord(value) || value.type !== 'video') return false
  const poster = value.poster
  return variantsValid(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.filename === 'string' && typeof value.src === 'string' &&
    value.mimeType === 'video/mp4' &&
    Number.isFinite(value.width) && Number(value.width) > 0 &&
    Number.isFinite(value.height) && Number(value.height) > 0 &&
    typeof value.alt === 'string' && value.c2pa === false &&
    typeof value.placeholder === 'string' &&
    isRecord(poster) && typeof poster.src === 'string' &&
    Number.isFinite(poster.width) && Number(poster.width) > 0 &&
    Number.isFinite(poster.height) && Number(poster.height) > 0
}

const isManifest = (value: unknown): value is GalleryManifest => {
  if (!isRecord(value) || typeof value.slug !== 'string' || typeof value.title !== 'string' ||
    typeof value.caption !== 'string' || typeof value.date !== 'string' || !Array.isArray(value.images) ||
    value.images.length === 0 || !value.images.every((item) => isStillItem(item) || isVideoManifestItem(item))) return false
  const ids = value.images.map((item) => item.id)
  return new Set(ids).size === ids.length
}

const isSettings = (value: unknown): value is GallerySettings => {
  if (!isRecord(value)) return false
  return typeof value.title === 'string' && typeof value.caption === 'string' &&
    typeof value.date === 'string' && typeof value.curtainKicker === 'string' &&
    typeof value.curtainPrompt === 'string' &&
    (value.defaultMode === 'strip' || value.defaultMode === 'vertical' || value.defaultMode === 'single') &&
    typeof value.defaultShowCaptions === 'boolean' && typeof value.defaultShowArrows === 'boolean' &&
    isStringRecord(value.imageCaptions) && isStringRecord(value.imageAlts)
}

/** Structural validation without a claimed identity: the catalog reads owner
 *  and slug out of the encrypted record rather than comparing against one. */
const isMetadataRecord = (value: unknown): value is OfflineMetadata => {
  if (!isRecord(value) || value.version !== METADATA_VERSION ||
    typeof value.owner !== 'string' || value.owner.length === 0 ||
    typeof value.slug !== 'string' || value.slug.length === 0) return false
  const manifest = value.manifest
  if (!isManifest(manifest) || !isSettings(value.settings) || !Array.isArray(value.images) ||
    value.images.length !== manifest.images.length) return false
  return value.images.every((candidate, index) => {
    if (!isRecord(candidate)) return false
    const manifestImage = manifest.images[index]
    if (candidate.id !== manifestImage?.id || candidate.entryId !== thumbnailEntryId(manifestImage.id) ||
      typeof candidate.mimeType !== 'string' || candidate.mimeType.length === 0) return false
    if (isVideoItem(manifestImage)) {
      return candidate.videoEntryId === videoEntryId(manifestImage.id) &&
        typeof candidate.videoMimeType === 'string' && candidate.videoMimeType.length > 0
    }
    return candidate.videoEntryId === undefined && candidate.videoMimeType === undefined
  })
}

const isMetadata = (value: unknown, selection: GallerySelection): value is OfflineMetadata =>
  isMetadataRecord(value) && value.owner === selection.owner && value.slug === selection.slug

/** The vault stores the original bytes, never a rendition — the offline copy
 *  is the offline viewing experience, and a photography product does not
 *  promise thumbnail-quality frames. Variants exist for thumbs and rails;
 *  they are not what gets vaulted. */
export const offlineSourceFor = (image: GalleryImage): { src: string; format?: string } => ({ src: image.src })

const mimeFromFormat = (format?: string): string | undefined => {
  const normalized = format?.toLowerCase().replace(/^image\//, '')
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg'
  if (normalized === 'heic' || normalized === 'heif') return `image/${normalized}`
  if (normalized && ['png', 'webp', 'avif', 'gif'].includes(normalized)) return `image/${normalized}`
  return undefined
}

const mimeFromFilename = (filename: string): string | undefined => {
  const extension = filename.split('.').pop()?.toLowerCase()
  return mimeFromFormat(extension)
}

const responseMimeType = (response: OfflineFetchResponse, image: Pick<GalleryMediaItem, 'filename'>, format?: string): string => {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (header && !header.startsWith('image/') && header !== 'application/octet-stream') {
    throw new Error(`Offline image response was not an image (${header})`)
  }
  return header?.startsWith('image/') ? header : mimeFromFormat(format) ?? mimeFromFilename(image.filename) ?? 'application/octet-stream'
}

/** The video fetch's counterpart: the manifest already declares MP4, so an
 *  honest header is confirmed and anything else falls back to it. */
const videoMimeTypeOf = (response: OfflineFetchResponse, item: VideoItem): string => {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (header && !header.startsWith('video/') && header !== 'application/octet-stream') {
    throw new Error(`Offline video response was not a video (${header})`)
  }
  return header?.startsWith('video/') ? header : item.mimeType
}

/** What a fill compares against the committed manifest before reusing
 *  vaulted bytes: `contentVersion` for encrypted refs, the byte sources
 *  otherwise — a video only counts as unchanged when both its MP4 and its
 *  poster match. */
const srcIdentityOf = (item: GalleryMediaItem | undefined): string => {
  if (!item) return ''
  if (!isVideoItem(item) && item.media?.kind === 'encrypted' && typeof item.contentVersion === 'string') return `enc:${item.contentVersion}`
  if (isVideoItem(item)) return `video:${item.src}|poster:${item.poster.src}`
  return item.src
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export class EncryptedOfflineGalleryStore implements OfflineGalleryStore {
  private readonly vault: OfflineVault
  private readonly fetchImage: OfflineImageFetch
  private readonly objectUrls: OfflineObjectUrlProvider
  private readonly openEncrypted?: (selection: GallerySelection) => Promise<EncryptedClientSession>
  /** Live decrypted object URLs, by gallery. A confirmed purge revokes them so
   *  "erased" never leaves a readable copy held by an open lease. */
  private readonly liveUrls = new Map<string, Set<string>>()

  constructor(options: {
    vault: OfflineVault
    fetchImage?: OfflineImageFetch
    objectUrls?: OfflineObjectUrlProvider
    openEncryptedSession?: (selection: GallerySelection) => Promise<EncryptedClientSession>
  }) {
    this.vault = options.vault
    this.fetchImage = options.fetchImage ?? defaultFetch
    this.objectUrls = options.objectUrls ?? defaultObjectUrls
    this.openEncrypted = options.openEncryptedSession
  }

  private async openEncryptedSession(selection: GallerySelection): Promise<EncryptedClientSession> {
    if (this.openEncrypted) return this.openEncrypted(selection)
    return openNativeEncryptedSession(selection)
  }

  private trackUrl(galleryId: string, url: string): void {
    let urls = this.liveUrls.get(galleryId)
    if (!urls) this.liveUrls.set(galleryId, (urls = new Set()))
    urls.add(url)
  }

  private releaseUrls(galleryId?: string): void {
    const release = (urls: Set<string>) => { for (const url of urls) this.objectUrls.revoke(url) }
    if (galleryId === undefined) {
      for (const urls of this.liveUrls.values()) release(urls)
      this.liveUrls.clear()
      return
    }
    const urls = this.liveUrls.get(galleryId)
    if (urls) {
      release(urls)
      this.liveUrls.delete(galleryId)
    }
  }

  private untrackUrl(galleryId: string, url: string): void {
    const urls = this.liveUrls.get(galleryId)
    if (!urls) return
    urls.delete(url)
    if (urls.size === 0) this.liveUrls.delete(galleryId)
  }

  private async readMetadata(selection: GallerySelection, galleryId: string, touch = true): Promise<MetadataRead> {
    const bytes = await this.vault.read(galleryId, METADATA_ENTRY_ID, { touch })
    if (!bytes) return { status: 'missing' }
    try {
      const value: unknown = JSON.parse(decoder.decode(bytes))
      if (isMetadata(value, selection)) return { status: 'ready', value }
      await this.vault.remove(galleryId, METADATA_ENTRY_ID)
      return { status: 'corrupt' }
    } catch {
      await this.vault.remove(galleryId, METADATA_ENTRY_ID)
      return { status: 'corrupt' }
    } finally {
      bytes.fill(0)
    }
  }

  /** Catalog read: no identity claim, no LRU touch, and no cleanup side
   *  effects — a corrupt record is reported, not silently deleted. */
  private async readMetadataById(galleryId: string): Promise<MetadataRead> {
    const bytes = await this.vault.read(galleryId, METADATA_ENTRY_ID, { touch: false })
    if (!bytes) return { status: 'missing' }
    try {
      const value: unknown = JSON.parse(decoder.decode(bytes))
      return isMetadataRecord(value) ? { status: 'ready', value } : { status: 'corrupt' }
    } catch {
      return { status: 'corrupt' }
    } finally {
      bytes.fill(0)
    }
  }

  async cache(rawSelection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal, onProgress?: (progress: OfflineCacheProgress) => void, onItemReady?: (item: OfflineCacheItemReady) => void, sharedSession?: EncryptedClientSession): Promise<OfflineCacheResult> {
    let sessionPromise: Promise<EncryptedClientSession> | undefined
    const openSession = () => {
      if (sharedSession) return Promise.resolve(sharedSession)
      sessionPromise ??= this.openEncryptedSession(rawSelection)
      return sessionPromise
    }
    // The fill invalidates the commit record before writing a byte; it
    // hands that record out through onInvalidated so a transient failure
    // can restore it instead of leaving a healthy copy commit-less.
    const stashed: { current: { metadata: OfflineMetadata; since: VaultEpoch } | null } = { current: null }
    try {
      const result = await this.cacheFill(rawSelection, gallery, openSession, signal, onProgress, onItemReady, (metadata, since) => { stashed.current = { metadata, since } })
      stashed.current = null
      return result
    } catch (error) {
      // The replacement was never published — restore the record the fill's
      // invalidation step stashed so the kept copy stays honest at its last
      // version. The stashed epoch is stale after a purge or a newer fill,
      // so an authoritative removal can never be quietly resurrected.
      const galleryId = await offlineGalleryId(requireSelection(rawSelection)).catch(() => null)
      if (galleryId && stashed.current) {
        const priorBytes = encoder.encode(JSON.stringify(stashed.current.metadata))
        try {
          await this.vault.write(galleryId, METADATA_ENTRY_ID, priorBytes, { since: stashed.current.since })
        } catch { /* a purge or newer fill owns this vault now */ }
        finally { priorBytes.fill(0) }
      }
      throw error
    } finally {
      if (!sharedSession && sessionPromise) (await sessionPromise).dispose()
    }
  }

  /** Reads a video body with the vault's own entry ceiling: an honest
   *  Content-Length over the limit fails before any byte is buffered, and a
   *  body without one is cut off the moment it exceeds it. */
  private async readBoundedBody(response: OfflineFetchResponse, signal?: AbortSignal): Promise<Uint8Array> {
    const limit = vaultEntryPlaintextLimit(this.vault)
    if (limit === null) return new Uint8Array(await response.arrayBuffer())
    const oversize = () => new Error('Offline video is larger than one vault entry can hold')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) throw oversize()
    const stream = response.body
    if (!stream) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > limit) throw oversize()
      return bytes
    }
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    try {
      for (;;) {
        throwIfAborted(signal)
        const { done, value } = await reader.read()
        if (done) break
        received += value?.length ?? 0
        if (received > limit) throw oversize()
        if (value) chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  }

  /** Every entry a commit is about to advertise must still be in the vault —
   *  a write's LRU pass can evict an earlier entry of the same fill. */
  private async entriesPresent(galleryId: string, images: readonly CachedImage[]): Promise<boolean> {
    for (const image of images) {
      for (const entryId of image.videoEntryId ? [image.entryId, image.videoEntryId] : [image.entryId]) {
        const bytes = await this.vault.read(galleryId, entryId, { touch: false })
        if (!bytes) return false
        bytes.fill(0)
      }
    }
    return true
  }

  private async cacheFill(rawSelection: GallerySelection, gallery: NativeGalleryResponse, openSession: () => Promise<EncryptedClientSession>, signal?: AbortSignal, onProgress?: (progress: OfflineCacheProgress) => void, onItemReady?: (item: OfflineCacheItemReady) => void, onInvalidated?: (prior: OfflineMetadata, since: VaultEpoch) => void): Promise<OfflineCacheResult> {
    // Captured synchronously at call time, before the gallery ID resolves: a
    // purge bumps the vault's mutation epoch inside its serialized boundary,
    // and every write below hands back the epoch this fill started under. A
    // confirmed purge can never be followed by a stale fill quietly
    // repopulating the vault — the fill dies on its next write instead.
    const guard = { since: this.vault.epoch() }
    const selection = requireSelection(rawSelection)
    // A *legacy* encrypted manifest names an encrypted source but carries
    // only server-mediated refs — the web handles those galleries, and a
    // fill starting here would fail after the commit record was removed
    // and orphan a healthy vaulted copy. Version-2 media refs materialize
    // in the loop below through the client session. No vault state is
    // touched by this early return.
    const legacyEncrypted = manifestIsEncryptedSource(gallery.manifest) &&
      !gallery.manifest.images.some((image) => !isVideoItem(image) && image.media?.kind === 'encrypted')
    if (legacyEncrypted) return { status: 'skipped-encrypted', images: 0 }
    const galleryId = await offlineGalleryId(selection)
    // Read the prior record before invalidating it: the stored manifest's
    // src is the only validator for reused bytes (a replaced photo arrives
    // with a new source URL under the same image ID), and its committed
    // MIME survives reuse instead of being re-derived from the filename.
    const prior = await this.readMetadataById(galleryId)
    const priorCachedById = new Map<string, CachedImage>()
    const priorManifestById = new Map<string, GalleryMediaItem>()
    if (prior.status === 'ready') {
      prior.value.images.forEach((priorImage, index) => {
        priorCachedById.set(priorImage.id, priorImage)
        const priorManifestImage = prior.value.manifest.images[index]
        if (priorManifestImage) priorManifestById.set(priorManifestImage.id, priorManifestImage)
      })
    }
    // Invalidate the commit record first. A failed refresh may leave encrypted
    // bytes behind, but they can never be mistaken for a complete gallery —
    // and the record itself goes out through onInvalidated so the caller can
    // restore it if this fill dies before publishing its replacement.
    if (prior.status === 'ready') onInvalidated?.(prior.value, guard.since)
    await this.vault.remove(galleryId, METADATA_ENTRY_ID)
    const items = gallery.manifest.images
    if (items.length === 0) throw new Error('An empty gallery cannot be cached offline')
    if (new Set(items.map((image) => image.id)).size !== items.length) {
      throw new Error('Offline caching requires unique stable image IDs')
    }

    // An unchanged re-open is the common case: every image id and source
    // matches the committed record positionally, so the whole fill is one
    // index touch plus a fresh commit record — never a decrypt per entry
    // just to learn the bytes are already there. Any drift (a new, removed,
    // reordered or re-uploaded photo) falls through to the per-image pass.
    const priorImages = prior.status === 'ready' ? prior.value.images : []
    const unchanged = priorImages.length === items.length && items.every((image, index) => {
      const cached = priorImages[index]
      if (!cached || cached.id !== image.id) return false
      const priorManifestImage = prior.status === 'ready' ? prior.value.manifest.images[index] : undefined
      return srcIdentityOf(priorManifestImage) === srcIdentityOf(image)
    })
    if (unchanged) {
      const missing = await this.vault.touch(galleryId, priorImages.flatMap((image) => image.videoEntryId ? [image.entryId, image.videoEntryId] : [image.entryId]))
      if (missing.length === 0) {
        for (const [index, image] of priorImages.entries()) {
          const item: OfflineCacheItemReady = { id: image.id, entryId: image.entryId, mimeType: image.mimeType, index }
          cacheFillRegistry.publish({ galleryId, item })
          onItemReady?.(item)
        }
        onProgress?.({ completed: items.length, total: items.length })
        const metadataBytes = encoder.encode(JSON.stringify({
          version: METADATA_VERSION,
          owner: selection.owner,
          slug: selection.slug,
          manifest: gallery.manifest,
          settings: gallery.settings,
          images: priorImages,
        } satisfies OfflineMetadata))
        try {
          // The commit record still refreshes: title or settings edits land
          // even though no byte moved.
          await this.vault.write(galleryId, METADATA_ENTRY_ID, metadataBytes, guard)
        } finally {
          metadataBytes.fill(0)
        }
        // The commit write's own eviction pass could drop an entry the touch
        // check just confirmed — re-probe once more before declaring
        // complete. touch is a presence probe, not a byte read.
        const missingAfter = await this.vault.touch(galleryId, priorImages.flatMap((image) => image.videoEntryId ? [image.entryId, image.videoEntryId] : [image.entryId]))
        if (missingAfter.length > 0) {
          await this.vault.clearGallery(galleryId)
          return { status: 'over-cap', images: 0 }
        }
        return { status: 'complete', images: items.length }
      }
    }

    const cachedImages: CachedImage[] = []
    const publish = (item: OfflineCacheItemReady) => {
      // The registry feeds waiting Library cells unconditionally; the
      // per-call callback stays the optional seam for whoever started the
      // fill.
      cacheFillRegistry.publish({ galleryId, item })
      onItemReady?.(item)
    }
    onProgress?.({ completed: 0, total: items.length })
    for (const [index, image] of items.entries()) {
      throwIfAborted(signal)
      const entryId = thumbnailEntryId(image.id)
      const videoEntry = isVideoItem(image) ? videoEntryId(image.id) : undefined
      // A fill runs on every online open: bytes already in the vault are
      // reused instead of re-downloaded — but only while the provider source
      // is unchanged, and the touched read keeps them ahead of the entries
      // this same fill writes (an evicting LRU could otherwise delete them
      // mid-fill). The metadata commit still refreshes manifest/settings.
      const stillExisting = await this.vault.read(galleryId, entryId, { touch: true })
      const videoExisting = videoEntry ? await this.vault.read(galleryId, videoEntry, { touch: true }) : undefined
      if (stillExisting) stillExisting.fill(0)
      if (videoExisting) videoExisting.fill(0)
      const priorCached = priorCachedById.get(image.id)
      const reuseEntry = stillExisting !== undefined
        && (videoEntry === undefined || videoExisting !== undefined)
        && priorCached !== undefined
        && (videoEntry === undefined || priorCached.videoEntryId === videoEntry)
        && srcIdentityOf(priorManifestById.get(image.id)) === srcIdentityOf(image)
      if (reuseEntry && priorCached) {
        cachedImages.push({ id: image.id, entryId, mimeType: priorCached.mimeType, videoEntryId: videoEntry, videoMimeType: priorCached.videoMimeType })
        publish({ id: image.id, entryId, mimeType: priorCached.mimeType, index })
        onProgress?.({ completed: cachedImages.length, total: items.length })
        continue
      }
      if (isVideoItem(image)) {
        const videoEntry = videoEntryId(image.id)
        // The poster lands first so Library cells light up while the MP4 is
        // still downloading. The still keeps the thumb:* addressing every
        // cell, rail and grid already uses.
        const posterResponse = await this.fetchImage(image.poster.src, { signal })
        if (!posterResponse.ok) throw new Error(`Offline image request failed (${posterResponse.status})`)
        const posterMime = responseMimeType(posterResponse, image, 'jpeg')
        const posterBytes = new Uint8Array(await posterResponse.arrayBuffer())
        try {
          throwIfAborted(signal)
          if (posterBytes.length === 0) throw new Error('Offline image response was empty')
          await this.vault.write(galleryId, entryId, posterBytes, guard)
          await this.vault.remove(galleryId, localComputeEntryId(image.id))
        } finally {
          posterBytes.fill(0)
        }
        const videoResponse = await this.fetchImage(image.src, { signal })
        if (!videoResponse.ok) throw new Error(`Offline video request failed (${videoResponse.status})`)
        const videoMime = videoMimeTypeOf(videoResponse, image)
        const videoBytes = await this.readBoundedBody(videoResponse, signal)
        try {
          throwIfAborted(signal)
          if (videoBytes.length === 0) throw new Error('Offline video response was empty')
          await this.vault.write(galleryId, videoEntry, videoBytes, guard)
        } finally {
          videoBytes.fill(0)
        }
        cachedImages.push({ id: image.id, entryId, mimeType: posterMime, videoEntryId: videoEntry, videoMimeType: videoMime })
        publish({ id: image.id, entryId, mimeType: posterMime, index })
        publish({ id: image.id, entryId: videoEntry, mimeType: videoMime, index })
        onProgress?.({ completed: cachedImages.length, total: items.length })
        continue
      }
      let bytes: Uint8Array
      let mimeType: string
      if (image.media?.kind === 'encrypted') {
        const materialized = await (await openSession()).materialize(image.media, false, signal)
        bytes = materialized.bytes
        mimeType = materialized.mimeType
      } else {
        const selected = offlineSourceFor(image)
        const response = await this.fetchImage(selected.src, { signal })
        if (!response.ok) throw new Error(`Offline image request failed (${response.status})`)
        mimeType = responseMimeType(response, image, selected.format)
        bytes = new Uint8Array(await response.arrayBuffer())
      }
      try {
        throwIfAborted(signal)
        if (bytes.length === 0) throw new Error('Offline image response was empty')
        await this.vault.write(galleryId, entryId, bytes, guard)
        // A stable thumbnail entry can now contain different bytes. Do not
        // let a version/image-ID-only feature record survive that replacement.
        await this.vault.remove(galleryId, localComputeEntryId(image.id))
        cachedImages.push({ id: image.id, entryId, mimeType })
        publish({ id: image.id, entryId, mimeType, index })
        onProgress?.({ completed: cachedImages.length, total: items.length })
      } finally {
        bytes.fill(0)
      }
    }

    throwIfAborted(signal)
    // Every write above runs the vault's LRU eviction when the cap is exceeded,
    // and the newest entries are written last — so a fill larger than the cap
    // evicts its own earlier entries. Verify every entry survived before the
    // metadata commit below advertises a complete gallery.
    if (!(await this.entriesPresent(galleryId, cachedImages))) {
      // Purge the partial fill: orphaned ciphertext still counts against the
      // cap and would be unreachable without a commit record anyway.
      await this.vault.clearGallery(galleryId)
      return { status: 'over-cap', images: 0 }
    }
    const metadata: OfflineMetadata = {
      version: METADATA_VERSION,
      owner: selection.owner,
      slug: selection.slug,
      manifest: gallery.manifest,
      settings: gallery.settings,
      images: cachedImages,
    }
    const metadataBytes = encoder.encode(JSON.stringify(metadata))
    try {
      // Metadata is the commit record: an interrupted fill never advertises a partial cache.
      await this.vault.write(galleryId, METADATA_ENTRY_ID, metadataBytes, guard)
    } finally {
      metadataBytes.fill(0)
    }
    // The commit write itself runs the same LRU — it may have evicted an
    // entry just verified. Check once more before declaring the fill done.
    if (!(await this.entriesPresent(galleryId, cachedImages))) {
      await this.vault.clearGallery(galleryId)
      return { status: 'over-cap', images: 0 }
    }
    return { status: 'complete', images: cachedImages.length }
  }

  async inspect(rawSelection: GallerySelection): Promise<OfflineCacheInspection> {
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    // Inspection is a probe, not a viewing: it must not move LRU order.
    const metadata = await this.readMetadata(selection, galleryId, false)
    if (metadata.status !== 'ready') return { status: metadata.status, images: 0 }
    for (const image of metadata.value.images) {
      const entryIds = image.videoEntryId ? [image.entryId, image.videoEntryId] : [image.entryId]
      for (const entryId of entryIds) {
        const bytes = await this.vault.read(galleryId, entryId, { touch: false })
        if (!bytes) {
          await this.vault.remove(galleryId, METADATA_ENTRY_ID)
          return { status: 'incomplete', images: 0 }
        }
        bytes.fill(0)
      }
    }
    return { status: 'complete', images: metadata.value.images.length }
  }

  async invalidate(rawSelection: GallerySelection): Promise<void> {
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    await this.vault.clearGallery(galleryId)
    this.releaseUrls(galleryId)
  }

  async open(rawSelection: GallerySelection): Promise<OfflineGalleryLease | undefined> {
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    const metadata = await this.readMetadata(selection, galleryId)
    if (metadata.status !== 'ready') return undefined

    const urls: string[] = []
    const localById = new Map<string, string>()
    const videoById = new Map<string, string>()
    try {
      // One serialized slot, batched decrypts: a whole gallery's ciphertext
      // comes back in parallel windows instead of one entry at a time. A
      // video item contributes both its still entry and its MP4 entry.
      const entryIds = metadata.value.images.flatMap((image) => image.videoEntryId ? [image.entryId, image.videoEntryId] : [image.entryId])
      const results = await this.vault.readMany(galleryId, entryIds)
      if (results.some((bytes) => !bytes)) {
        for (const bytes of results) bytes?.fill(0)
        await this.vault.remove(galleryId, METADATA_ENTRY_ID)
        throw new Error('Offline gallery cache is incomplete')
      }
      let cursor = 0
      for (const image of metadata.value.images) {
        const bytes = results[cursor++]!
        const videoBytes = image.videoEntryId ? results[cursor++] : undefined
        try {
          const url = this.objectUrls.create(bytes, image.mimeType)
          urls.push(url)
          this.trackUrl(galleryId, url)
          localById.set(image.id, url)
        } finally {
          bytes.fill(0)
        }
        if (videoBytes) {
          try {
            const url = this.objectUrls.create(videoBytes, image.videoMimeType ?? 'video/mp4')
            urls.push(url)
            this.trackUrl(galleryId, url)
            videoById.set(image.id, url)
          } finally {
            videoBytes.fill(0)
          }
        }
      }

      const manifest: GalleryManifest = {
        ...metadata.value.manifest,
        images: metadata.value.manifest.images.map((image) => {
          const stillSrc = localById.get(image.id)
          if (!stillSrc) throw new Error('Offline gallery cache is incomplete')
          // Provider media refs must not survive into the lease: any resolver
          // that sees one materializes it over the network, which a saved
          // copy promised not to need. The stored manifest keeps its refs
          // verbatim — fills compare unchangedness against it.
          const { media: _media, ...rest } = image as GalleryMediaItem & { media?: unknown }
          const variants = image.variants?.map((variant) => {
            const { media: _variantMedia, ...vrest } = variant
            return { ...vrest, src: stillSrc }
          })
          if (isVideoItem(image)) {
            const videoSrc = videoById.get(image.id)
            if (!videoSrc) throw new Error('Offline gallery cache is incomplete')
            return { ...rest, src: videoSrc, poster: { ...image.poster, src: stillSrc }, variants }
          }
          return {
            ...rest,
            src: stillSrc,
            variants,
          }
        }),
      }
      let disposed = false
      return {
        source: 'offline',
        manifest,
        committedManifest: metadata.value.manifest,
        settings: metadata.value.settings,
        dispose: () => {
          if (disposed) return
          disposed = true
          for (const url of urls) {
            this.objectUrls.revoke(url)
            this.untrackUrl(galleryId, url)
          }
        },
      }
    } catch {
      for (const url of urls) {
        this.objectUrls.revoke(url)
        this.untrackUrl(galleryId, url)
      }
      return undefined
    }
  }

  async listGalleries(): Promise<OfflineGallerySummary[]> {
    const summaries: OfflineGallerySummary[] = []
    for (const galleryId of await this.vault.listGalleryIds()) {
      const metadata = await this.readMetadataById(galleryId)
      summaries.push(
        metadata.status === 'ready'
          ? {
              status: 'cached',
              galleryId,
              owner: metadata.value.owner,
              slug: metadata.value.slug,
              title: metadata.value.manifest.title,
              images: metadata.value.images.length,
            }
          : { status: 'corrupt', galleryId },
      )
    }
    return summaries
  }

  async gridGallery(galleryId: string): Promise<OfflineGridGallery | undefined> {
    const metadata = await this.readMetadataById(galleryId)
    if (metadata.status !== 'ready') return undefined
    return {
      galleryId,
      owner: metadata.value.owner,
      slug: metadata.value.slug,
      title: metadata.value.manifest.title,
      frames: metadata.value.manifest.images.map((image, index) => ({
        id: image.id,
        entryId: metadata.value.images[index].entryId,
        mimeType: metadata.value.images[index].mimeType,
        video: isVideoItem(image),
        width: image.width,
        height: image.height,
        alt: image.alt,
        index,
      })),
    }
  }

  async listGridGalleries(): Promise<OfflineGridGallery[]> {
    const grids: OfflineGridGallery[] = []
    for (const galleryId of await this.vault.listGalleryIds()) {
      const grid = await this.gridGallery(galleryId)
      if (grid) grids.push(grid)
    }
    return grids
  }

  async readThumbnail(galleryId: string, entryId: string): Promise<Uint8Array | undefined> {
    return this.vault.read(galleryId, entryId, { touch: false })
  }

  async purgeGallery(galleryId: string): Promise<void> {
    // The vault's deletion checks run first: live URLs are released only after
    // the purge is confirmed, so a failed erase never blanks a healthy view.
    await this.vault.clearGallery(galleryId)
    this.releaseUrls(galleryId)
  }

  async purgeAll(): Promise<void> {
    await this.vault.clear()
    this.releaseUrls()
  }
}

export type NetworkFirstGallery = NativeGalleryResponse & {
  source: 'online' | 'offline'
  dispose?: () => void
  cacheFill?: Promise<OfflineCacheResult>
  encryptedResolver?: EncryptedMediaResolver
  /** Present only on a vault-first open: the committed manifest verbatim.
   *  Compare against `revalidate`'s fresh manifest to detect real drift. */
  committedManifest?: GalleryManifest
  /** Present only on a vault-first open: the network revalidation that was
   *  still in flight when the vault copy won. Resolves to the fresh online
   *  gallery, or null when the network could not answer — the vault copy
   *  already won, so a failed revalidation changes nothing. */
  revalidate?: Promise<NetworkFirstGallery | null>
}

export class OfflineGalleryUnavailableError extends Error {
  constructor(readonly networkError: unknown) {
    super('This gallery is not available offline yet. Connect to try again.')
    this.name = 'OfflineGalleryUnavailableError'
  }
}

const CACHE_INVALIDATING_HTTP_STATUSES = new Set([401, 403, 404, 410])

type OpenOptions = {
  selection: GallerySelection
  fetchOnline(signal?: AbortSignal): Promise<NativeGalleryResponse>
  store: OfflineGalleryStore
  /** Defaults to the secure on-device vault. Stream mode never starts a new
   * cache fill, but existing complete vault copies remain available offline. */
  cachePolicy?: VaultLoadPolicy
  /** A kept copy opens from the device: instant and offline-proof. The
   *  network still revalidates behind it — the returned `revalidate`
   *  promise carries the fresh online gallery (or null when the network
   *  could not answer), and the caller swaps it in only when the manifest
   *  actually drifted. Only honoured under a 'vault' policy. */
  preferVault?: boolean
  onProgress?: (progress: OfflineCacheProgress) => void
  onItemReady?: (item: OfflineCacheItemReady) => void
  signal?: AbortSignal
  /** Device shells inject their own key custody — the default reads the
   *  native SecureStorage store. */
  openEncryptedSession?: (selection: GallerySelection, compareWith?: string) => Promise<EncryptedClientSession>
}

/** The fresh online answer: bytes resolve through the provider (or the
 *  encrypted session) and the vault refills behind the open unless the
 *  policy says stream. */
const prepareOnline = async (options: OpenOptions, gallery: NativeGalleryResponse): Promise<NetworkFirstGallery> => {
  const openSession = options.openEncryptedSession ?? openNativeEncryptedSession
  const encryptedSession = gallery.manifest.images.some((image) => !isVideoItem(image) && image.media?.kind === 'encrypted')
    ? await openSession(options.selection, gallery.manifest.sourceUrl)
    : undefined
  const encryptedResolver = encryptedSession ? new EncryptedMediaResolver(encryptedSession) : undefined
  const cacheFill = options.cachePolicy === 'stream'
    ? undefined
    : options.store.cache(options.selection, gallery, options.signal, options.onProgress, options.onItemReady, encryptedSession)
  return { ...gallery, source: 'online', cacheFill, encryptedResolver, dispose: () => encryptedResolver?.dispose() }
}

/** True when the fresh answer is the committed one — presentation first
 *  (title, caption, date, per-item alt, poster, settings), then media byte
 *  identity (same order, ids, src/contentVersion). A text-only edit counts
 *  as drift for the *install* decision so the Viewer picks it up, while the
 *  cache fill still keys its download decisions on byte identity alone. */
export const offlineManifestMatches = (
  committed: GalleryManifest,
  fresh: GalleryManifest,
  committedSettings?: GallerySettings,
  freshSettings?: GallerySettings,
): boolean =>
  committed.title === fresh.title &&
  committed.caption === fresh.caption &&
  committed.date === fresh.date &&
  (committedSettings === undefined || freshSettings === undefined ||
    JSON.stringify(committedSettings) === JSON.stringify(freshSettings)) &&
  committed.images.length === fresh.images.length &&
  committed.images.every((image, index) => {
    const next = fresh.images[index]
    if (!next || next.id !== image.id || next.alt !== image.alt) return false
    if (isVideoItem(image) !== isVideoItem(next)) return false
    if (isVideoItem(image) && isVideoItem(next) && image.poster.src !== next.poster.src) return false
    const versionOf = (item: GalleryMediaItem) =>
      'contentVersion' in item && typeof item.contentVersion === 'string' ? item.contentVersion : item.src
    return versionOf(image) === versionOf(next)
  })

/** Online bytes win. A successful response returns before its cache fill
 *  settles — unless `preferVault` finds a complete copy, which opens from
 *  the device first and lets the network answer trail behind. */
export const openGalleryNetworkFirst = async (options: OpenOptions): Promise<NetworkFirstGallery> => {
  if (options.preferVault && options.cachePolicy === 'vault') {
    const cached = await options.store.open(options.selection).catch(() => undefined)
    if (cached) {
      const revalidate = options.fetchOnline(options.signal)
        .then((gallery) => prepareOnline(options, gallery))
        .catch(async (error: unknown) => {
          // An authoritative miss is a deletion, not a hiccup: the kept copy
          // is stale, not a fallback — drop it and surface the failure so
          // the viewer stops presenting a gallery that no longer exists.
          // Transient failures keep offline access and report no drift.
          if (error instanceof NativeGalleryHttpError && CACHE_INVALIDATING_HTTP_STATUSES.has(error.status)) {
            await options.store.invalidate(options.selection).catch(() => undefined)
            throw error
          }
          return null
        })
      return { ...cached, revalidate }
    }
  }
  try {
    const gallery = await options.fetchOnline(options.signal)
    return await prepareOnline(options, gallery)
  } catch (networkError) {
    throwIfAborted(options.signal)
    // A locked encrypted gallery keeps its type through the fallback so the
    // caller can delegate to the web's unlock flow. A vaulted copy still
    // wins — it was decrypted when it was written.
    if (networkError instanceof EncryptedSourceLockedError || networkError instanceof EncryptedSourceMismatchError) {
      const cached = await options.store.open(options.selection)
      if (cached) return cached
      throw networkError
    }
    if (networkError instanceof NativeGalleryHttpError) {
      if (CACHE_INVALIDATING_HTTP_STATUSES.has(networkError.status)) {
        await options.store.invalidate(options.selection).catch(() => undefined)
      }
      throw networkError
    }
    const cached = await options.store.open(options.selection)
    if (!cached) throw new OfflineGalleryUnavailableError(networkError)
    return cached
  }
}

export const productionOfflineGalleryStore: OfflineGalleryStore = new EncryptedOfflineGalleryStore({
  vault: productionVault,
})

export const __private__ = { METADATA_ENTRY_ID, isMetadata, mimeFromFormat }
