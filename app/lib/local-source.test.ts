import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalSourceMatches, detectSource } from './sources'
import type { ExifData } from '../../packages/core/imagesource'
import {
  isLocalPathInput,
  localFolderCandidate,
  localSourcesEnabled,
  normalizeLocalPathString,
  scanLocalFolder,
  serveLocalMedia,
} from './local-source'

/**
 * The local-folder source is dev-only: it activates through a globalThis
 * flag the vite dev plugin sets, so these tests flip it on explicitly and
 * restore it afterwards.
 */

const g = globalThis as { __manoramaLocalSources?: boolean }
const previousFlag = g.__manoramaLocalSources
g.__manoramaLocalSources = true
afterAll(() => {
  if (previousFlag === undefined) delete g.__manoramaLocalSources
  else g.__manoramaLocalSources = previousFlag
})

const dir = mkdtempSync(join(tmpdir(), 'manorama-local-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A header-true PNG: the dims parser reads IHDR at fixed offsets. */
const pngBytes = (width: number, height: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  b.set([0, 0, 0, 13], 8)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  b.set([(width >>> 24) & 255, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16)
  b.set([(height >>> 24) & 255, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20)
  return b
}

writeFileSync(join(dir, 'b.png'), pngBytes(640, 480))
writeFileSync(join(dir, 'a.png'), pngBytes(1200, 900))
writeFileSync(join(dir, 'notes.txt'), 'not media')
writeFileSync(join(dir, '.hidden.png'), pngBytes(4, 4))
mkdirSync(join(dir, 'nested'))
writeFileSync(join(dir, 'nested', 'deep.png'), pngBytes(8, 8))

describe('isLocalPathInput', () => {
  test('absolute paths, home paths, file URLs, and drive letters count', () => {
    expect(isLocalPathInput('/Users/x/album')).toBe(true)
    expect(isLocalPathInput('~/Pictures/album')).toBe(true)
    expect(isLocalPathInput('file:///Users/x/album')).toBe(true)
    expect(isLocalPathInput('C:\\Photos\\album')).toBe(true)
  })

  test('provider URLs and plain text do not', () => {
    expect(isLocalPathInput('https://dropbox.com/scl/fo/a/b')).toBe(false)
    expect(isLocalPathInput('not a path')).toBe(false)
  })
})

describe('detection gating', () => {
  test('with the flag on, local shapes detect as local', () => {
    expect(detectSource(`${dir}`)).toBe('local')
    expect(detectSource(`file://${dir}`)).toBe('local')
    // Real providers are unaffected.
    expect(detectSource('https://www.dropbox.com/scl/fo/abc/xyz')).toBe('dropbox')
  })
})

describe('scanLocalFolder', () => {
  test('enumerates media files with probed dimensions', async () => {
    const scan = await scanLocalFolder(dir)
    expect(scan.title).toBe(dir.split('/').pop())
    expect(scan.sourceUrl).toBe(`file://${dir}`)
    expect(scan.images.map((item) => item.filename)).toEqual(['a.png', 'b.png'])
    const a = scan.images[0]
    expect(a.width).toBe(1200)
    expect(a.height).toBe(900)
    expect(a.src).toContain('/api/local/file?path=')
    expect(a.variants?.[0]?.src).toContain('&w=256')
  })

  test('rejects files and missing paths', async () => {
    await expect(scanLocalFolder(join(dir, 'a.png'))).rejects.toThrow()
    await expect(scanLocalFolder(join(dir, 'no-such-dir'))).rejects.toThrow()
  })

  test('rejects the filesystem root', async () => {
    await expect(scanLocalFolder('/')).rejects.toThrow()
  })

  test('a file whose header reads 0×0 stays out of the manifest', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'manorama-local-zero-'))
    try {
      // GIF89a with a zeroed extent, named .jpg — the header parses but
      // carries no usable dimensions, so the scan must skip it.
      writeFileSync(join(bad, 'zero.jpg'), new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0]))
      writeFileSync(join(bad, 'real.png'), pngBytes(8, 8))
      const scan = await scanLocalFolder(bad)
      expect(scan.images.map((item) => item.filename)).toEqual(['real.png'])
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  })
})

// --- embedded metadata -------------------------------------------------------

const te = new TextEncoder()
const be16 = (v: number) => new Uint8Array([(v >> 8) & 255, v & 255])
const be32 = (v: number) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
const le16 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255])
const le32 = (v: number) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255])
const joinBytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Little-endian TIFF, IFD0 only, ASCII tags stored out of line. */
const tiffAscii = (...tags: [number, string][]): Uint8Array => {
  const entries = tags.map(([tag, text]) => ({ tag, data: te.encode(`${text}\0`) }))
  const dataStart = 8 + 2 + entries.length * 12 + 4
  const out = new Uint8Array(dataStart + entries.reduce((n, e) => n + e.data.length, 0))
  out.set([0x49, 0x49], 0)
  out.set(le16(42), 2)
  out.set(le32(8), 4)
  out.set(le16(entries.length), 8)
  let p = 10
  let d = dataStart
  for (const e of entries) {
    out.set(le16(e.tag), p)
    out.set(le16(2), p + 2)
    out.set(le32(e.data.length), p + 4)
    out.set(le32(d), p + 8)
    out.set(e.data, d)
    d += e.data.length
    p += 12
  }
  return out
}

