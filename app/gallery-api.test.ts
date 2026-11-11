import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, getGallery, resetGalleryStore } from './lib/gallery-repository'
import type { GalleryImage } from './lib/imagesource'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { createNativeHandoffToken, createSessionToken } from './lib/session'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let api: ReturnType<typeof createManoramaApi>
let cookie: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
  api = createManoramaApi()

  // Seed a runtime gallery (no DB binding -> in-memory store) plus a second
  // one that serves as a guaranteed slug-collision target.
  await createGallery(TEST_OWNER.accountId, {
    slug: 'test-gallery',
    title: 'Test Gallery',
    caption: '',
    date: '',
    createdAt: '2026-09-04T00:00:00.000Z',
    images: [{ id: 'test-image', filename: 'test.jpg', src: '/api/dropbox/file?sourceUrl=test', width: 1200, height: 800, alt: 'Test image', c2pa: false, placeholder: "" }],
  })
  await createGallery(TEST_OWNER.accountId, {
    slug: 'test-other',
    title: 'Other Gallery',
    caption: '',
    date: '',
    images: [],
  })
})

const patch = (slug: string, body: object) =>
  api.request(`/api/galleries/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }, env)

describe('native gallery API', () => {
  test('exchanges only a purpose-bound native handoff token', async () => {
    const handoffToken = await createNativeHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const response = await api.request('/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'capacitor://localhost' },
      body: JSON.stringify({ handoffToken }),
    }, env)
    expect(response.status).toBe(200)
    const payload = await response.json() as { token?: string }
    expect(typeof payload.token).toBe('string')

    const normalToken = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const rejected = await api.request('/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'capacitor://localhost' },
      body: JSON.stringify({ handoffToken: normalToken }),
    }, env)
    expect(rejected.status).toBe(401)
  })

  test('returns a public manifest and viewer settings with Capacitor CORS', async () => {
    const response = await api.request('/api/gallery/test-owner/test-gallery', {
      headers: { Origin: 'capacitor://localhost' },
    }, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    const payload = await response.json() as {
      manifest?: { slug?: string; title?: string; images?: { id: string }[] }
      settings?: { defaultMode?: string; imageAlts?: Record<string, string> }
    }
    expect(payload.manifest?.slug).toBe('test-gallery')
    expect(payload.manifest?.title).toBe('Test Gallery')
    expect(payload.manifest?.images?.map((image) => image.id)).toEqual(['test-image'])
    expect(payload.settings?.defaultMode).toBe('strip')
    expect(payload.settings?.imageAlts?.['test-image']).toBe('Test image')
  })

  test('answers native CORS preflight without requiring a session', async () => {
    const response = await api.request('/api/gallery/test-owner/test-gallery', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    }, env)
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')
  })

  test('answers Capacitor preflight and rejects every other origin boundary', async () => {
    const preflight = (origin: string) => api.request('/api/gallery/test-owner/test-gallery', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      },
    }, env)

    const capacitor = await preflight('capacitor://localhost')
    expect(capacitor.status).toBe(204)
    expect(capacitor.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    expect(capacitor.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')

    const android = await preflight('https://localhost')
    expect(android.status).toBe(204)
    expect(android.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost')
    expect(android.headers.get('Access-Control-Allow-Headers')).toContain('Authorization')

    for (const origin of [
      'http://localhost.localdomain',
      'http://example.com',
      'not-an-origin',
    ]) {
      const response = await preflight(origin)
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(response.headers.get('Access-Control-Allow-Headers')).toBeNull()
    }
  })

  test('streaming media responses carry the shell CORS headers a native fetch() needs', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })) as typeof fetch
    try {
      const fileEnv = { ...env, DROPBOX_APP_KEY: 'test-key', DROPBOX_APP_SECRET: 'test-secret' }
      const url = `/api/dropbox/file?sourceUrl=${encodeURIComponent('https://www.dropbox.com/scl/fo/abc123/AAAA?dl=0')}&filename=test.jpg`
      const native = await api.request(url, { headers: { Origin: 'capacitor://localhost' } }, fileEnv)
      expect(native.status).toBe(200)
      expect(native.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
      expect(native.headers.get('Vary')?.toLowerCase()).toContain('origin')
      const foreign = await api.request(url, { headers: { Origin: 'http://example.com' } }, fileEnv)
      expect(foreign.status).toBe(200)
      expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull()
      // A cacheable media response must still vary on Origin for callers that
      // were not granted it.
      expect(foreign.headers.get('Vary')?.toLowerCase()).toContain('origin')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the cacheable thumbnail proxy carries Vary and CORS too', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      })) as typeof fetch
    try {
      const fileEnv = { ...env, DROPBOX_APP_KEY: 'test-key', DROPBOX_APP_SECRET: 'test-secret' }
      const url = `/api/dropbox/thumbnail?sourceUrl=${encodeURIComponent('https://www.dropbox.com/scl/fo/abc123/AAAA?dl=0')}&filename=test.jpg`
      const native = await api.request(url, { headers: { Origin: 'capacitor://localhost' } }, fileEnv)
      expect(native.status).toBe(200)
      expect(native.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
      expect(native.headers.get('Vary')?.toLowerCase()).toContain('origin')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('does not disclose a missing public gallery', async () => {
    const response = await api.request('/api/gallery/test-owner/missing', {}, env)
    expect(response.status).toBe(404)
  })
})

describe('slug rename contract', () => {
  test('renames via body newSlug, not body slug', async () => {
    const response = await patch('test-gallery', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('the URL slug stays the resource identity: the old slug is gone', async () => {
    const response = await patch('test-gallery', { title: 'Stale' })
    expect(response.status).toBe(404)
  })

  test('a body-level replacement slug is no longer accepted', async () => {
    const response = await patch('test-renamed', { slug: 'something-else' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Provide a gallery URL, metadata, or an image order to update' })
  })

  test('an invalid newSlug is rejected with the URL guidance', async () => {
    const response = await patch('test-renamed', { newSlug: 'Not A Valid Slug' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' })
  })

  test('renaming onto an existing slug reports a collision', async () => {
    // The seeded test-other gallery is a guaranteed collision target.
    const response = await patch('test-renamed', { newSlug: 'test-other' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That gallery URL is already in use' })
  })

  test('a no-op rename returns the unchanged gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('metadata combines with newSlug and lands on the renamed gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-final', title: 'Final Title' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string; title: string } }
    expect(payload.gallery?.slug).toBe('test-final')
    expect(payload.gallery?.title).toBe('Final Title')
    // Metadata was NOT applied to the pre-rename identity.
    expect((await patch('test-renamed', { caption: 'x' })).status).toBe(404)
  })

  test('a missing gallery reports 404 for rename attempts', async () => {
    const response = await patch('never-created', { newSlug: 'whatever' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'That gallery was not found' })
  })

  test('the web owner panel sends newSlug when editing the slug', () => {
    // The Address editor lives in the shared OwnerGalleryPanel the Library
    // settings sheet hosts — Admin itself no longer carries the field.
    const panel = readFileSync(`${repoRoot}/app/components/viewer/OwnerGalleryPanel.tsx`, 'utf8')
    expect(panel).toContain('newSlug')
  })
})

describe('owner URL changes', () => {
  test('rejects an invalid URL with friendly guidance', async () => {
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'Not Valid!' }),
    }, env)
    expect(response.status).toBe(422)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toContain('lowercase letters')
  })

  test('changes the owner URL and galleries follow the account', async () => {
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'renamed-owner' }),
    }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ownerSlug: 'renamed-owner' })
    // The seeded gallery is still reachable under the new owner URL.
    const list = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const payload = await list.json() as { galleries?: { slug: string }[] }
    expect(payload.galleries?.some((gallery) => gallery.slug === 'test-final')).toBe(true)
  })

  test('rejects a URL already taken by another owner', async () => {
    await seedTestUser({ accountId: 'dbid:AAATOTHERuser', displayName: 'Taken Name' })
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'taken-name' }),
    }, env)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That URL is already in use' })
  })
})

describe('galleries beyond the free allowance', () => {
  test('a fourth gallery is created as a temporary pipeline gallery', async () => {
    // test-final (from the rename suite) plus these two fills the free
    // allowance; the next create is the fourth.
    await createGallery(TEST_OWNER.accountId, { slug: 'filler-two', title: 'Filler Two', caption: '', date: '', images: [] })
    await createGallery(TEST_OWNER.accountId, { slug: 'filler-three', title: 'Filler Three', caption: '', date: '', images: [] })
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: [{ '.tag': 'file', name: 'one.jpg', id: 'id:one', media_info: { metadata: { dimensions: { width: 4, height: 3 } } } }],
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: 'Fourth Album' })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/fourth', title: 'Named Overflow' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { slug?: string; title?: string; retention?: string; expiresAt?: string | null } }
      expect(payload.gallery?.title).toBe('Named Overflow')
      expect(payload.gallery?.retention).toBe('pipeline')
      expect(payload.gallery?.expiresAt).toBeTruthy()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a caption supplied at create lands on the gallery', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: [{ '.tag': 'file', name: 'one.jpg', id: 'id:cap', media_info: { metadata: { dimensions: { width: 4, height: 3 } } } }],
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: 'Captioned Album' })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/captioned', title: 'With Caption', caption: 'a "quoted" line about the set' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { caption?: string } }
      expect(payload.gallery?.caption).toBe('a “quoted” line about the set')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('quick-add naming', () => {
  const stubScan = (name: string) => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: [{ '.tag': 'file', name: 'one.jpg', id: 'id:one', media_info: { metadata: { dimensions: { width: 4, height: 3 } } } }],
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    return () => { globalThis.fetch = realFetch }
  }

  test('a quick create names the gallery three hyphenated words', async () => {
    const restore = stubScan('Camera Roll Dump')
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/quick-one', quick: true, title: 'Quick Name Must Not Win' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { slug?: string; title?: string } }
      // The folder name is ignored entirely — title AND slug carry the
      // generated words, so the shared URL reads like the title.
      expect(payload.gallery?.title).toMatch(/^[a-z]+(-[a-z]+){2}$/)
      expect(payload.gallery?.slug).toMatch(new RegExp(`^${payload.gallery!.title!}(-\\d+)?$`))
    } finally {
      restore()
    }
  })

  test('a dashboard create keeps the scanned folder name', async () => {
    const restore = stubScan('Family Album')
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/dash-one' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { slug?: string; title?: string } }
      expect(payload.gallery?.title).toBe('Family Album')
      expect(payload.gallery?.slug).toBe('family-album')
    } finally {
      restore()
    }
  })

  test('an ordinary create uses its optional validated name', async () => {
    const restore = stubScan('Provider Album')
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/named-one', title: '  My Named Album  ' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { slug?: string; title?: string } }
      expect(payload.gallery?.title).toBe('My Named Album')
      expect(payload.gallery?.slug).toBe('my-named-album')
    } finally {
      restore()
    }
  })

  test('a blank optional name falls back to the provider title', async () => {
    const restore = stubScan('Provider Album')
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/unnamed-one', title: '   ' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { title?: string } }
      expect(payload.gallery?.title).toBe('Provider Album')
    } finally {
      restore()
    }
  })
})

describe('source ordering', () => {
  // A dedicated owner: TEST_OWNER's allowance is already spent on earlier
  // describes, so its further seeds land as read-only pipeline galleries.
  const ORDER_OWNER = 'dbid:AAATESTordering'
  let orderCookie: string

  const stubListing = (names: string[], folderName = 'Sorted Album') => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: names.map((name) => ({ '.tag': 'file' as const, name, id: `id:${name}`, media_info: { metadata: { dimensions: { width: 4, height: 3 } } } })),
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: folderName })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    return () => { globalThis.fetch = realFetch }
  }

  const seedImage = (filename: string): GalleryImage => ({
    id: `seed-${filename}`,
    filename,
    src: `/api/dropbox/file?filename=${filename}`,
    width: 4,
    height: 3,
    alt: filename,
    c2pa: false,
    placeholder: '',
  })

  test('a fresh gallery stores images in ascending filename order', async () => {
    await seedTestUser({ accountId: ORDER_OWNER, displayName: 'Order Owner' })
    orderCookie = await sessionCookieFor(ORDER_OWNER)
    // Provider order is arbitrary — numeric collation puts img2 before img10.
    const restore = stubListing(['zeta.jpg', 'img10.jpg', 'img2.jpg', 'alpha.jpg'])
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: orderCookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/ordered-one' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(201)
      const payload = await response.json() as { gallery?: { images?: { filename: string }[] } }
      expect(payload.gallery?.images?.map((image) => image.filename)).toEqual(['alpha.jpg', 'img2.jpg', 'img10.jpg', 'zeta.jpg'])
    } finally {
      restore()
    }
  })

  test('refresh keeps the owner order, drops deleted files, and appends new files sorted', async () => {
    await createGallery(ORDER_OWNER, {
      slug: 'ordered-source',
      title: 'Ordered Source',
      caption: '',
      date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/order-src?dl=0',
      // The owner hand-ordered d before a; z has since been deleted at the source.
      images: [seedImage('d.jpg'), seedImage('a.jpg'), seedImage('z.jpg')],
    })
    const restore = stubListing(['img10.jpg', 'c.jpg', 'a.jpg', 'img2.jpg', 'd.jpg'])
    try {
      const response = await api.request('/api/galleries/ordered-source/refresh', {
        method: 'POST',
        headers: { Cookie: orderCookie },
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(200)
      const payload = await response.json() as { gallery?: { images?: { filename: string }[] } }
      // z.jpg is gone; d,a keep the owner's order; c, img2, img10 append
      // in ascending filename order — img2 before img10, not lexical.
      expect(payload.gallery?.images?.map((image) => image.filename)).toEqual(['d.jpg', 'a.jpg', 'c.jpg', 'img2.jpg', 'img10.jpg'])
    } finally {
      restore()
    }
  })

  test('refresh rejects a scan the subrequest budget cut short', async () => {
    // Own owner — a partial-source seed must not spend ORDER_OWNER's
    // free allowance, or later seeds in this describe land read-only.
    const PARTIAL_OWNER = 'dbid:AAATESTpartial'
    await seedTestUser({ accountId: PARTIAL_OWNER, displayName: 'Partial Owner' })
    const partialCookie = await sessionCookieFor(PARTIAL_OWNER)
    await createGallery(PARTIAL_OWNER, {
      slug: 'partial-source',
      title: 'Partial Source',
      caption: '',
      date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/partial-src?dl=0',
      images: [seedImage('keep-1.jpg'), seedImage('keep-2.jpg')],
    })
    // No media_info — every entry costs dimension probes, so 1,000 files
    // outrun the scan's 950-request budget and come back flagged partial.
    const names = Array.from({ length: 1000 }, (_, index) => `img${String(index).padStart(4, '0')}.jpg`)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: names.map((name) => ({ '.tag': 'file' as const, name, id: `id:${name}` })),
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: 'Partial Album' })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries/partial-source/refresh', {
        method: 'POST',
        headers: { Cookie: partialCookie },
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      // Persisting the partial listing would drop source items the scan
      // never reached — the refresh is refused and the gallery stands.
      expect(response.status).toBe(422)
      const gallery = await getGallery(PARTIAL_OWNER, 'partial-source')
      expect(gallery?.images.map((image) => image.filename)).toEqual(['keep-1.jpg', 'keep-2.jpg'])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('an order write accepts and returns all 1,000 provider keys', async () => {
    const images = Array.from({ length: 1000 }, (_, index) => seedImage(`img${index + 1}.jpg`))
    await createGallery(ORDER_OWNER, {
      slug: 'ordered-thousand',
      title: 'Ordered Thousand',
      caption: '',
      date: '',
      images,
    })
    const order = [...images].reverse().map((image) => image.filename!)
    const response = await api.request('/api/galleries/ordered-thousand', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: orderCookie },
      body: JSON.stringify({ order }),
    }, env)
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { images?: { filename: string }[] } }
    expect(payload.gallery?.images).toHaveLength(1000)
    expect(payload.gallery?.images?.[0]?.filename).toBe('img1000.jpg')
    expect(payload.gallery?.images?.[999]?.filename).toBe('img1.jpg')
  })
})

describe('hidden photographs', () => {
  const HIDE_OWNER = 'dbid:AAATESThidden'
  let hideCookie: string
  let hideOwnerSlug: string

  const hideImage = (filename: string) => ({
    id: `id-${filename}`,
    filename,
    src: `/api/dropbox/file?filename=${filename}`,
    width: 4,
    height: 3,
    alt: filename,
    c2pa: false,
    placeholder: '',
  })

  beforeAll(async () => {
    const user = await seedTestUser({ accountId: HIDE_OWNER, displayName: 'Hide Owner' })
    hideOwnerSlug = user.ownerSlug
    hideCookie = await sessionCookieFor(HIDE_OWNER)
    await createGallery(HIDE_OWNER, {
      slug: 'hidden-source',
      title: 'Hidden Source',
      caption: '',
      date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/hidden-src?dl=0',
      images: [hideImage('a.jpg'), hideImage('b.jpg'), hideImage('c.jpg')],
    })
  })

  const hidePatch = (body: object) =>
    api.request('/api/galleries/hidden-source', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: hideCookie },
      body: JSON.stringify(body),
    }, env)

  const manifestImages = async (suffix = '', cookie?: string) => {
    const response = await api.request(`/api/gallery/${hideOwnerSlug}/hidden-source${suffix}`, cookie ? { headers: { Cookie: cookie } } : {}, env)
    expect(response.status).toBe(200)
    const payload = await response.json() as { manifest?: { images?: { filename: string }[] } }
    return payload.manifest?.images?.map((image) => image.filename) ?? []
  }

  test('a hidden-only write marks the flag and the owner summary carries it', async () => {
    const response = await hidePatch({ hidden: ['b.jpg'] })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { images?: { filename: string; hidden?: boolean }[] } }
    expect(payload.gallery?.images?.find((image) => image.filename === 'b.jpg')?.hidden).toBe(true)
    expect(payload.gallery?.images?.find((image) => image.filename === 'a.jpg')?.hidden).toBeUndefined()
  })

  test('the public manifest drops hidden items for everyone', async () => {
    expect(await manifestImages()).toEqual(['a.jpg', 'c.jpg'])
    // includeHidden without an owner session resolves to a member at best —
    // the hidden flag is never public data.
    expect(await manifestImages('?includeHidden=1')).toEqual(['a.jpg', 'c.jpg'])
    expect(await manifestImages('?includeHidden=1', cookie)).toEqual(['a.jpg', 'c.jpg'])
  })

  test('the owner session alone gets the hidden items back', async () => {
    expect(await manifestImages('?includeHidden=1', hideCookie)).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
  })

  test('an empty hidden set restores every photograph', async () => {
    const response = await hidePatch({ hidden: [] })
    expect(response.status).toBe(200)
    expect(await manifestImages()).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    // Re-hide for the refresh test below.
    expect((await hidePatch({ hidden: ['b.jpg'] })).status).toBe(200)
  })

  test('refresh keeps hidden items hidden instead of resurrecting them', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files/list_folder')) {
        return Response.json({
          entries: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map((name) => ({ '.tag': 'file' as const, name, id: `id:${name}`, media_info: { metadata: { dimensions: { width: 4, height: 3 } } } })),
          cursor: '',
          has_more: false,
        })
      }
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: 'Hidden Source' })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries/hidden-source/refresh', {
        method: 'POST',
        headers: { Cookie: hideCookie },
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(200)
      const stored = await getGallery(HIDE_OWNER, 'hidden-source')
      expect(stored?.images.find((image) => image.filename === 'b.jpg')?.hidden).toBe(true)
      expect(await manifestImages()).toEqual(['a.jpg', 'c.jpg', 'd.jpg'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('add to library', () => {
  const ADOPT_MEMBER = 'dbid:AAATESTmember'
  let memberCookie: string
  let memberSlug: string
  let adoptOwnerSlug: string

  const adoptImage = (filename: string, hidden = false) => ({
    id: `id-${filename}`,
    filename,
    src: `/api/dropbox/file?filename=${filename}`,
    width: 4,
    height: 3,
    alt: filename,
    c2pa: false,
    placeholder: '',
    ...(hidden ? { hidden: true as const } : {}),
  })

  beforeAll(async () => {
    const member = await seedTestUser({ accountId: ADOPT_MEMBER, displayName: 'Adopt Member' })
    memberSlug = member.ownerSlug
    memberCookie = await sessionCookieFor(ADOPT_MEMBER)
    const owner = await seedTestUser({ accountId: 'dbid:AAATESTadoptowner', displayName: 'Adopt Owner' })
    adoptOwnerSlug = owner.ownerSlug
    await createGallery('dbid:AAATESTadoptowner', {
      slug: 'adopt-source',
      title: 'Adopt Source',
      caption: 'A captioned gallery',
      date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/adopt-src?dl=0',
      images: [adoptImage('a.jpg'), adoptImage('b.jpg', true), adoptImage('c.jpg')],
    })
  })

  const adopt = (body: object, cookie?: string) =>
    api.request('/api/galleries/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }, env)

  test('a visitor cannot adopt — the endpoint is session-gated', async () => {
    const response = await adopt({ owner: adoptOwnerSlug, slug: 'adopt-source' })
    expect(response.status).toBe(401)
  })

  test('the owner cannot adopt their own gallery', async () => {
    const ownerCookie = await sessionCookieFor('dbid:AAATESTadoptowner')
    const response = await adopt({ owner: adoptOwnerSlug, slug: 'adopt-source' }, ownerCookie)
    expect(response.status).toBe(400)
  })

  test('a member adopts a copy with only the visible manifest', async () => {
    const response = await adopt({ owner: adoptOwnerSlug, slug: 'adopt-source' }, memberCookie)
    expect(response.status).toBe(201)
    const payload = await response.json() as { gallery?: { slug?: string; title?: string; caption?: string; images?: { filename: string }[] }; galleryUrl?: string }
    expect(payload.gallery?.title).toBe('Adopt Source')
    expect(payload.gallery?.caption).toBe('A captioned gallery')
    // Hidden items never move — the member's copy holds exactly what they saw.
    expect(payload.gallery?.images?.map((image) => image.filename)).toEqual(['a.jpg', 'c.jpg'])
    expect(payload.galleryUrl).toBe(`/${memberSlug}/adopt-source`)
    const stored = await getGallery(ADOPT_MEMBER, 'adopt-source')
    expect(stored?.sourceUrl).toBe('https://www.dropbox.com/scl/fo/adopt-src?dl=0')
    expect(stored?.images.length).toBe(2)
  })

  test('a second adopt resolves to the existing copy instead of duplicating', async () => {
    const response = await adopt({ owner: adoptOwnerSlug, slug: 'adopt-source' }, memberCookie)
    expect(response.status).toBe(409)
    const payload = await response.json() as { galleryUrl?: string }
    expect(payload.galleryUrl).toBe(`/${memberSlug}/adopt-source`)
  })

  test('a missing gallery answers 404, an unknown owner answers 404', async () => {
    expect((await adopt({ owner: adoptOwnerSlug, slug: 'not-there' }, memberCookie)).status).toBe(404)
    expect((await adopt({ owner: 'no-such-owner', slug: 'adopt-source' }, memberCookie)).status).toBe(404)
  })
})

describe('pinning and the lean library', () => {
  const pixel = (id: string) => ({ id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3, alt: '', c2pa: false, placeholder: '' })
  const seed = async (slug: string, minutesAgo = 0) => {
    const { createGallery } = await import('./lib/gallery-repository')
    return createGallery(TEST_OWNER.accountId, {
      slug, title: slug, caption: '', date: '',
      createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      images: [pixel(`${slug}-item`)],
    })
  }
  const patchPin = (slug: string, pinned: boolean) =>
    api.request(`/api/galleries/${slug}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ pinned }),
    }, env)

  test('a pro owner pins any number of galleries, and unpin keeps retention', async () => {
    const { setUserTier } = await import('./lib/user-repository')
    await setUserTier(TEST_OWNER.accountId, 'pro')
    await seed('pin-me')
    // Visionary pins any number — no strip cap refuses a fourth pin.
    for (let index = 0; index < 4; index += 1) {
      await seed(`pin-many-${index}`, index + 30)
      expect((await patchPin(`pin-many-${index}`, true)).status).toBe(200)
    }
    const pinned = await patchPin('pin-me', true)
    expect(pinned.status).toBe(200)
    const payload = await pinned.json() as { gallery?: { pinnedAt?: string | null } }
    expect(payload.gallery?.pinnedAt).toBeTruthy()
    const unpinned = await patchPin('pin-me', false)
    expect(unpinned.status).toBe(200)
    const after = await unpinned.json() as { gallery?: { pinnedAt?: string | null; retention?: string } }
    expect(after.gallery?.pinnedAt).toBeNull()
    expect(after.gallery?.retention).toBe('retained')
  })

  test('the metadata PATCH honors pinned for a retained gallery through the same policy', async () => {
    const { setUserTier } = await import('./lib/user-repository')
    await setUserTier(TEST_OWNER.accountId, 'pro')
    const response = await patch('pin-many-0', { pinned: true })
    expect(response.status).toBe(200)
  })

  test('the pin is layout-only — it never moves retention or expiry', async () => {
    const { setUserTier } = await import('./lib/user-repository')
    const { resetGalleryStore, getStoredGallery } = await import('./lib/gallery-repository')
    await setUserTier(TEST_OWNER.accountId, 'free')
    resetGalleryStore()
    for (let index = 0; index < 3; index += 1) await seed(`free-keep-${index}`, index + 10)
    await seed('free-temp', 40)
    // A temporary gallery pins fine — permanence is not for sale here.
    const pinned = await patchPin('free-temp', true)
    expect(pinned.status).toBe(200)
    const after = await getStoredGallery(TEST_OWNER.accountId, 'free-temp')
    expect(after?.pinnedAt).toBeTruthy()
    expect(after?.retention).toBe('pipeline')
    expect(after?.expiresAt).toBeTruthy()
    // And an unpin hands nothing back — no fresh window, no demotion.
    const unpin = await patchPin('free-keep-0', false)
    expect(unpin.status).toBe(200)
    const kept = await getStoredGallery(TEST_OWNER.accountId, 'free-keep-0')
    expect(kept?.pinnedAt).toBeNull()
    expect(kept?.retention).toBe('retained')
    expect(kept?.expiresAt).toBeNull()
    await setUserTier(TEST_OWNER.accountId, 'pro')
  })

  test('the swap route exchanges permanence, expiry and position', async () => {
    const { setUserTier } = await import('./lib/user-repository')
    const { resetGalleryStore, getStoredGallery } = await import('./lib/gallery-repository')
    await setUserTier(TEST_OWNER.accountId, 'free')
    resetGalleryStore()
    for (let index = 0; index < 3; index += 1) await seed(`swap-keep-${index}`, index + 10)
    await seed('swap-temp', 40)
    // All three permanent slots are spoken for — a bare ask is the
    // chooser answer, not a silent demote.
    const refused = await api.request('/api/galleries/swap-temp/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    }, env)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { code?: string }).code).toBe('PIN_LIMIT')
    // The named swap exchanges permanence, expiry and pinned position.
    const temp = await getStoredGallery(TEST_OWNER.accountId, 'swap-temp')
    await patchPin('swap-keep-0', true)
    const response = await api.request('/api/galleries/swap-temp/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ with: 'swap-keep-0' }),
    }, env)
    expect(response.status).toBe(200)
    const incoming = await getStoredGallery(TEST_OWNER.accountId, 'swap-temp')
    const outgoing = await getStoredGallery(TEST_OWNER.accountId, 'swap-keep-0')
    // Position and permanence cross together: the temp takes the
    // victim's pin, the victim takes the temp's own clock — not a fresh
    // thirty days.
    expect(incoming?.retention).toBe('retained')
    expect(incoming?.expiresAt).toBeNull()
    expect(incoming?.pinnedAt).toBeTruthy()
    expect(outgoing?.retention).toBe('pipeline')
    expect(outgoing?.expiresAt).toBe(temp?.expiresAt)
    expect(outgoing?.pinnedAt).toBeNull()
    // A slot opens (a delete): the bare request promotes the pipeline
    // row that is still temporary — no victim needed.
    const { deleteGallery } = await import('./lib/gallery-repository')
    await deleteGallery(TEST_OWNER.accountId, 'swap-keep-2')
    const kept = await api.request('/api/galleries/swap-keep-0/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    }, env)
    expect(kept.status).toBe(200)
    expect((await getStoredGallery(TEST_OWNER.accountId, 'swap-keep-0'))?.retention).toBe('retained')
    await setUserTier(TEST_OWNER.accountId, 'pro')
  })

  test('GET /api/galleries/:slug returns the full summary, 404 when missing', async () => {
    const { setUserTier } = await import('./lib/user-repository')
    await setUserTier(TEST_OWNER.accountId, 'pro')
    await seed('pin-me')
    expect((await patchPin('pin-me', true)).status).toBe(200)
    const found = await api.request('/api/galleries/pin-me', { headers: { Cookie: cookie } }, env)
    expect(found.status).toBe(200)
    const payload = await found.json() as { gallery?: { slug?: string; images?: unknown[]; pinnedAt?: string | null } }
    expect(payload.gallery?.slug).toBe('pin-me')
    expect(payload.gallery?.pinnedAt).toBeTruthy()
    const missing = await api.request('/api/galleries/not-a-gallery', { headers: { Cookie: cookie } }, env)
    expect(missing.status).toBe(404)
  })

  test('GET /api/library returns lean summaries with a layout field', async () => {
    const response = await api.request('/api/library', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    const payload = await response.json() as { galleries?: { slug: string; layout: string; images: unknown[]; pinnedAt?: string | null }[] }
    const galleries = payload.galleries ?? []
    expect(galleries.every((summary) => summary.layout === 'strip' || summary.layout === 'compact')).toBe(true)
    expect(galleries.filter((summary) => summary.layout === 'strip').length).toBeLessThanOrEqual(10)
    expect(galleries.filter((summary) => summary.layout === 'compact').every((summary) => summary.images.length <= 1)).toBe(true)
    // Every pinned gallery is in the strip set.
    const stripSlugs = galleries.filter((summary) => summary.layout === 'strip').map((summary) => summary.slug)
    expect(galleries.filter((summary) => summary.pinnedAt).every((summary) => stripSlugs.includes(summary.slug))).toBe(true)
  })

  test('GET /api/galleries is unchanged — strip galleries keep every image', async () => {
    const { createGallery } = await import('./lib/gallery-repository')
    await createGallery(TEST_OWNER.accountId, {
      slug: 'full-list', title: 'Full', caption: '', date: '',
      createdAt: new Date(Date.now() - 30_000).toISOString(),
      images: Array.from({ length: 20 }, (_, index) => ({ id: `fl-${index}`, filename: `fl-${index}.jpg`, src: `/images/fl-${index}.jpg`, width: 4, height: 3, alt: '', c2pa: false, placeholder: '' })),
    })
    const response = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const payload = await response.json() as { galleries?: { slug: string; images: unknown[] }[] }
    expect(payload.galleries?.find((summary) => summary.slug === 'full-list')?.images).toHaveLength(20)
  })
})

