import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_NEAR_DUPLICATE_HAMMING_DISTANCE,
  __private__,
  OnDeviceLocalCompute,
  clusterNearDuplicates,
  computeCachedGallery,
  computeImageFeatures,
  cosineDistance,
  findSimilarFrames,
  hammingDistance,
  isCurrentImageFeatures,
  pixelGridEmbedding,
  suggestSequence,
  thumbnailContentId,
  type LocalComputeImage,
  type LocalComputeVault,
  type LocalImageFeatures,
  type LocalPixelLease,
} from './local-compute'

class CopyingVault implements LocalComputeVault {
  readonly writes = new Map<string, Uint8Array>()

  async write(_galleryId: string, entryId: string, bytes: Uint8Array): Promise<void> {
    this.writes.set(entryId, bytes.slice())
  }

  async read(_galleryId: string, entryId: string): Promise<Uint8Array | undefined> {
    return this.writes.get(entryId)?.slice()
  }
}

const pixels = (width: number, height: number, color: [number, number, number], tweak?: (x: number, y: number) => [number, number, number]): Uint8Array => {
  const bytes = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = tweak?.(x, y) ?? color
      const offset = (y * width + x) * 4
      bytes[offset] = red
      bytes[offset + 1] = green
      bytes[offset + 2] = blue
      bytes[offset + 3] = 255
    }
  }
  return bytes
}

const lease = (id: string, bytes: Uint8Array, width: number, height: number, released: string[]): LocalComputeImage => ({
  id,
  async readPixels(): Promise<LocalPixelLease> {
    return { width, height, pixels: bytes, release: () => { released.push(id) } }
  },
})

const feature = (imageId: string, phash: string, embedding: readonly number[], thumbnailId?: string): LocalImageFeatures => ({
  version: 1,
  imageId,
  ...(thumbnailId === undefined ? {} : { thumbnailId }),
  phash,
  embeddingModel: 'pixel-grid-v1',
  embedding,
})

describe('local visual features', () => {
  test('accepts only the current version and matching image ID', () => {
    const current = feature('frame-a', '0000000000000000', [1, 0])
    const old = { ...current, version: 0 } as unknown as LocalImageFeatures

    expect(isCurrentImageFeatures(current, 'frame-a')).toBe(true)
    expect(isCurrentImageFeatures(current, 'frame-b')).toBe(false)
    expect(isCurrentImageFeatures(old, 'frame-a')).toBe(false)
    expect(isCurrentImageFeatures(undefined, 'frame-a')).toBe(false)
  })

  test('rejects a feature whose thumbnail content ID is not current', async () => {
    const currentThumbnailId = await thumbnailContentId(new Uint8Array([9, 8, 7, 6]))
    const current = feature('frame-a', '0000000000000000', [1, 0], currentThumbnailId)

    expect(isCurrentImageFeatures(current, 'frame-a', currentThumbnailId)).toBe(true)
    expect(isCurrentImageFeatures(current, 'frame-a', 'different-thumbnail')).toBe(false)
    expect(isCurrentImageFeatures(feature('frame-a', '0000000000000000', [1, 0]), 'frame-a', currentThumbnailId)).toBe(false)
  })

  test('computes deterministic hash and normalized pixel-grid embedding without changing source dimensions', () => {
    const source = { width: 16, height: 8, pixels: pixels(16, 8, [40, 100, 200]), release: () => {} }
    const first = computeImageFeatures(source, 'frame-a')
    const second = computeImageFeatures(source, 'frame-a')

    expect(first).toEqual(second)
    expect(first.phash).toMatch(/^[0-9a-f]{16}$/)
    expect(first.embedding).toHaveLength(8 * 8 * 3)
    expect(Math.abs(Math.sqrt(first.embedding.reduce((sum, value) => sum + value * value, 0)) - 1)).toBeLessThan(0.00001)
  })

  test('keeps alpha out of visual similarity features', () => {
    const opaque = pixels(8, 8, [120, 30, 210])
    const transparent = opaque.slice()
    for (let index = 3; index < transparent.length; index += 4) transparent[index] = index & 0xff
    const left = pixelGridEmbedding({ width: 8, height: 8, pixels: opaque, release: () => {} })
    const right = pixelGridEmbedding({ width: 8, height: 8, pixels: transparent, release: () => {} })
    expect(right).toEqual(left)
  })
})