/** JPEG carrying an EXIF APP1 (camera make/model) and an APP13 Photoshop
 *  IPTC resource (object name -> title), dims in SOF0. */
const jpegWithMetadata = (width: number, height: number): Uint8Array => {
  const app1 = joinBytes(te.encode('Exif\0\0'), tiffAscii([0x010f, 'Canon'], [0x0110, 'EOS R5']))
  const iptc = joinBytes(new Uint8Array([0x1c, 2, 0x05]), be16(6), te.encode('Summit'))
  const bim = joinBytes(
    te.encode('8BIM'), be16(0x0404), new Uint8Array([0, 0]), be32(iptc.length), iptc,
    iptc.length % 2 ? new Uint8Array(1) : new Uint8Array(0),
  )
  const app13 = joinBytes(te.encode('Photoshop 3.0\0'), bim)
  const seg = (marker: number, data: Uint8Array) => joinBytes(new Uint8Array([0xff, marker]), be16(data.length + 2), data)
  const sof = joinBytes(new Uint8Array([8]), be16(height), be16(width), new Uint8Array([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]))
  return joinBytes(new Uint8Array([0xff, 0xd8]), seg(0xe1, app1), seg(0xed, app13), seg(0xc0, sof), new Uint8Array([0xff, 0xd9]))
}

describe('embedded metadata in scan', () => {
  test('a scanned JPEG carries its EXIF and IPTC fields into the manifest', async () => {
    const meta = mkdtempSync(join(tmpdir(), 'manorama-local-meta-'))
    try {
      writeFileSync(join(meta, 'photo.jpg'), jpegWithMetadata(800, 600))
      const scan = await scanLocalFolder(meta)
      expect(scan.images.map((item) => item.filename)).toEqual(['photo.jpg'])
      expect(scan.images[0]).toMatchObject({ exif: { camera: 'Canon EOS R5', title: 'Summit' } })
    } finally {
      rmSync(meta, { recursive: true, force: true })
    }
  })

  test('a worst-case capped exif stays far below the manifest ceiling', () => {
    // Every parser cap filled at once — the encrypted-manifest exif ceiling
    // is 16,384 JSON chars and MANIFEST_IMAGES_MAX_BYTES is 1.8 MB, so this
    // only needs to prove the row is noise, not payload.
    const exif: ExifData = {
      title: 't'.repeat(120),
      description: 'd'.repeat(500),
      creator: 'c'.repeat(100),
      copyright: '©'.repeat(150),
      location: 'l'.repeat(150),
      camera: 'k'.repeat(100),
      lens: 'z'.repeat(100),
      keywords: Array.from({ length: 20 }, (_, i) => `kw-${i}-${'k'.repeat(55)}`),
      dateOriginal: '2026-11-22T14:05:09+05:30',
      aperture: 'f/2.8',
      shutter: '1/250 s',
      iso: 6400,
      focalLength: '35 mm',
    }
    expect(te.encode(JSON.stringify(exif)).length).toBeLessThan(3 * 1024)
  })
})

describe('localFolderCandidate', () => {
  test('claims a real directory, delegates everything else', async () => {
    expect((await localFolderCandidate(dir))?.provider).toBe('local')
    expect(await localFolderCandidate('/no-such-owner')).toBeNull()
    expect(await localFolderCandidate('/')).toBeNull()
  })
})

describe('serveLocalMedia confinement', () => {
  test('serves a scanned file with its content type', async () => {
    await scanLocalFolder(dir)
    const response = await serveLocalMedia(new URL(`http://localhost/api/local/file?path=${encodeURIComponent(join(dir, 'a.png'))}`), null)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
  })

  test('honours a Range request', async () => {
    const response = await serveLocalMedia(new URL(`http://localhost/api/local/file?path=${encodeURIComponent(join(dir, 'a.png'))}`), 'bytes=0-9')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toMatch(/^bytes 0-9\//)
    expect((await response.arrayBuffer()).byteLength).toBe(10)
  })

  test('refuses files outside a scanned root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'manorama-outside-'))
    writeFileSync(join(outside, 'secret.png'), pngBytes(2, 2))
    const response = await serveLocalMedia(new URL(`http://localhost/api/local/file?path=${encodeURIComponent(join(outside, 'secret.png'))}`), null)
    expect(response.status).toBe(404)
    rmSync(outside, { recursive: true, force: true })
  })

  test('refuses non-media extensions inside a scanned root', async () => {
    const response = await serveLocalMedia(new URL(`http://localhost/api/local/file?path=${encodeURIComponent(join(dir, 'notes.txt'))}`), null)
    expect(response.status).toBe(404)
  })
})

describe('canonicalSourceMatches for local', () => {
  test('equivalent spellings of one folder match', () => {
    expect(canonicalSourceMatches(`file://${dir}`, dir)).toBe(true)
    expect(canonicalSourceMatches(`file://${dir}`, `file://${dir}/`)).toBe(true)
    expect(canonicalSourceMatches(`file://${dir}`, 'file:///elsewhere')).toBe(false)
  })
})

describe('normalizeLocalPathString', () => {
  test('collapses the double-slash a quick-add paste produces', () => {
    expect(normalizeLocalPathString('file:////Users/x/album')).toBe('/Users/x/album')
    expect(normalizeLocalPathString('//Users/x/album/')).toBe('/Users/x/album')
  })
})
