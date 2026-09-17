import { describe, expect, test } from 'bun:test'
import { probeImageDimensions } from './image-dims'

const jpeg = (w: number, h: number) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
  0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03,
])

const png = (w: number, h: number) => new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  w >> 24, w >> 16 & 0xff, w >> 8 & 0xff, w & 0xff, h >> 24, h >> 16 & 0xff, h >> 8 & 0xff, h & 0xff,
  0x08, 0x06, 0x00, 0x00, 0x00,
])

const gif = (w: number, h: number) => new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 0xff, w >> 8, h & 0xff, h >> 8,
])

const webpVp8x = (w: number, h: number) => {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x45, 0x42, 0x50], 8); b.set([0x56, 0x50, 0x38, 0x58], 12)
  b.set([w - 1 & 0xff, w - 1 >> 8 & 0xff, w - 1 >> 16 & 0xff], 24)
  b.set([h - 1 & 0xff, h - 1 >> 8 & 0xff, h - 1 >> 16 & 0xff], 27)
  return b
}

const webpVp8l = (w: number, h: number) => {
  const b = new Uint8Array(30)
  b.set([0x52, 0x49, 0x46, 0x46], 0); b.set([0x57, 0x45, 0x42, 0x50], 8); b.set([0x56, 0x50, 0x38, 0x4c], 12)
  b[20] = 0x2f
  const bits = (w - 1) | (h - 1) << 14
  b.set([bits & 0xff, bits >> 8 & 0xff, bits >> 16 & 0xff, bits >> 24 & 0xff], 21)
  return b
}

/** ftyp at offset 4, then an ispe box: size + 'ispe' + ver/flags + w + h */
const isobmff = (brand: string, w: number, h: number) => {
  const b = new Uint8Array(48)
  b.set([0x66, 0x74, 0x79, 0x70], 4)
  b.set([...brand].map((c) => c.charCodeAt(0)), 8)
  b.set([0x00, 0x00, 0x00, 0x1c, 0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00], 24)
  b.set([w >> 24, w >> 16 & 0xff, w >> 8 & 0xff, w & 0xff], 36)
  b.set([h >> 24, h >> 16 & 0xff, h >> 8 & 0xff, h & 0xff], 40)
  return b
}

describe('probeImageDimensions', () => {
  test('jpeg SOF', () => expect(probeImageDimensions(jpeg(5712, 4284))).toEqual({ width: 5712, height: 4284 }))
  test('png IHDR', () => expect(probeImageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 }))
  test('gif header', () => expect(probeImageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 }))
  test('webp VP8X', () => expect(probeImageDimensions(webpVp8x(1024, 683))).toEqual({ width: 1024, height: 683 }))
  test('webp VP8L', () => expect(probeImageDimensions(webpVp8l(800, 600))).toEqual({ width: 800, height: 600 }))
  test('heic ispe', () => expect(probeImageDimensions(isobmff('heic', 4032, 3024))).toEqual({ width: 4032, height: 3024 }))
  test('avif ispe', () => expect(probeImageDimensions(isobmff('avif', 2000, 1333))).toEqual({ width: 2000, height: 1333 }))
  test('picks the largest ispe when thumbnails are present', () => {
    const b = new Uint8Array(96)
    b.set(isobmff('mif1', 160, 120).subarray(0, 48), 0)
    b.set(isobmff('mif1', 4000, 3000).subarray(24, 48), 48)
    expect(probeImageDimensions(b)).toEqual({ width: 4000, height: 3000 })
  })
  test('unrecognised bytes return null', () => {
    expect(probeImageDimensions(new Uint8Array(64))).toBeNull()
    expect(probeImageDimensions(new TextEncoder().encode('PK\x03\x04 not an image'))).toBeNull()
  })
})