describe('feature similarity and curation suggestions', () => {
  test('measures identical hashes as zero distance and rejects malformed hashes', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0)
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4)
    expect(() => hammingDistance('bad', '0000000000000000')).toThrow()
  })

  test('groups near duplicates transitively without changing input order', () => {
    const group = [
      feature('a', '0000000000000000', [1, 0]),
      feature('b', '0000000000000001', [1, 0]),
      feature('c', '0000000000000003', [1, 0]),
      feature('different', 'ffffffffffffffff', [0, 1]),
    ]
    expect(clusterNearDuplicates(group, DEFAULT_NEAR_DUPLICATE_HAMMING_DISTANCE)).toEqual([
      { representativeId: 'a', imageIds: ['a', 'b', 'c'], maxDistance: 2 },
    ])
  })

  test('only suggests a materially closer next frame and never mutates the order', () => {
    const features = [
      feature('opening', '0000000000000000', [1, 0]),
      feature('wrong-next', 'ffffffffffffffff', [0, 1]),
      feature('better-next', '0000000000000001', [0.99, 0.1]),
    ]
    const order = ['opening', 'wrong-next', 'better-next']
    const before = order.slice()
    const suggestions = suggestSequence(features, order, 0.2)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ fromId: 'opening', currentNextId: 'wrong-next', suggestedNextId: 'better-next' })
    expect(suggestions[0]!.improvement).toBeGreaterThan(0.2)
    expect(order).toEqual(before)
    expect(cosineDistance([1, 0], [1, 0])).toBe(0)
  })

  test('finds similar frames from local embeddings without including the query', () => {
    const features = [
      feature('query', '0000000000000000', [1, 0]),
      feature('close', '0000000000000001', [0.99, 0.1]),
      feature('far', '0000000000000002', [0, 1]),
    ]
    expect(findSimilarFrames(features, 'query', 2).map((item) => item.imageId)).toEqual(['close', 'far'])
    expect(findSimilarFrames(features, 'missing')).toEqual([])
  })
})

