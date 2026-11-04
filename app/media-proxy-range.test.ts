import { describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'

/**
 * Originals are the whole file, every time. `/api/dropbox/file` drops the
 * caller's Range header and re-fetches from byte 0, while
 * `/api/icloud/video` forwards it — the proxies do not agree on a contract
 * the browser media stack already speaks. The retired `/api/mega/file`
 * route is gone entirely: MEGA decrypt runs on the device.
 *
 * The same file also pins the log line: `proxyFailure` writes
 * `${filename} in ${sourceUrl}` to console.error with observability sampling
 * at 100%, so Dropbox rlkeys and iCloud album tokens end up in logs where
 * the URL is the only secret.
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

})

describe('proxy failure logging', () => {
  test('the logged reference keeps the filename but not the share key', async () => {
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
    expect(lines.join('\n')).not.toContain('SYNCKEY')
    expect(lines.join('\n')).toContain('IMG_0001.jpg')
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
