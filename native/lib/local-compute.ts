import type { EncryptedVault } from './vault'

export const LOCAL_COMPUTE_VERSION = 1
export const LOCAL_COMPUTE_ENTRY_PREFIX = `local-compute:v${LOCAL_COMPUTE_VERSION}:`
export const LOCAL_COMPUTE_GRID_SIZE = 32
export const LOCAL_EMBEDDING_GRID_SIZE = 8
export const DEFAULT_NEAR_DUPLICATE_HAMMING_DISTANCE = 6
export const DEFAULT_SEQUENCE_IMPROVEMENT = 0.08
export const MAX_LOCAL_COMPUTE_CONCURRENCY = 2

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const DCT_SIZE = 8
const HammingBits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const

export type LocalPixelLease = {
  width: number
  height: number
  /** Tight RGBA bytes. The engine clears this buffer before releasing it. */
  pixels: Uint8Array
  release(): void | Promise<void>
}

export type LocalComputeImage = {
  id: string
  readPixels(): Promise<LocalPixelLease>
}

export type CachedComputeImage = {
  id: string
  entryId: string
  mimeType: string
}

/**
 * `pixel-grid-v1` is intentionally not described as a learned model. It is a
 * compact, deterministic visual embedding made from an 8×8 RGB grid. A future
 * native model can implement the same query contract without changing vault
 * records or the gallery editor seam.
 */
export type LocalImageFeatures = {
  version: typeof LOCAL_COMPUTE_VERSION
  imageId: string
  phash: string
  embeddingModel: 'pixel-grid-v1'
  embedding: readonly number[]
}

export type LocalComputeVault = Pick<EncryptedVault, 'read' | 'write'>
export type LocalComputeCancellation = () => boolean
export type EncodedPixelDecoder = (bytes: Uint8Array, mimeType: string) => Promise<LocalPixelLease>

export type NearDuplicateGroup = {
  representativeId: string
  imageIds: readonly string[]
  maxDistance: number
}

export type SequenceSuggestion = {
  fromId: string
  currentNextId: string
  suggestedNextId: string
  currentDistance: number
  suggestedDistance: number
  improvement: number
}

export type SimilarFrame = {
  imageId: string
  distance: number
  score: number
}

export type LocalComputeSummary = {
  computed: number
  persisted: number
}

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
}

const assertPixels = (source: Pick<LocalPixelLease, 'width' | 'height' | 'pixels'>): void => {
  assertPositiveInteger(source.width, 'pixel width')
  assertPositiveInteger(source.height, 'pixel height')
  const required = source.width * source.height * 4
  if (!Number.isSafeInteger(required) || source.pixels.length < required) throw new Error('Pixel buffer is shorter than its dimensions')
}

const pixelOffset = (width: number, x: number, y: number): number => (y * width + x) * 4

const luminance = (pixels: Uint8Array, width: number, x: number, y: number): number => {
  const offset = pixelOffset(width, x, y)
  return pixels[offset]! * 0.299 + pixels[offset + 1]! * 0.587 + pixels[offset + 2]! * 0.114
}

const sampleLuminanceGrid = (source: LocalPixelLease, size: number): Float64Array => {
  const values = new Float64Array(size * size)
  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / size))
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / size))
      values[y * size + x] = luminance(source.pixels, source.width, sourceX, sourceY)
    }
  }
  return values
}

const dctCoefficient = (values: Float64Array, u: number, v: number): number => {
  let sum = 0
  for (let y = 0; y < LOCAL_COMPUTE_GRID_SIZE; y += 1) {
    for (let x = 0; x < LOCAL_COMPUTE_GRID_SIZE; x += 1) {
      sum += values[y * LOCAL_COMPUTE_GRID_SIZE + x]!
        * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * LOCAL_COMPUTE_GRID_SIZE))
        * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * LOCAL_COMPUTE_GRID_SIZE))
    }
  }
  const scaleU = u === 0 ? Math.sqrt(1 / LOCAL_COMPUTE_GRID_SIZE) : Math.sqrt(2 / LOCAL_COMPUTE_GRID_SIZE)
  const scaleV = v === 0 ? Math.sqrt(1 / LOCAL_COMPUTE_GRID_SIZE) : Math.sqrt(2 / LOCAL_COMPUTE_GRID_SIZE)
  return sum * scaleU * scaleV
}

