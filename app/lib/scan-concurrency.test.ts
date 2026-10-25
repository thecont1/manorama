import { describe, expect, test } from 'bun:test'
import { scanDropboxFolder } from './dropbox-public'
import { scanDriveFolder } from './gdrive-public'

/**
 * `scanDropboxFolder` maps every listed entry through one `Promise.all`, so a
 * 1000-item album (MAX_GALLERY_ITEMS) opens a thousand simultaneous upstream
 * requests inside a single invocation — against a 90-second overall scan
 * deadline that then starts aborting mid-flight, and against Dropbox's
 * per-app limit that the public proxies share. MEGA batches at six, the local
 * scanner at eight, iCloud runs serially; Dropbox is the outlier.
 *
 * The listing loops are also unbounded ahead of the cap: `while (has_more)`
 * and the `do/while (pageToken)` in Drive both page the whole folder before a
 * single entry is dropped, so a 100k-file folder is fully enumerated to keep
 * a thousand.
 */

const env = { DROPBOX_APP_KEY: 'test-key', DROPBOX_APP_SECRET: 'test-secret' }
const FOLDER = 'https://www.dropbox.com/scl/fo/1AbCdEf/root?rlkey=0AbCdeF&dl=0'

const jpeg = () => {
  const bytes = new Uint8Array(20)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 1, 0, 1])
  return new Response(bytes, { status: 200 })
}

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

/** Counts in-flight provider requests, and only releases them after a tick. */
const concurrencyProbe = (stub: (url: string) => Response) => {
  const state = { inFlight: 0, peak: 0, calls: 0 }
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    state.calls += 1
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    state.inFlight -= 1
    return stub(url)
  }) as typeof fetch
  return { state, fetchImpl }
}

describe('dropbox scan fan-out', () => {
  test('never opens more than eight concurrent provider requests', async () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      '.tag': 'file',
      name: `IMG_${String(index).padStart(4, '0')}.jpg`,
      id: `id:abc${index}`,
    }))
    const { state, fetchImpl } = concurrencyProbe((url) => {
      if (url.includes('files/list_folder')) return json({ entries, cursor: 'c', has_more: false })
      if (url.includes('get_shared_link_metadata')) return json({ name: 'Album' })
      return jpeg()
    })

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl)

    expect(scan.images).toHaveLength(60)
    expect(state.peak).toBeLessThanOrEqual(8)
  })
})

describe('listing pagination ceiling', () => {
  test('a listing larger than the gallery cap does not page without bound', async () => {
    // 40 pages of 200 entries = 8000 files against a 1000-item cap.
    // media_info dims ride along like a real Dropbox payload, so the scan
    // spends zero probe subrequests.
    const page = Array.from({ length: 200 }, (_, index) => ({
      '.tag': 'file',
      name: `IMG_${String(index).padStart(4, '0')}.jpg`,
      id: `id:abc${index}`,
      media_info: { metadata: { dimensions: { width: 4000, height: 3000 } } },
    }))
    let pages = 0
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder/continue')) {
        pages += 1
        return json({ entries: page, cursor: `c${pages}`, has_more: pages < 39 })
      }
      if (url.includes('files/list_folder')) return json({ entries: page, cursor: 'c0', has_more: true })
      if (url.includes('get_shared_link_metadata')) return json({ name: 'Album' })
      return jpeg()
    }) as typeof fetch

    const scan = await scanDropboxFolder(FOLDER, env, fetchImpl)

    expect(scan.images).toHaveLength(1000)
    // Paging stops at the cap, so the reported total is a lower bound on
    // the album size, not the exact count.
    expect(scan.truncated).toBeGreaterThan(1000)
    // The cap is reached around page five; a dozen pages is a generous ceiling
    // that still fails the current unbounded `while (has_more)`.
    expect(pages).toBeLessThanOrEqual(12)
  })

  test('the Drive listing obeys the same ceiling', async () => {
    let pages = 0
    const files = Array.from({ length: 500 }, (_, index) => ({
      id: `file-${index}`,
      name: `IMG_${index}.jpg`,
      mimeType: 'image/jpeg',
      imageMediaMetadata: { width: 4, height: 3 },
    }))
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files?q=')) {
        pages += 1
        return json({ files, nextPageToken: pages < 19 ? `p${pages}` : undefined })
      }
      return json({ name: 'Album' })
    }) as typeof fetch

    const scan = await scanDriveFolder('https://drive.google.com/drive/folders/1AbC_-dEf', { GOOGLE_DRIVE_API_KEY: 'k' }, fetchImpl)

    expect(scan.images).toHaveLength(1000)
    expect(pages).toBeLessThanOrEqual(6)
  })
})
