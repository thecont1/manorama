import type { GalleryImage, GalleryManifest, GalleryMediaItem, ImageVariant } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import { NativeGalleryHttpError, type NativeGalleryResponse } from './api'
import { thumbnailEntryId } from './thumbs'
import type { EncryptedVault } from './vault'
import { productionVault } from './vault'

const METADATA_VERSION = 1
const METADATA_ENTRY_ID = 'offline-gallery:metadata:v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type GallerySelection = { owner: string; slug: string }
export type OfflineCacheResult =
  | { status: 'complete'; images: number }
  | { status: 'skipped-video'; images: 0 }

export type OfflineCacheInspection =
  | { status: 'complete'; images: number }
  | { status: 'missing' | 'incomplete' | 'corrupt'; images: 0 }

export type OfflineGalleryLease = NativeGalleryResponse & {
  source: 'offline'
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
  cache(selection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal): Promise<OfflineCacheResult>
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

export type OfflineFetchResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer'>
export type OfflineImageFetch = (input: string, init?: RequestInit) => Promise<OfflineFetchResponse>
export interface OfflineObjectUrlProvider {
  /** Implementations must snapshot bytes before returning; the store wipes them immediately. */
  create(bytes: Uint8Array, mimeType: string): string
  revoke(url: string): void
}

type OfflineVault = Pick<EncryptedVault, 'read' | 'write' | 'remove' | 'clearGallery' | 'clear' | 'epoch' | 'listGalleryIds'>
type CachedImage = { id: string; entryId: string; mimeType: string }
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

const normalizedSelection = ({ owner, slug }: GallerySelection): GallerySelection => ({
  owner: owner.trim(),
  slug: slug.trim(),
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')

const isStillItem = (value: unknown): value is GalleryImage => {
  if (!isRecord(value) || (value.type !== undefined && value.type !== 'image')) return false
  const variantsValid = value.variants === undefined || (Array.isArray(value.variants) && value.variants.every((variant) =>
    isRecord(variant) && Number.isFinite(variant.width) && Number(variant.width) > 0 &&
    typeof variant.src === 'string' && typeof variant.format === 'string'))
  return variantsValid && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.filename === 'string' && typeof value.src === 'string' &&
    Number.isFinite(value.width) && Number(value.width) > 0 &&
    Number.isFinite(value.height) && Number(value.height) > 0 &&
    typeof value.alt === 'string' && typeof value.c2pa === 'boolean' &&
    typeof value.placeholder === 'string'
}

const isManifest = (value: unknown): value is GalleryManifest => {
  if (!isRecord(value) || typeof value.slug !== 'string' || typeof value.title !== 'string' ||
    typeof value.caption !== 'string' || typeof value.date !== 'string' || !Array.isArray(value.images) ||
    value.images.length === 0 || !value.images.every(isStillItem)) return false
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
    return candidate.id === manifestImage?.id && candidate.entryId === thumbnailEntryId(manifestImage.id) &&
      typeof candidate.mimeType === 'string' && candidate.mimeType.length > 0
  })
}

const isMetadata = (value: unknown, selection: GallerySelection): value is OfflineMetadata =>
  isMetadataRecord(value) && value.owner === selection.owner && value.slug === selection.slug

const remoteVariant = (variant: ImageVariant): boolean =>
  Number.isFinite(variant.width) && variant.width > 0 && /^https?:\/\//i.test(variant.src)

/** Provider variants are already-encoded assets. Selecting one changes no bytes or metadata. */
export const offlineSourceFor = (image: GalleryImage): { src: string; format?: string } => {
  const variant = image.variants
    ?.filter(remoteVariant)
    .reduce<ImageVariant | undefined>((smallest, candidate) =>
      !smallest || candidate.width < smallest.width ? candidate : smallest, undefined)
  return variant ? { src: variant.src, format: variant.format } : { src: image.src }
}

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

const responseMimeType = (response: OfflineFetchResponse, image: GalleryImage, format?: string): string => {
  const header = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (header && !header.startsWith('image/') && header !== 'application/octet-stream') {
    throw new Error(`Offline image response was not an image (${header})`)
  }
  return header?.startsWith('image/') ? header : mimeFromFormat(format) ?? mimeFromFilename(image.filename) ?? 'application/octet-stream'
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export class EncryptedOfflineGalleryStore implements OfflineGalleryStore {
  private readonly vault: OfflineVault
  private readonly fetchImage: OfflineImageFetch
  private readonly objectUrls: OfflineObjectUrlProvider
  /** Live decrypted object URLs, by gallery. A confirmed purge revokes them so
   *  "erased" never leaves a readable copy held by an open lease. */
  private readonly liveUrls = new Map<string, Set<string>>()

  constructor(options: {
    vault: OfflineVault
    fetchImage?: OfflineImageFetch
    objectUrls?: OfflineObjectUrlProvider
  }) {
    this.vault = options.vault
    this.fetchImage = options.fetchImage ?? defaultFetch
    this.objectUrls = options.objectUrls ?? defaultObjectUrls
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

  async cache(rawSelection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal): Promise<OfflineCacheResult> {
    // Captured synchronously at call time, before the gallery ID resolves: a
    // purge bumps the vault's mutation epoch inside its serialized boundary,
    // and every write below hands back the epoch this fill started under. A
    // confirmed purge can never be followed by a stale fill quietly
    // repopulating the vault — the fill dies on its next write instead.
    const guard = { since: this.vault.epoch() }
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    // Invalidate the commit record first. A failed refresh may leave encrypted
    // bytes behind, but they can never be mistaken for a complete gallery.
    await this.vault.remove(galleryId, METADATA_ENTRY_ID)
    if (gallery.manifest.images.some(isVideoItem)) return { status: 'skipped-video', images: 0 }
    const stillImages = gallery.manifest.images.filter((image): image is GalleryImage => !isVideoItem(image))
    if (stillImages.length === 0) throw new Error('An empty gallery cannot be cached offline')
    if (new Set(stillImages.map((image) => image.id)).size !== stillImages.length) {
      throw new Error('Offline caching requires unique stable image IDs')
    }

    const cachedImages: CachedImage[] = []
    for (const image of stillImages) {
      throwIfAborted(signal)
      const selected = offlineSourceFor(image)
      const response = await this.fetchImage(selected.src, { signal })
      if (!response.ok) throw new Error(`Offline image request failed (${response.status})`)
      const mimeType = responseMimeType(response, image, selected.format)
      const bytes = new Uint8Array(await response.arrayBuffer())
      try {
        throwIfAborted(signal)
        if (bytes.length === 0) throw new Error('Offline image response was empty')
        const entryId = thumbnailEntryId(image.id)
        await this.vault.write(galleryId, entryId, bytes, guard)
        cachedImages.push({ id: image.id, entryId, mimeType })
      } finally {
        bytes.fill(0)
      }
    }

    throwIfAborted(signal)
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
    return { status: 'complete', images: cachedImages.length }
  }

  async inspect(rawSelection: GallerySelection): Promise<OfflineCacheInspection> {
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    // Inspection is a probe, not a viewing: it must not move LRU order.
    const metadata = await this.readMetadata(selection, galleryId, false)
    if (metadata.status !== 'ready') return { status: metadata.status, images: 0 }
    for (const image of metadata.value.images) {
      const bytes = await this.vault.read(galleryId, image.entryId, { touch: false })
      if (!bytes) {
        await this.vault.remove(galleryId, METADATA_ENTRY_ID)
        return { status: 'incomplete', images: 0 }
      }
      bytes.fill(0)
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
    try {
      for (const image of metadata.value.images) {
        const bytes = await this.vault.read(galleryId, image.entryId)
        if (!bytes) {
          await this.vault.remove(galleryId, METADATA_ENTRY_ID)
          throw new Error('Offline gallery cache is incomplete')
        }
        try {
          const url = this.objectUrls.create(bytes, image.mimeType)
          urls.push(url)
          this.trackUrl(galleryId, url)
          localById.set(image.id, url)
        } finally {
          bytes.fill(0)
        }
      }

      const manifest: GalleryManifest = {
        ...metadata.value.manifest,
        images: metadata.value.manifest.images.map((image) => {
          const src = localById.get(image.id)
          if (!src) throw new Error('Offline gallery cache is incomplete')
          return {
            ...image,
            src,
            variants: image.variants?.map((variant) => ({ ...variant, src })),
          }
        }),
      }
      let disposed = false
      return {
        source: 'offline',
        manifest,
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
}

export class OfflineGalleryUnavailableError extends Error {
  constructor(readonly networkError: unknown) {
    super('This gallery is not available offline yet. Connect to try again.')
    this.name = 'OfflineGalleryUnavailableError'
  }
}

const CACHE_INVALIDATING_HTTP_STATUSES = new Set([401, 403, 404, 410])

/** Online bytes win. A successful response returns before its cache fill settles. */
export const openGalleryNetworkFirst = async (options: {
  selection: GallerySelection
  fetchOnline(signal?: AbortSignal): Promise<NativeGalleryResponse>
  store: OfflineGalleryStore
  signal?: AbortSignal
}): Promise<NetworkFirstGallery> => {
  try {
    const gallery = await options.fetchOnline(options.signal)
    const cacheFill = options.store.cache(options.selection, gallery, options.signal)
    return { ...gallery, source: 'online', cacheFill }
  } catch (networkError) {
    throwIfAborted(options.signal)
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