/** Computes a 64-bit low-frequency DCT perceptual hash as 16 lowercase hex digits. */
export const perceptualHash = (source: LocalPixelLease): string => {
  assertPixels(source)
  const grid = sampleLuminanceGrid(source, LOCAL_COMPUTE_GRID_SIZE)
  const coefficients: number[] = []
  for (let v = 0; v < DCT_SIZE; v += 1) {
    for (let u = 0; u < DCT_SIZE; u += 1) coefficients.push(dctCoefficient(grid, u, v))
  }
  const sorted = coefficients.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  let hash = ''
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0
    for (let bit = 0; bit < 4; bit += 1) {
      if (coefficients[nibble * 4 + bit]! >= median) value |= 1 << (3 - bit)
    }
    hash += value.toString(16)
  }
  return hash
}

const averageRgbCell = (source: LocalPixelLease, cellX: number, cellY: number): [number, number, number] => {
  const startX = Math.floor(cellX * source.width / LOCAL_EMBEDDING_GRID_SIZE)
  const endX = Math.max(startX + 1, Math.floor((cellX + 1) * source.width / LOCAL_EMBEDDING_GRID_SIZE))
  const startY = Math.floor(cellY * source.height / LOCAL_EMBEDDING_GRID_SIZE)
  const endY = Math.max(startY + 1, Math.floor((cellY + 1) * source.height / LOCAL_EMBEDDING_GRID_SIZE))
  let red = 0
  let green = 0
  let blue = 0
  let count = 0
  for (let y = startY; y < Math.min(source.height, endY); y += 1) {
    for (let x = startX; x < Math.min(source.width, endX); x += 1) {
      const offset = pixelOffset(source.width, x, y)
      red += source.pixels[offset]!
      green += source.pixels[offset + 1]!
      blue += source.pixels[offset + 2]!
      count += 1
    }
  }
  return [red / count / 255, green / count / 255, blue / count / 255]
}

const normalize = (values: number[]): number[] => {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (length === 0) return values.map(() => 0)
  return values.map((value) => Number((value / length).toFixed(6)))
}

/** Computes the honest, model-free visual embedding used by this first native slice. */
export const pixelGridEmbedding = (source: LocalPixelLease): readonly number[] => {
  assertPixels(source)
  const values: number[] = []
  for (let y = 0; y < LOCAL_EMBEDDING_GRID_SIZE; y += 1) {
    for (let x = 0; x < LOCAL_EMBEDDING_GRID_SIZE; x += 1) values.push(...averageRgbCell(source, x, y))
  }
  return normalize(values)
}

export const computeImageFeatures = (source: LocalPixelLease, imageId: string): LocalImageFeatures => {
  if (!imageId.trim()) throw new Error('imageId must not be empty')
  return {
    version: LOCAL_COMPUTE_VERSION,
    imageId,
    phash: perceptualHash(source),
    embeddingModel: 'pixel-grid-v1',
    embedding: pixelGridEmbedding(source),
  }
}

export const hammingDistance = (left: string, right: string): number => {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) throw new Error('Perceptual hashes must be 64-bit hexadecimal strings')
  let distance = 0
  for (let index = 0; index < left.length; index += 1) {
    const xor = Number.parseInt(left[index]!, 16) ^ Number.parseInt(right[index]!, 16)
    distance += HammingBits[xor]!
  }
  return distance
}

export const cosineDistance = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length || left.length === 0) throw new Error('Embeddings must have the same non-zero length')
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Embeddings must contain finite values')
    dot += a * b
    leftMagnitude += a * a
    rightMagnitude += b * b
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 1
  return Math.max(0, Math.min(1, 1 - dot / Math.sqrt(leftMagnitude * rightMagnitude)))
}

/** Finds visually similar frames from already-persisted local features. */
export const findSimilarFrames = (
  features: readonly LocalImageFeatures[],
  queryImageId: string,
  limit = 12,
): readonly SimilarFrame[] => {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer')
  const query = features.find((feature) => feature.imageId === queryImageId)
  if (!query) return []
  return features
    .filter((feature) => feature.imageId !== queryImageId)
    .map((feature) => {
      const distance = cosineDistance(query.embedding, feature.embedding)
      return { imageId: feature.imageId, distance, score: 1 - distance }
    })
    .sort((left, right) => left.distance - right.distance || left.imageId.localeCompare(right.imageId))
    .slice(0, limit)
}