describe('OnDeviceLocalCompute', () => {
  test('persists only serialized feature records and wipes pixel buffers before release', async () => {
    const vault = new CopyingVault()
    const compute = new OnDeviceLocalCompute({ vault })
    const released: string[] = []
    const source = pixels(16, 12, [80, 160, 40])
    const result = await compute.computeOne('gallery-a', lease('frame-a', source, 16, 12, released))

    expect(result.imageId).toBe('frame-a')
    expect(vault.writes.has('local-compute:v1:frame-a')).toBe(true)
    expect(source.every((value) => value === 0)).toBe(true)
    expect(released).toEqual(['frame-a'])
    expect(new TextDecoder().decode(vault.writes.get('local-compute:v1:frame-a'))).not.toContain('80,160,40')
    await expect(vault.read('gallery-a', 'local-compute:v1:frame-a')).resolves.toBeDefined()
  })

  test('bounds gallery extraction concurrency and preserves all feature records', async () => {
    const vault = new CopyingVault()
    const compute = new OnDeviceLocalCompute({ vault, maxConcurrent: 2 })
    let active = 0
    let maximum = 0
    const images: LocalComputeImage[] = Array.from({ length: 24 }, (_, index) => {
      const bytes = pixels(8, 8, [index, 50, 100])
      return {
        id: `frame-${index}`,
        async readPixels() {
          active += 1
          maximum = Math.max(maximum, active)
          await Promise.resolve()
          return { width: 8, height: 8, pixels: bytes, release: () => { active -= 1 } }
        },
      }
    })

    await expect(compute.computeGallery('gallery-a', images)).resolves.toEqual({ computed: 24, persisted: 24 })
    expect(maximum).toBeLessThanOrEqual(2)
    expect(vault.writes).toHaveLength(24)
    expect(active).toBe(0)
  })

  test('rejects invalid pixel leases before persistence', async () => {
    const vault = new CopyingVault()
    const compute = new OnDeviceLocalCompute({ vault })
    const bad: LocalComputeImage = {
      id: 'bad',
      async readPixels() {
        return { width: 8, height: 8, pixels: new Uint8Array(3), release: () => {} }
      },
    }
    await expect(compute.computeOne('gallery-a', bad)).rejects.toThrow('Pixel buffer is shorter')
    expect(vault.writes).toHaveLength(0)
  })

  test('skips current-version feature records before decoding cached images', async () => {
    const vault = new CopyingVault()
    const compute = new OnDeviceLocalCompute({ vault })
    let decoded = 0
    const summary = await computeCachedGallery({
      engine: compute,
      galleryId: 'gallery-a',
      images: [
        { id: 'frame-a', entryId: 'thumb-frame-a', mimeType: 'image/mock' },
        { id: 'frame-b', entryId: 'thumb-frame-b', mimeType: 'image/mock' },
      ],
      readFeatures: async (_galleryId, imageId) => imageId === 'frame-a'
        ? feature('frame-a', '0000000000000000', [1, 0], await thumbnailContentId(new Uint8Array([9, 8, 7, 6])))
        : undefined,
      read: async () => new Uint8Array([9, 8, 7, 6]),
      decode: async () => {
        decoded += 1
        return { width: 4, height: 4, pixels: new Uint8Array(4 * 4 * 4).fill(9), release: () => {} }
      },
    })

    expect(summary).toEqual({ computed: 1, persisted: 1 })
    expect(decoded).toBe(1)
    expect(vault.writes.has('local-compute:v1:frame-a')).toBe(false)
    expect(vault.writes.has('local-compute:v1:frame-b')).toBe(true)
  })

  test('cancels before persisting a result when the pass becomes obsolete', async () => {
    const vault = new CopyingVault()
    let cancelled = false
    const compute = new OnDeviceLocalCompute({ vault, yieldToHost: async () => { cancelled = true } })
    const bytes = pixels(4, 4, [9, 8, 7])
    const summary = await compute.computeGallery('gallery-a', [lease('frame-a', bytes, 4, 4, [])], () => cancelled)

    expect(summary).toEqual({ computed: 0, persisted: 0 })
    expect(vault.writes).toHaveLength(0)
  })

  test('releases canvas backing storage when a drawable lease ends', () => {
    const originalDocument = globalThis.document
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(16) }),
      }),
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } })
    try {
      const drawableLease = __private__.pixelsFromDrawable({} as CanvasImageSource, 2, 2)
      expect(canvas.width).toBe(2)
      expect(canvas.height).toBe(2)
      drawableLease.release()
      expect(canvas.width).toBe(0)
      expect(canvas.height).toBe(0)
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }
  })

  test('decodes cached bytes on device, persists features, and wipes encoded bytes', async () => {
    const vault = new CopyingVault()
    const compute = new OnDeviceLocalCompute({ vault })
    const encoded = new Uint8Array([9, 8, 7, 6])
    const supplied = [encoded, encoded.slice()]
    let readIndex = 0
    const summary = await computeCachedGallery({
      engine: compute,
      galleryId: 'gallery-a',
      images: [{ id: 'frame-a', entryId: 'thumb-frame-a', mimeType: 'image/mock' }],
      read: async () => supplied[readIndex++],
      decode: async (bytes) => ({
        width: 4,
        height: 4,
        pixels: new Uint8Array(4 * 4 * 4).fill(bytes[0]!),
        release: () => {},
      }),
    })

    expect(summary).toEqual({ computed: 1, persisted: 1 })
    expect(encoded.every((value) => value === 0)).toBe(true)
    expect(supplied[0]?.every((value) => value === 0)).toBe(true)
    expect(vault.writes.has('local-compute:v1:frame-a')).toBe(true)
  })

  test('does not persist features when the thumbnail changes during the pass', async () => {
    const vault = new CopyingVault()
    let reads = 0
    await expect(computeCachedGallery({
      engine: new OnDeviceLocalCompute({ vault }),
      galleryId: 'gallery-a',
      images: [{ id: 'frame-a', entryId: 'thumb-frame-a', mimeType: 'image/mock' }],
      read: async () => {
        reads += 1
        return reads === 1 ? new Uint8Array([1, 2, 3]) : new Uint8Array([4, 5, 6])
      },
      decode: async () => ({ width: 4, height: 4, pixels: new Uint8Array(4 * 4 * 4), release: () => {} }),
    })).rejects.toThrow('changed during local compute')
    expect(vault.writes.size).toBe(0)
  })
})
