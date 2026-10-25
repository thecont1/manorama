import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManoramaApi } from './api'
import renderer from './routes/_renderer'
import ownerPage from './routes/[owner]'
import { scanLocalFolder } from './lib/local-source'
import { resetUserStore } from './lib/user-repository'
import { resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

/**
 * The response-header surface.
 *
 * Two things live here. First, guards: the CORS reflect-allowlist is
 * correct and must stay correct, the shell origins are the only ones that
 * may read a response, `nosniff` is set on every byte-carrying proxy, and
 * the video range path deliberately echoes the CDN's own Content-Range and
 * Content-Length rather than recomputing them.
 *
 * Second, gaps. No page carries a Content-Security-Policy, no page is
 * frame-protected, nothing sends HSTS or Referrer-Policy, and JSON error
 * bodies go out without `nosniff`. The dashboard at /:owner is the surface
 * that matters: it holds one-click gallery deletion and the URL rename form,
 * and it is framable.
 */

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let cookie: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
})

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

const dashboard = () => {
  const app = new Hono()
  app.use(honoxContext)
  app.use(renderer)
  mountRoute(app, '/:owner', ownerPage)
  return app
}

const dashResponse = async () => {
  const response = await dashboard().request('/test-owner', { headers: { Cookie: cookie } }, env)
  await response.text()
  return response
}

describe('page security headers', () => {
  test('the dashboard is not framable', async () => {
    const response = await dashResponse()
    expect(response.status).toBe(200)
    const framing = response.headers.get('X-Frame-Options')
    const policy = response.headers.get('Content-Security-Policy') ?? ''
    expect(Boolean(framing) || /frame-ancestors/.test(policy)).toBe(true)
  })

  test('the dashboard carries a Content-Security-Policy', async () => {
    const response = await dashResponse()
    expect(response.headers.get('Content-Security-Policy')).toBeTruthy()
  })

  test('transport and referrer policy are stated', async () => {
    const response = await dashResponse()
    expect(response.headers.get('Strict-Transport-Security') ?? '').toContain('max-age=')
    expect(response.headers.get('Referrer-Policy')).toBeTruthy()
  })
})

describe('nosniff coverage', () => {
  test('JSON error bodies are nosniffed too', async () => {
    // A proxy error body is text the browser may otherwise sniff as HTML.
    const response = await createManoramaApi().request('/api/galleries', {}, env)
    expect(response.status).toBe(401)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('an unsatisfiable local range answers 416 with nosniff and a cache header', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manorama-headers-'))
    // SOI + a 1x1 SOF0 frame header: the smallest thing probeImageDimensions reads.
    const jpeg = new Uint8Array(20)
    jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 1, 0, 1])
    await writeFile(join(directory, 'IMG_0001.jpg'), jpeg)
    const global = globalThis as { __manoramaLocalSources?: boolean }
    global.__manoramaLocalSources = true
    const scan = await scanLocalFolder(directory)
    const item = scan.images[0]!

    const response = await createManoramaApi().request(item.src, { headers: { Range: 'bytes=999-' } }, {})
    expect(response.status).toBe(416)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBeTruthy()
  })
})

describe('CORS allowlist', () => {
  const api = () => createManoramaApi()

  for (const origin of ['capacitor://localhost', 'tauri://localhost', 'https://localhost', 'http://localhost:5173']) {
    test(`reflects ${origin}`, async () => {
      const response = await api().request('/api/galleries', { headers: { Origin: origin } }, env)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      await response.text()
    })
  }

  for (const origin of ['https://evil.example', 'null', 'https://manorama.xyz']) {
    test(`does not reflect ${origin}`, async () => {
      const response = await api().request('/api/galleries', { headers: { Origin: origin } }, env)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      await response.text()
    })
  }

  test('the preflight never wildcards the origin or the methods', async () => {
    const response = await api().request('/api/galleries', {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost' },
    }, env)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('*')
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type')
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  test('a raw streamed response still gets the allow-origin it needs', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })) as typeof fetch
    try {
      const response = await api().request(
        '/api/dropbox/file?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fa&filename=x.jpg',
        { headers: { Origin: 'capacitor://localhost' } },
        { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
      )
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
      await response.arrayBuffer()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('range response headers', () => {
  test("the CDN's own Content-Range and Content-Length pass through untouched on a 206", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('/sharedstreams/')) {
        return new Response(JSON.stringify({
          items: { SYNTH: { url_location: 'L1', url_path: '/a.mp4' } },
          locations: { L1: { scheme: 'https', hosts: ['cvws.icloud-content.com'] } },
        }), { status: 200 })
      }
      return new Response(new Uint8Array(10), {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-9/4096', 'Content-Length': '10' },
      })
    }) as typeof fetch
    try {
      const response = await createManoramaApi().request(
        '/api/icloud/video?album=AbCdEf012345&photo=abc&c=SYNTH',
        { headers: { Range: 'bytes=0-9' } },
        {},
      )
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe('bytes 0-9/4096')
      expect(response.headers.get('Content-Length')).toBe('10')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      await response.arrayBuffer()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('scriptable image types', () => {
  test('an SVG from Drive is not served as a scriptable type', async () => {
    const realFetch = globalThis.fetch
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>'
    globalThis.fetch = (async () => new Response(new TextEncoder().encode(svg), {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    })) as typeof fetch
    try {
      const response = await createManoramaApi().request('/api/drive/file?id=SYNTH', {}, { GOOGLE_DRIVE_API_KEY: 'k' })
      // The bytes pass through, but as opaque data — never a same-origin
      // scriptable document.
      expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
      expect(await response.text()).toContain('<script>')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
