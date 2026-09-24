import { productionVault } from './vault'
import type { EncryptedVault } from './vault'

export const DEFAULT_THUMBNAIL_MAX_WIDTH_PX = 1024
export const DEFAULT_THUMBNAIL_MAX_HEIGHT_PX = 1024
export const DEFAULT_THUMBNAIL_CONCURRENCY = 1
export const MAX_THUMBNAIL_CONCURRENCY = 4

export type EmbeddedMetadataState = 'present' | 'absent' | 'unknown'
export type ThumbnailMetadata = {
  icc: EmbeddedMetadataState
  c2pa: EmbeddedMetadataState
}

/**
 * A provider read transfers ownership of `bytes` to the thumbnail pipeline.
 * Implementations must keep the lease in memory: plaintext filesystem staging
 * is deliberately not part of this seam. The pipeline zeroes the bytes before
 * calling `release`, including on decode, policy, and vault failures.
 */
export type ProviderByteLease = {
  bytes: Uint8Array
  release(): void | Promise<void>
}

export type ProviderImage = {
  id: string
  contentType?: string
  read(): Promise<ProviderByteLease>
}

/**
 * The decoded resource may wrap native image memory. Width and height are the
 * post-orientation dimensions reported by the decoder, not provider metadata.
 */
export type DecodedThumbnailSource = {
  width: number
  height: number
  mimeType: string
  metadata: ThumbnailMetadata
  close(): void | Promise<void>
}

export type DerivativeIntegrity = {
  /** True only when the encoded derivative keeps the decoded source format. */
  originalFormat: boolean
  /** `preserved` means an embedded source profile was copied into the output. */
  icc: 'preserved' | 'not-present' | 'discarded' | 'unknown'
  /** Changed pixels invalidate C2PA; credentialed derivatives must be re-signed. */
  c2pa: 'resigned' | 'not-present' | 'discarded' | 'unknown'
}

export type ThumbnailDerivative = {
  bytes: Uint8Array
  width: number
  height: number
  mimeType: string
  integrity: DerivativeIntegrity
}

/**
 * Platform codecs live behind this adapter because browser canvas encoders do
 * not promise same-format output, ICC retention, or valid C2PA credentials.
 * The adapter receives bytes only; it must not create plaintext temporary
 * files and must treat `sourceBytes` as read-only.
 */
export interface ThumbnailCodecAdapter {
  decode(input: { bytes: Uint8Array; contentType?: string }): Promise<DecodedThumbnailSource>
  derive(input: {
    source: DecodedThumbnailSource
    sourceBytes: Uint8Array
    width: number
    height: number
  }): Promise<ThumbnailDerivative>
}

export type DerivativePolicyInput = {
  source: DecodedThumbnailSource
  target: ThumbnailSize
  derivative: ThumbnailDerivative
}
export type DerivativePolicyDecision =
  | { action: 'accept' }
  | { action: 'retain-source'; reason: string }
  | { action: 'reject'; reason: string }

/** An explicit decision point for runtimes whose encoder cannot prove safety. */
export interface ThumbnailDerivativePolicy {
  decide(input: DerivativePolicyInput): DerivativePolicyDecision
}

export class UnsafeThumbnailDerivativeError extends Error {
  constructor(readonly reason: string) {
    super(`Unsafe thumbnail derivative: ${reason}`)
    this.name = 'UnsafeThumbnailDerivativeError'
  }
}

/**
 * Fail-closed metadata policy. Re-encoded pixels must remain in the original
 * format, retain any possible ICC profile, and be re-signed when C2PA may be
 * present. A caller may explicitly install a policy that retains source bytes
 * instead, but unsafe derivatives are never silently written.
 */
