import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalSourceMatches, detectSource } from './sources'
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