export const clusterNearDuplicates = (
  features: readonly LocalImageFeatures[],
  maxDistance = DEFAULT_NEAR_DUPLICATE_HAMMING_DISTANCE,
): readonly NearDuplicateGroup[] => {
  if (!Number.isSafeInteger(maxDistance) || maxDistance < 0 || maxDistance > 64) throw new Error('maxDistance must be an integer from 0 to 64')
  const parent = features.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== index) {
      const next = parent[index]!
      parent[index] = root
      index = next
    }
    return root
  }
  const join = (left: number, right: number): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let left = 0; left < features.length; left += 1) {
    for (let right = left + 1; right < features.length; right += 1) {
      if (hammingDistance(features[left]!.phash, features[right]!.phash) <= maxDistance) join(left, right)
    }
  }
  const groups = new Map<number, number[]>()
  for (let index = 0; index < features.length; index += 1) {
    const root = find(index)
    const group = groups.get(root) ?? []
    group.push(index)
    groups.set(root, group)
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const imageIds = group.map((index) => features[index]!.imageId)
      let max = 0
      for (let left = 0; left < group.length; left += 1) {
        for (let right = left + 1; right < group.length; right += 1) {
          max = Math.max(max, hammingDistance(features[group[left]!]!.phash, features[group[right]!]!.phash))
        }
      }
      return { representativeId: imageIds[0]!, imageIds, maxDistance: max }
    })
}

/** Returns reviewable alternatives without changing the photographer's order. */
export const suggestSequence = (
  features: readonly LocalImageFeatures[],
  currentOrder: readonly string[],
  minImprovement = DEFAULT_SEQUENCE_IMPROVEMENT,
): readonly SequenceSuggestion[] => {
  if (!Number.isFinite(minImprovement) || minImprovement < 0 || minImprovement > 1) throw new Error('minImprovement must be between 0 and 1')
  const byId = new Map(features.map((feature) => [feature.imageId, feature]))
  const suggestions: SequenceSuggestion[] = []
  for (let index = 0; index + 1 < currentOrder.length; index += 1) {
    const fromId = currentOrder[index]!
    const currentNextId = currentOrder[index + 1]!
    const from = byId.get(fromId)
    const currentNext = byId.get(currentNextId)
    if (!from || !currentNext) continue
    let best: { id: string; distance: number } | undefined
    for (const candidateId of currentOrder.slice(index + 1)) {
      if (candidateId === currentNextId) continue
      const candidate = byId.get(candidateId)
      if (!candidate) continue
      const distance = cosineDistance(from.embedding, candidate.embedding)
      if (!best || distance < best.distance) best = { id: candidateId, distance }
    }
    if (!best) continue
    const currentDistance = cosineDistance(from.embedding, currentNext.embedding)
    const improvement = currentDistance - best.distance
    if (improvement >= minImprovement) suggestions.push({ fromId, currentNextId, suggestedNextId: best.id, currentDistance, suggestedDistance: best.distance, improvement })
  }
  return suggestions
}

const featuresEntryId = (imageId: string): string => `${LOCAL_COMPUTE_ENTRY_PREFIX}${imageId}`
const serializeFeatures = (features: LocalImageFeatures): Uint8Array => encoder.encode(JSON.stringify(features))

const parseFeatures = (bytes: Uint8Array): LocalImageFeatures | undefined => {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<LocalImageFeatures>
    const phash = value.phash
    const embedding = value.embedding
    if (value.version !== LOCAL_COMPUTE_VERSION || typeof value.imageId !== 'string' || typeof phash !== 'string' || !/^[0-9a-f]{16}$/i.test(phash) || value.embeddingModel !== 'pixel-grid-v1' || !Array.isArray(embedding) || embedding.length !== LOCAL_EMBEDDING_GRID_SIZE * LOCAL_EMBEDDING_GRID_SIZE * 3 || embedding.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) return undefined
    return { version: LOCAL_COMPUTE_VERSION, imageId: value.imageId, phash: phash.toLowerCase(), embeddingModel: 'pixel-grid-v1', embedding }
  } catch {
    return undefined
  }
}

export const readImageFeatures = async (vault: LocalComputeVault, galleryId: string, imageId: string): Promise<LocalImageFeatures | undefined> => {
  const bytes = await vault.read(galleryId, featuresEntryId(imageId))
  return bytes ? parseFeatures(bytes) : undefined
}