describe('the key vault routes', () => {
  const vaultBody = { version: 1, kdfSalt: 'c2FsdA', kdfIterations: 600_000, wrappedVk: 'Y2lwaGVy', vkNonce: 'bm9uY2U' }

  test('PUT then GET /api/account/key-vault round-trips ciphertext only', async () => {
    const missing = await api.request('/api/account/key-vault', { headers: { Cookie: cookie } }, env)
    expect(missing.status).toBe(200)
    expect(((await missing.json()) as { vault: unknown }).vault).toBeNull()
    const put = await api.request('/api/account/key-vault', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...vaultBody, expectedUpdatedAt: null }),
    }, env)
    expect(put.status).toBe(200)
    const got = await api.request('/api/account/key-vault', { headers: { Cookie: cookie } }, env)
    const vault = ((await got.json()) as { vault: Record<string, unknown> }).vault
    expect(vault).toMatchObject(vaultBody)
    // A second create-only PUT conflicts and hands back the survivor; a
    // replace stamped against that row's updatedAt lands.
    const second = await api.request('/api/account/key-vault', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...vaultBody, wrappedVk: 'b3RoZXI', expectedUpdatedAt: null }),
    }, env)
    expect(second.status).toBe(409)
    const surviving = ((await second.json()) as { vault: Record<string, unknown> }).vault
    expect(surviving.wrappedVk).toBe('Y2lwaGVy')
    const replaced = await api.request('/api/account/key-vault', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...vaultBody, wrappedVk: 'b3RoZXI', expectedUpdatedAt: surviving.updatedAt }),
    }, env)
    expect(replaced.status).toBe(200)
  })

  test('PUT /api/account/key-vault rejects malformed payloads', async () => {
    for (const body of [
      {},
      { ...vaultBody, kdfIterations: 10 },
      { ...vaultBody, version: 2 },
      { ...vaultBody, wrappedVk: '' },
      // The compare-and-swap token is mandatory — an unconditional write
      // is exactly the clobber this endpoint refuses.
      vaultBody,
      { ...vaultBody, expectedUpdatedAt: 7 },
    ]) {
      const response = await api.request('/api/account/key-vault', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
      }, env)
      expect(response.status).toBe(400)
    }
  })

  test('gallery keys PUT/GET by slug, 404 on unknown gallery, 400 on bad blob', async () => {
    const { createGallery } = await import('./lib/gallery-repository')
    await createGallery(TEST_OWNER.accountId, {
      id: 'vaulted-gallery-id-1', slug: 'vaulted', title: 'Vaulted', caption: '', date: '', images: [],
    })
    const put = await api.request('/api/galleries/vaulted/key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ wrappedSource: 'd3JhcHBlZA', nonce: 'bm9uY2Ux', expectedUpdatedAt: null }),
    }, env)
    expect(put.status).toBe(200)
    // A second create-only write conflicts rather than overwriting.
    const second = await api.request('/api/galleries/vaulted/key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ wrappedSource: 'b3RoZXI', nonce: 'bm9uY2Uy', expectedUpdatedAt: null }),
    }, env)
    expect(second.status).toBe(409)
    const got = await api.request('/api/galleries/vaulted/key', { headers: { Cookie: cookie } }, env)
    const key = ((await got.json()) as { key: { wrappedSource: string } | null }).key
    expect(key?.wrappedSource).toBe('d3JhcHBlZA')

    const missing = await api.request('/api/galleries/no-such/key', { headers: { Cookie: cookie } }, env)
    expect(missing.status).toBe(404)
    const bad = await api.request('/api/galleries/vaulted/key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ wrappedSource: '' }),
    }, env)
    expect(bad.status).toBe(400)
  })

})
