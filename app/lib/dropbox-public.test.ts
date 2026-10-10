import { describe, expect, test } from 'bun:test'
import { scanDropboxFolder } from './dropbox-public'

const env = { DROPBOX_APP_KEY: 'test-key', DROPBOX_APP_SECRET: 'test-secret' }
const FOLDER = 'https://www.dropbox.com/scl/fo/1AbCdEf/root?rlkey=0AbCdeF&dl=0'

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

const listing = (entries: unknown[]) => json({ entries, cursor: 'cursor-1', has_more: false })

/** The smallest JPEG that `parseJpegDimensions` will read: SOI, then an SOF0
 *  whose frame header carries the two numbers we are testing for. */
const jpeg = (width: number, height: number) => {
  const bytes = new Uint8Array(20)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08])
  bytes[7] = height >> 8
  bytes[8] = height & 0xff
  bytes[9] = width >> 8
  bytes[10] = width & 0xff
  return new Response(bytes, { status: 200 })
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  '.tag': 'file',
  name: 'MS201810-Italy0005.jpg',
  id: 'id:abc123',
  size: 9_000_000,
  ...overrides,
})

describe('scanDropboxFolder dimensions', () => {
  // The bug this pins down: every Dropbox gallery entered the manifest at
  // 256×171, the size of the preview the scanner probed, so the info sheet
  // reported a thumbnail's pixels as the photograph's.
  test("records the original's pixels, never the 256px preview's", async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) return listing([entry()])
      if (url.includes('sharing/get_shared_link_metadata')) return json({ name: 'Italy 2018' })
      if (url.includes('sharing/get_shared_link_file')) return jpeg(2560, 1707)
      if (url.includes('files/get_thumbnail_v2')) return jpeg(256, 171)
      return json({}, 404)
    }

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl as typeof fetch)

    expect(scan.images).toHaveLength(1)
    expect(scan.images[0]?.width).toBe(2560)
    expect(scan.images[0]?.height).toBe(1707)
    // The preview is still the placeholder rendition — it is only barred from
    // answering how big the photograph is.
    expect(scan.images[0]?.variants?.[0]?.width).toBe(256)
    expect(scan.images[0]?.placeholder).toContain('viewBox=\'0 0 2560 1707\'')
  })

  test("prefers the listing's own media_info and asks for no file bytes", async () => {
    const asked: string[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      asked.push(url)
      if (url.includes('files/list_folder')) {
        return listing([entry({ media_info: { metadata: { dimensions: { width: 6000, height: 4000 } } } })])
      }
      if (url.includes('sharing/get_shared_link_metadata')) return json({ name: 'Italy 2018' })
      throw new Error(`unexpected request: ${url}`)
    }

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl as typeof fetch)

    expect(scan.images[0]?.width).toBe(6000)
    expect(scan.images[0]?.height).toBe(4000)
    expect(asked.some((url) => url.includes('content.dropboxapi.com'))).toBe(false)
  })

  test('falls back to the preview when the original cannot be ranged', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) return listing([entry()])
      if (url.includes('sharing/get_shared_link_metadata')) return json({ name: 'Italy 2018' })
      if (url.includes('sharing/get_shared_link_file')) return new Response('conflict', { status: 409 })
      if (url.includes('files/get_thumbnail_v2')) return jpeg(256, 171)
      return json({}, 404)
    }

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl as typeof fetch)

    // Proportions, not truth — but a correctly shaped frame beats a 4:3 guess.
    expect(scan.images[0]?.width).toBe(256)
    expect(scan.images[0]?.height).toBe(171)
  })

  test('falls back to 4:3 when neither the original nor a preview answers', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) return listing([entry()])
      if (url.includes('sharing/get_shared_link_metadata')) return json({ name: 'Italy 2018' })
      return json({}, 409)
    }

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl as typeof fetch)

    expect(scan.images[0]?.width).toBe(4)
    expect(scan.images[0]?.height).toBe(3)
  })
})