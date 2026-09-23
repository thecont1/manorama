/** Best-effort image dimension extraction from raw file bytes.
 *  Used when a provider's metadata or thumbnail probe is unavailable —
 *  a ranged fetch of the file head is enough for every supported format. */

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) + b[o + 1]!
const u16le = (b: Uint8Array, o: number) => b[o]! + (b[o + 1]! << 8)
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
const isAscii = (b: Uint8Array, o: number, s: string) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0))

export const parseJpegDimensions = (bytes: Uint8Array) => {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    const length = (bytes[offset + 2]! << 8) + bytes[offset + 3]!
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) }
    }
    offset += Math.max(2, length + 2)
  }
  return null
}

const parsePngDimensions = (bytes: Uint8Array) => {
  if (!isAscii(bytes, 1, 'PNG') || !isAscii(bytes, 12, 'IHDR') || bytes.length < 24) return null
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

const parseGifDimensions = (bytes: Uint8Array) => {
  if (!isAscii(bytes, 0, 'GIF8') || bytes.length < 10) return null
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) }
}

export const parseWebpDimensions = (bytes: Uint8Array) => {
  if (bytes.length < 30 || !isAscii(bytes, 0, 'RIFF') || !isAscii(bytes, 8, 'WEBP')) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  if (isAscii(bytes, 12, 'VP8X')) return { width: 1 + (bytes[24]! | bytes[25]! << 8 | bytes[26]! << 16), height: 1 + (bytes[27]! | bytes[28]! << 8 | bytes[29]! << 16) }
  if (isAscii(bytes, 12, 'VP8 ')) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (isAscii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

/** HEIC/HEIF/AVIF store pixel extents in `ispe` boxes inside the meta box.
 *  Files can carry several (primary image + thumbnails) — take the largest. */
const parseIsobmffDimensions = (bytes: Uint8Array) => {
  if (!isAscii(bytes, 4, 'ftyp')) return null
  let best: { width: number; height: number } | null = null
  for (let i = 8; i + 16 <= bytes.length; i++) {
    if (!isAscii(bytes, i, 'ispe')) continue
    const width = u32be(bytes, i + 8)
    const height = u32be(bytes, i + 12)
    if (!width || !height || width > 65535 || height > 65535) continue
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

export const probeImageDimensions = (bytes: Uint8Array) =>
  parseJpegDimensions(bytes) ?? parsePngDimensions(bytes) ?? parseGifDimensions(bytes) ?? parseWebpDimensions(bytes) ?? parseIsobmffDimensions(bytes)
