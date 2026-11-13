import { describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'

/**
 * The public image proxies relay whatever Content-Type the provider chose,
 * overriding it only when it is absent or application/octet-stream
 * (`streamResponse`). Google Drive reports the file's real metadata type, so
 * a publicly shared `.html` returns `text/html` — and because no CSP exists
 * anywhere in the app, that document executes on manorama.xyz. The session
 * cookie is httpOnly, but every same-origin fetch carries it and
 * `/api/account` hands back the owner slug that `DELETE /api/account` needs,
 * so one click on a proxy URL is a session ride.
 *
 * These tests pin the type to the sniffed image format.
 */

const HTML_BYTES = new TextEncoder().encode('<!doctype html><html><body><script>alert(1)</script></body></html>')
const JPEG_PREFIX = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])

const withFetch = async (
  stub: (url: string) => Response,
  run: () => Promise<void>,
) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => stub(String(input))) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

const api = createManoramaApi()
const driveEnv = { GOOGLE_DRIVE_API_KEY: 'test-key' }

describe('proxy response types', () => {
  test('an HTML file from Drive is not served as text/html', async () => {
    await withFetch(
      () => new Response(HTML_BYTES, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } }),
      async () => {
        const response = await api.request('/api/drive/file?id=testHtmlFileId', {}, driveEnv)
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
      },
    )
  })

  test('a Drive file labelled octet-stream is still sniffed to its real image type', async () => {
    // Dropbox and MEGA already depend on this; the fix must not lose it.
    await withFetch(
      () => new Response(JPEG_PREFIX, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      async () => {
        const response = await api.request('/api/drive/file?id=testJpegId', {}, driveEnv)
        expect(response.headers.get('Content-Type')).toBe('image/jpeg')
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      },
    )
  })

  test('an HTML file from a Drive thumbnail is a JPEG regardless of upstream', async () => {
    await withFetch(
      () => new Response(HTML_BYTES, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      async () => {
        const response = await api.request('/api/drive/thumbnail?id=testHtmlFileId', {}, driveEnv)
        expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
      },
    )
  })
})

describe('the Dropbox thumbnail size', () => {
  /** Reads the size the proxy actually sends upstream — the ThumbnailSize
   *  union is closed, so an invented tag fails the call, not just the size. */
  const requestedSize = async (size: string, filename = 'IMG_0001.jpg') => {
    const realFetch = globalThis.fetch
    let arg = ''
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      arg = (init?.headers as Record<string, string> | undefined)?.['Dropbox-API-Arg'] ?? ''
      return new Response(JPEG_PREFIX, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    try {
      const url = `/api/dropbox/thumbnail?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc&filename=${filename}&size=${size}`
      expect((await api.request(url, {}, { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' })).status).toBe(200)
    } finally {
      globalThis.fetch = realFetch
    }
    return (JSON.parse(arg) as { size: string }).size
  }

  test('w2048h2048 — never a Dropbox size — maps onto the real largest box', async () => {
    // Manifests stored while the proxy emitted it still carry these URLs.
    expect(await requestedSize('w2048h2048')).toBe('w2048h1536')
  })

  test('the documented sizes pass through and anything else defaults to w256h256', async () => {
    expect(await requestedSize('w2048h1536')).toBe('w2048h1536')
    expect(await requestedSize('w1024h768')).toBe('w1024h768')
    expect(await requestedSize('w480h320')).toBe('w256h256')
  })

  test('HEIC still clamps the largest box to w1024h768, legacy spelling included', async () => {
    expect(await requestedSize('w2048h1536', 'IMG_0001.HEIC')).toBe('w1024h768')
    expect(await requestedSize('w2048h2048', 'IMG_0001.HEIC')).toBe('w1024h768')
  })
})

describe('proxy coalescing', () => {
  /**
   * Shared caching was considered and declined: invariant 1 keeps provider
   * bytes out of any shared cache, so `private, max-age=300` stays. The
   * bound instead is in-isolate coalescing — identical in-flight requests
   * for the same rendition share one upstream call.
   */
  test('identical concurrent requests are coalesced into one upstream call', async () => {
    const realFetch = globalThis.fetch
    let upstream = 0
    globalThis.fetch = (async () => {
      upstream += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return new Response(JPEG_PREFIX, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    try {
      const url = '/api/dropbox/thumbnail?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc&filename=IMG_0001.jpg'
      const env = { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' }
      const responses = await Promise.all(Array.from({ length: 25 }, () => api.request(url, {}, env)))
      expect(responses.every((response) => response.status === 200)).toBe(true)
      expect(upstream).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
