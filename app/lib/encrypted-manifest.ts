import {
  contentVersionIsValid,
  encryptedProviderForUrl,
  keylessSourceUrl,
  enteIdentityFromUrl,
  mediaReferenceIsValid,
  megaIdentityFromUrl,
  protonIdentityFromUrl,
  validatePublishedDimensions,
  type EncryptedSourceProvider,
} from '../../packages/core/encrypted-source'
import { MAX_GALLERY_ITEMS, type GalleryImage } from './imagesource'

export type EncryptedManifestInput = {
  provider: EncryptedSourceProvider
  sourceUrl: string
  title: string
  images: GalleryImage[]
  truncated?: number
}

const IMAGE_FIELDS = new Set([
  'type', 'id', 'ref', 'filename', 'src', 'media', 'contentVersion', 'fidelity', 'thumbnailFidelity',
  'width', 'height', 'alt', 'caption', 'exif', 'c2pa', 'placeholder', 'variants', 'hidden',
])
const VARIANT_FIELDS = new Set(['width', 'src', 'media', 'format'])
const MANIFEST_FIELDS = new Set(['provider', 'sourceUrl', 'title', 'images', 'truncated'])
const HANDLE = /^[0-9A-Za-z_-]{1,256}$/
// Proton nodeUids carry a '~' volume separator — still keyless-safe.
const PROTON_NODE = /^[0-9A-Za-z_~=-]{1,256}$/
const refIsValid = (provider: EncryptedSourceProvider, ref: unknown): ref is string =>
  typeof ref === 'string' && ref.length <= 256 && (provider === 'proton' ? PROTON_NODE.test(ref) : HANDLE.test(ref))

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, allowEmpty = true): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
const onlyFields = (value: Record<string, unknown>, allowed: Set<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key))
const safePlaceholder = (value: unknown): value is string =>
  text(value, 4096) && value.startsWith('data:image/svg+xml,') && !/[<>]/.test(value)

const validateVariant = (value: unknown, source: { provider: EncryptedSourceProvider; handle: string; kind?: string }, nodeId: string): boolean => {
  if (!record(value) || !onlyFields(value, VARIANT_FIELDS)) return false
  if (!Number.isSafeInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 100_000) return false
  if (value.src !== '' || !text(value.format, 20, false) || !/^(?:jpe?g|webp|avif|image\/(?:jpeg|webp|avif))$/i.test(value.format)) return false
  if (!mediaReferenceIsValid(value.media) || value.media.kind !== 'encrypted' || value.media.provider !== source.provider) return false
  return value.media.sourceId === source.handle && value.media.nodeId === nodeId && typeof value.media.previewId === 'string'
}

const validateImage = (value: unknown, source: { provider: EncryptedSourceProvider; handle: string; kind?: string }): value is GalleryImage => {
  if (!record(value) || !onlyFields(value, IMAGE_FIELDS)) return false
  if (value.type !== undefined && value.type !== 'image') return false
  if (!text(value.id, 128, false) || !text(value.ref, 256, false) || !refIsValid(source.provider, value.ref)) return false
  if (source.provider === 'mega' && !/^mega-[0-9A-Za-z]{1,18}$/.test(value.id)) return false
  if (source.provider === 'ente' && !/^ente-\d{1,20}$/.test(value.id)) return false
  if (source.provider === 'proton' && !/^proton-[0-9A-Za-z]{1,18}$/.test(value.id)) return false
  if (!text(value.filename, 512, false) || value.src !== '' || !text(value.alt, 2048) || !text(value.caption ?? '', 10_000)) return false
  if (typeof value.c2pa !== 'boolean' || !safePlaceholder(value.placeholder)) return false
  if (value.hidden !== undefined && typeof value.hidden !== 'boolean') return false
  if (value.fidelity !== undefined && !['original', 'full-resolution-render', 'display-derivative', 'unknown'].includes(String(value.fidelity))) return false
  if (value.thumbnailFidelity !== undefined && !['original', 'full-resolution-render', 'display-derivative', 'unknown'].includes(String(value.thumbnailFidelity))) return false
  if (!validatePublishedDimensions(Number(value.width), Number(value.height))) return false
  if (!contentVersionIsValid(value.contentVersion)) return false
  if (!mediaReferenceIsValid(value.media) || value.media.kind !== 'encrypted') return false
  if (value.media.provider !== source.provider || value.media.sourceId !== source.handle || value.media.nodeId !== value.ref) return false
  if (source.kind && value.media.sourceKind !== source.kind) return false
  if (value.exif !== undefined && (!record(value.exif) || JSON.stringify(value.exif).length > 16_384)) return false
  if (value.variants !== undefined && (!Array.isArray(value.variants) || value.variants.length > 4 || !value.variants.every((variant) => validateVariant(variant, source, value.ref as string)))) return false
  return true
}

/** Client scans are attacker input. This validator deliberately accepts only
 * keyless still-image manifests and never returns a server-fetchable URL. */
export const validateEncryptedManifest = (input: unknown): EncryptedManifestInput => {
  if (!record(input) || !onlyFields(input, MANIFEST_FIELDS)) throw new Error('Encrypted manifest has an invalid shape')
  if (input.provider !== 'mega' && input.provider !== 'ente' && input.provider !== 'proton') throw new Error('Encrypted provider is not supported')
  if (!text(input.sourceUrl, 2048, false) || input.sourceUrl.includes('#')) throw new Error('Encrypted source URL must be keyless')
  if (encryptedProviderForUrl(input.sourceUrl) !== input.provider) throw new Error('Encrypted source provider does not match its URL')
  if (keylessSourceUrl(input.sourceUrl) !== input.sourceUrl) throw new Error('Encrypted source URL is not canonical')
  const identity = input.provider === 'mega'
    ? megaIdentityFromUrl(input.sourceUrl)
    : input.provider === 'proton'
      ? protonIdentityFromUrl(input.sourceUrl)
      : enteIdentityFromUrl(input.sourceUrl)
  const handle = identity?.id
  if (!handle || !HANDLE.test(handle)) throw new Error('Encrypted source handle is invalid')
  if (!text(input.title, 120) || !Array.isArray(input.images) || input.images.length < 1 || input.images.length > MAX_GALLERY_ITEMS) {
    throw new Error(`Encrypted manifest must contain 1–${MAX_GALLERY_ITEMS} items`)
  }
  const source = { provider: input.provider as EncryptedSourceProvider, handle, kind: identity?.kind }
  if (!input.images.every((image) => validateImage(image, source))) throw new Error('Encrypted manifest contains an invalid item or source identity')
  const ids = input.images.map((image) => (image as { id: string }).id)
  const refs = input.images.map((image) => (image as { ref: string }).ref)
  if (new Set(ids).size !== ids.length || new Set(refs).size !== refs.length) throw new Error('Encrypted manifest item ids and refs must be unique')
  if (input.truncated !== undefined && (!Number.isSafeInteger(input.truncated) || Number(input.truncated) < input.images.length)) throw new Error('Encrypted truncation count is invalid')
  return input as unknown as EncryptedManifestInput
}
