import type { GalleryImage, GalleryManifest, GalleryMediaItem, ImageVariant } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { NativeGalleryResponse } from './api'
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

export interface OfflineGalleryStore {
  cache(selection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal): Promise<OfflineCacheResult>
  inspect(selection: GallerySelection): Promise<OfflineCacheInspection>
  open(selection: GallerySelection): Promise<OfflineGalleryLease | undefined>
}

export type OfflineFetchResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'arrayBuffer'>
export type OfflineImageFetch = (input: string, init?: RequestInit) => Promise<OfflineFetchResponse>
export interface OfflineObjectUrlProvider {
  /** Implementations must snapshot bytes before returning; the store wipes them immediately. */
  create(bytes: Uint8Array, mimeType: string): string
  revoke(url: string): void
}

type OfflineVault = Pick<EncryptedVault, 'read' | 'write' | 'remove'>
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

const isMetadata = (value: unknown, selection: GallerySelection): value is OfflineMetadata => {
  if (!isRecord(value) || value.version !== METADATA_VERSION || value.owner !== selection.owner || value.slug !== selection.slug) return false
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

  constructor(options: {
    vault: OfflineVault
    fetchImage?: OfflineImageFetch
    objectUrls?: OfflineObjectUrlProvider
  }) {
    this.vault = options.vault
    this.fetchImage = options.fetchImage ?? defaultFetch
    this.objectUrls = options.objectUrls ?? defaultObjectUrls
  }

  private async readMetadata(selection: GallerySelection, galleryId: string): Promise<MetadataRead> {
    const bytes = await this.vault.read(galleryId, METADATA_ENTRY_ID)
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

  async cache(rawSelection: GallerySelection, gallery: NativeGalleryResponse, signal?: AbortSignal): Promise<OfflineCacheResult> {
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
        await this.vault.write(galleryId, entryId, bytes)
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
      await this.vault.write(galleryId, METADATA_ENTRY_ID, metadataBytes)
    } finally {
      metadataBytes.fill(0)
    }
    return { status: 'complete', images: cachedImages.length }
  }

  async inspect(rawSelection: GallerySelection): Promise<OfflineCacheInspection> {
    const selection = requireSelection(rawSelection)
    const galleryId = await offlineGalleryId(selection)
    const metadata = await this.readMetadata(selection, galleryId)
    if (metadata.status !== 'ready') return { status: metadata.status, images: 0 }
    for (const image of metadata.value.images) {
      const bytes = await this.vault.read(galleryId, image.entryId)
      if (!bytes) {
        await this.vault.remove(galleryId, METADATA_ENTRY_ID)
        return { status: 'incomplete', images: 0 }
      }
      bytes.fill(0)
    }
    return { status: 'complete', images: metadata.value.images.length }
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
          for (const url of urls) this.objectUrls.revoke(url)
        },
      }
    } catch {
      for (const url of urls) this.objectUrls.revoke(url)
      return undefined
    }
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
    const cached = await options.store.open(options.selection)
    if (!cached) throw new OfflineGalleryUnavailableError(networkError)
    return cached
  }
}

export const productionOfflineGalleryStore: OfflineGalleryStore = new EncryptedOfflineGalleryStore({
  vault: productionVault,
})

export const __private__ = { METADATA_ENTRY_ID, isMetadata, mimeFromFormat }