const pixelsFromDrawable = (drawable: CanvasImageSource, width: number, height: number): LocalPixelLease => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D is unavailable for local compute')
  context.drawImage(drawable, 0, 0)
  const data = context.getImageData(0, 0, width, height).data
  let released = false
  return {
    width,
    height,
    pixels: new Uint8Array(data),
    release: () => {
      if (released) return
      released = true
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export const browserEncodedImageDecoder: EncodedPixelDecoder = async (bytes, mimeType) => {
  const blob = new Blob([bytes.slice().buffer], { type: mimeType })
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try {
      return pixelsFromDrawable(bitmap, bitmap.width, bitmap.height)
    } finally {
      bitmap.close()
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') throw new Error('This native shell cannot decode images for local compute')
  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('Image decode failed for local compute'))
      element.src = objectUrl
    })
    return pixelsFromDrawable(image, image.naturalWidth, image.naturalHeight)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

class LocalComputeCancelledError extends Error {
  constructor() {
    super('Local compute pass was cancelled')
    this.name = 'LocalComputeCancelledError'
  }
}

export class OnDeviceLocalCompute {
  private readonly vault: LocalComputeVault
  private readonly maxConcurrent: number
  private readonly yieldToHost: () => Promise<void>

  constructor(options: { vault: LocalComputeVault; maxConcurrent?: number; yieldToHost?: () => Promise<void> }) {
    this.vault = options.vault
    this.maxConcurrent = options.maxConcurrent ?? 1
    this.yieldToHost = options.yieldToHost ?? (() => new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 250 })
      else setTimeout(resolve, 0)
    }))
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent <= 0 || this.maxConcurrent > MAX_LOCAL_COMPUTE_CONCURRENCY) throw new Error(`maxConcurrent must be from 1 to ${MAX_LOCAL_COMPUTE_CONCURRENCY}`)
  }

  async computeOne(galleryId: string, image: LocalComputeImage, isCancelled: LocalComputeCancellation = () => false): Promise<LocalImageFeatures> {
    let lease: LocalPixelLease | undefined
    try {
      lease = await image.readPixels()
      assertPixels(lease)
      await this.yieldToHost()
      const features = computeImageFeatures(lease, image.id)
      if (isCancelled()) throw new LocalComputeCancelledError()
      await this.vault.write(galleryId, featuresEntryId(image.id), serializeFeatures(features))
      return features
    } finally {
      lease?.pixels.fill(0)
      await lease?.release()
    }
  }

  async computeGallery(galleryId: string, images: Iterable<LocalComputeImage> | AsyncIterable<LocalComputeImage>, isCancelled: LocalComputeCancellation = () => false): Promise<LocalComputeSummary> {
    const active = new Set<Promise<void>>()
    let computed = 0
    let firstError: unknown
    for await (const image of images) {
      if (isCancelled()) break
      let task!: Promise<void>
      task = this.computeOne(galleryId, image, isCancelled)
        .then(() => { computed += 1 })
        .catch((error: unknown) => {
          if (!(error instanceof LocalComputeCancelledError)) firstError ??= error
        })
        .finally(() => active.delete(task))
      active.add(task)
      if (active.size >= this.maxConcurrent) await Promise.race(active)
      if (firstError) break
    }
    await Promise.all(active)
    if (firstError) throw firstError
    return { computed, persisted: computed }
  }
}

export const computeCachedGallery = async (options: {
  engine: OnDeviceLocalCompute
  galleryId: string
  images: Iterable<CachedComputeImage>
  read: (galleryId: string, entryId: string) => Promise<Uint8Array | undefined>
  readFeatures?: (galleryId: string, imageId: string) => Promise<LocalImageFeatures | undefined>
  decode?: EncodedPixelDecoder
  isCancelled?: LocalComputeCancellation
}): Promise<LocalComputeSummary> => {
  const decode = options.decode ?? browserEncodedImageDecoder
  const images: LocalComputeImage[] = []
  for (const image of options.images) {
    if (options.isCancelled?.()) break
    const existing = await options.readFeatures?.(options.galleryId, image.id)
    if (options.isCancelled?.()) break
    if (existing?.version === LOCAL_COMPUTE_VERSION && existing.imageId === image.id) continue
    images.push({
    id: image.id,
    async readPixels() {
      const bytes = await options.read(options.galleryId, image.entryId)
      if (!bytes) throw new Error(`Cached image is missing: ${image.id}`)
      try {
        return await decode(bytes, image.mimeType)
      } finally {
        bytes.fill(0)
      }
    },
    })
  }
  return options.engine.computeGallery(options.galleryId, images, options.isCancelled)
}

export const __private__ = { assertPixels, parseFeatures, sampleLuminanceGrid, dctCoefficient, featuresEntryId, pixelsFromDrawable }