export const strictThumbnailDerivativePolicy: ThumbnailDerivativePolicy = {
  decide({ source, derivative }) {
    if (!derivative.integrity.originalFormat || derivative.mimeType !== source.mimeType) {
      return { action: 'reject', reason: 'the runtime did not preserve the original format' }
    }
    if (source.metadata.icc !== 'absent' && derivative.integrity.icc !== 'preserved') {
      return { action: 'reject', reason: 'the runtime did not preserve the ICC profile' }
    }
    if (source.metadata.c2pa !== 'absent' && derivative.integrity.c2pa !== 'resigned') {
      return { action: 'reject', reason: 'the runtime did not re-sign the C2PA credential' }
    }
    return { action: 'accept' }
  },
}

export type ThumbnailSize = { width: number; height: number }

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

/** Aspect-ratio preserving integer dimensions, capped at both bounds and 1x. */
export const thumbnailSize = (input: {
  sourceWidth: number
  sourceHeight: number
  maxWidth: number
  maxHeight: number
}): ThumbnailSize => {
  const sourceWidth = positiveInteger(input.sourceWidth, 'sourceWidth')
  const sourceHeight = positiveInteger(input.sourceHeight, 'sourceHeight')
  const maxWidth = positiveInteger(input.maxWidth, 'maxWidth')
  const maxHeight = positiveInteger(input.maxHeight, 'maxHeight')
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
  }
}

export type ThumbnailVault = Pick<EncryptedVault, 'write'>

export type StoredThumbnail = {
  id: string
  entryId: string
  width: number
  height: number
  mimeType: string
  byteLength: number
  disposition: 'retained-source' | 'derived'
}

export type ThumbnailCacheSummary = {
  stored: number
  retainedSources: number
  derived: number
}

export type OnDeviceThumbnailCacheOptions = {
  codec: ThumbnailCodecAdapter
  vault: ThumbnailVault
  maxWidth?: number
  maxHeight?: number
  maxConcurrent?: number
  policy?: ThumbnailDerivativePolicy
  onStored?: (thumbnail: StoredThumbnail) => void | Promise<void>
}

export const thumbnailEntryId = (providerImageId: string): string => `thumb:${providerImageId}`

const validateDecodedSource = (source: DecodedThumbnailSource): void => {
  positiveInteger(source.width, 'decoded width')
  positiveInteger(source.height, 'decoded height')
  if (!source.mimeType.startsWith('image/')) throw new Error('Decoded source must report an image MIME type')
}

const validateDerivative = (derivative: ThumbnailDerivative, target: ThumbnailSize): void => {
  if (!(derivative.bytes instanceof Uint8Array) || derivative.bytes.length === 0) {
    throw new Error('Thumbnail adapter returned no encoded bytes')
  }
  if (derivative.width !== target.width || derivative.height !== target.height) {
    throw new Error('Thumbnail adapter returned dishonest dimensions')
  }
  if (!derivative.mimeType.startsWith('image/')) throw new Error('Thumbnail adapter must report an image MIME type')
}

/**
 * Coordinates one in-memory provider lease at a time per worker: decode,
 * honestly size, optionally derive, encrypt through EncryptedVault, then wipe.
 */
export class OnDeviceThumbnailCache {
  private readonly codec: ThumbnailCodecAdapter
  private readonly vault: ThumbnailVault
  private readonly maxWidth: number
  private readonly maxHeight: number
  private readonly maxConcurrent: number
  private readonly policy: ThumbnailDerivativePolicy
  private readonly onStored?: (thumbnail: StoredThumbnail) => void | Promise<void>

