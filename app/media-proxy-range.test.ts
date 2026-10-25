import { describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'

/**
 * Originals are the whole file, every time. `/api/dropbox/file` and
 * `/api/mega/file` both drop the caller's Range header and re-fetch from
 * byte 0, while `/api/icloud/video` forwards it — so the three proxies do not
 * agree on a contract the browser media stack already speaks. For MEGA the
 * whole body is then decrypted in pure JS with ciphertext and plaintext
 * buffers coexisting, which is the most expensive request in the app.
 *
 * The same file also pins the log line: `proxyFailure` writes
 * `${filename} in ${sourceUrl}` to console.error with observability sampling
 * at 100%, so Dropbox rlkeys, iCloud album tokens and MEGA node keys all end
 * up in logs where the URL is the only secret.
 */

const JPEG_PREFIX = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])

type Captured = { url: string; headers: Record<string, string> }

const capture = async (
  stub: (url: string) => Response,
  run: () => Promise<void>,
): Promise<Captured[]> => {
  const realFetch = globalThis.fetch
  const seen: Captured[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return stub(url)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
  return seen
}

const api = createManoramaApi()

const dropboxStub = (url: string) =>
  url.includes('content.dropboxapi.com')
    ? new Response(JPEG_PREFIX, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
    : new Response('{}', { status: 200 })

const megaStub = (url: string) =>
  url.includes('g.api.mega.co.nz')
    ? new Response(JSON.stringify({ g: 'https://gfs.example/synthetic', s: 4096 }), { status: 200 })
    : new Response(new Uint8Array(4096), { status: 200 })

describe('range forwarding', () => {
  test('the Dropbox original proxy forwards the caller Range', async () => {
    const seen = await capture(dropboxStub, async () => {
      await api.request(
        '/api/dropbox/file?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc&filename=IMG_0001.jpg',
        { headers: { Range: 'bytes=0-1023' } },
        { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
      )
    })
    expect(seen[0]?.headers.range).toBe('bytes=0-1023')
  })

  test('the MEGA original proxy forwards the caller Range', async () => {
    const seen = await capture(megaStub, async () => {
      const response = await api.request(
        // 43 base64url chars = a 32-byte key — the file-key layout the
        // proxy now requires.
        `/api/mega/file?folder=SYNTH&node=SYNTHNODE&k=${'A'.repeat(43)}`,
        { headers: { Range: 'bytes=0-1023' } },
        {},
      )
      expect(response.status).toBe(206)
    })
    // The MEGA CDN URL takes the window as a path suffix, not a header.
    expect(seen.some((entry) => entry.url.endsWith('/0-1023'))).toBe(true)
  })
})

describe('proxy failure logging', () => {
  test('the logged reference carries the source URL so a failure is diagnosable', async () => {
    const realError = console.error
    const lines: string[] = []
    console.error = (...args: unknown[]) => { lines.push(JSON.stringify(args)) }
    try {
      await capture(
        () => new Response('', { status: 404 }),
        async () => {
          const response = await api.request(
            '/api/dropbox/file?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc%3Frlkey%3DSYNCKEY&filename=IMG_0001.jpg',
            {},
            { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
          )
          expect(response.status).toBe(404)
        },
      )
    } finally {
      console.error = realError
    }
    expect(lines.join('\n')).toContain('SYNCKEY')
  })

  test('the client-facing error body does not repeat the source URL', async () => {
    await capture(
      () => new Response('', { status: 404 }),
      async () => {
        const response = await api.request(
          '/api/dropbox/file?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc%3Frlkey%3DSYNCKEY&filename=IMG_0001.jpg',
          {},
          { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
        )
        const body = await response.text()
        expect(body).not.toContain('SYNCKEY')
        expect(body).toContain('Dropbox')
      },
    )
  })
})