  constructor(options: OnDeviceThumbnailCacheOptions) {
    this.codec = options.codec
    this.vault = options.vault
    this.maxWidth = positiveInteger(options.maxWidth ?? DEFAULT_THUMBNAIL_MAX_WIDTH_PX, 'maxWidth')
    this.maxHeight = positiveInteger(options.maxHeight ?? DEFAULT_THUMBNAIL_MAX_HEIGHT_PX, 'maxHeight')
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? DEFAULT_THUMBNAIL_CONCURRENCY, 'maxConcurrent')
    if (this.maxConcurrent > MAX_THUMBNAIL_CONCURRENCY) {
      throw new Error(`maxConcurrent cannot exceed ${MAX_THUMBNAIL_CONCURRENCY}`)
    }
    this.policy = options.policy ?? strictThumbnailDerivativePolicy
    this.onStored = options.onStored
  }

  async cacheOne(galleryId: string, image: ProviderImage): Promise<StoredThumbnail> {
    let lease: ProviderByteLease | undefined
    let source: DecodedThumbnailSource | undefined
    let derivative: ThumbnailDerivative | undefined

    try {
      lease = await image.read()
      if (!(lease.bytes instanceof Uint8Array) || lease.bytes.length === 0) {
        throw new Error('Provider returned no image bytes')
      }
      source = await this.codec.decode({ bytes: lease.bytes, contentType: image.contentType })
      validateDecodedSource(source)
      const target = thumbnailSize({
        sourceWidth: source.width,
        sourceHeight: source.height,
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
      })
      const entryId = thumbnailEntryId(image.id)

      if (target.width === source.width && target.height === source.height) {
        const byteLength = lease.bytes.length
        await this.vault.write(galleryId, entryId, lease.bytes)
        return {
          id: image.id,
          entryId,
          width: source.width,
          height: source.height,
          mimeType: source.mimeType,
          byteLength,
          disposition: 'retained-source',
        }
      }

      derivative = await this.codec.derive({
        source,
        sourceBytes: lease.bytes,
        width: target.width,
        height: target.height,
      })
      validateDerivative(derivative, target)
      const decision = this.policy.decide({ source, target, derivative })
      if (decision.action === 'reject') throw new UnsafeThumbnailDerivativeError(decision.reason)

      if (decision.action === 'retain-source') {
        const byteLength = lease.bytes.length
        await this.vault.write(galleryId, entryId, lease.bytes)
        return {
          id: image.id,
          entryId,
          width: source.width,
          height: source.height,
          mimeType: source.mimeType,
          byteLength,
          disposition: 'retained-source',
        }
      }

      const byteLength = derivative.bytes.length
      await this.vault.write(galleryId, entryId, derivative.bytes)
      return {
        id: image.id,
        entryId,
        width: derivative.width,
        height: derivative.height,
        mimeType: derivative.mimeType,
        byteLength,
        disposition: 'derived',
      }
    } finally {
      derivative?.bytes.fill(0)
      lease?.bytes.fill(0)
      try {
        await source?.close()
      } finally {
        await lease?.release()
      }
    }
  }

  /**
   * Consumes sync or async provider streams without materializing the gallery.
   * At most `maxConcurrent` source/decoded/derivative byte sets are live.
   */
  async cacheGallery(
    galleryId: string,
    images: Iterable<ProviderImage> | AsyncIterable<ProviderImage>,
  ): Promise<ThumbnailCacheSummary> {
    const summary: ThumbnailCacheSummary = { stored: 0, retainedSources: 0, derived: 0 }
    const active = new Set<Promise<void>>()
    let failed = false
    let firstError: unknown

    for await (const image of images) {
      if (failed) break
      let task!: Promise<void>
      task = this.cacheOne(galleryId, image)
        .then(async (stored) => {
          summary.stored += 1
          if (stored.disposition === 'derived') summary.derived += 1
          else summary.retainedSources += 1
          await this.onStored?.(stored)
        })
        .catch((error: unknown) => {
          if (!failed) {
            failed = true
            firstError = error
          }
        })
        .finally(() => active.delete(task))
      active.add(task)
      if (active.size >= this.maxConcurrent) await Promise.race(active)
    }

    await Promise.all(active)
    if (failed) throw firstError
    return summary
  }
}

export const createProductionThumbnailCache = (
  codec: ThumbnailCodecAdapter,
  options: Omit<OnDeviceThumbnailCacheOptions, 'codec' | 'vault'> = {},
): OnDeviceThumbnailCache => new OnDeviceThumbnailCache({ ...options, codec, vault: productionVault })

export const __private__ = { validateDecodedSource, validateDerivative }
