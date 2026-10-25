import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore, setUserTier, upsertUser } from './lib/user-repository'
import { sessionCookieFor, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { fetchMegaPreview } from './lib/mega-public'
import { FREE_RETAINED_LIMIT } from './lib/gallery-policy'

/**
 * The pipeline's platform ceilings.
 *
 * A Workers invocation may make 1000 subrequests. MAX_GALLERY_ITEMS is also
 * 1000, and the listing plus the title call sit on top of the per-item probes
 * — so the advertised cap is unreachable and a full album always dies on the
 * last two requests. The free plan's ceiling is 50, which a forty-image album
 * already breaks.
 *
 * Two more ceilings are absent rather than exceeded: `streamResponse` returns
 * a hard-coded 200 and drops Content-Range/Content-Length, so forwarding a
 * Range header to Dropbox buys nothing until the response side is fixed too;
 * and `fetchMegaPreview` has no size cap at all while caching what it fetches.
 */

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET, DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' }

const jpeg = () => {
  const bytes = new Uint8Array(20)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 1, 0, 1])
  return new Response(bytes, { status: 200 })
}

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })

const gallery = (slug: string) => ({
  slug,
  title: slug,
  caption: '',
  date: '',
  sourceUrl: `https://www.dropbox.com/scl/fo/${slug}?rlkey=R`,
  createdAt: new Date().toISOString(),
  images: [{ id: 'i', filename: 'IMG_0001.jpg', src: '/api/drive/thumbnail?id=X&size=w256', width: 4, height: 3, alt: 'a', c2pa: true, placeholder: '', variants: [] }],
})

let api: ReturnType<typeof createManoramaApi>

beforeAll(() => {
  resetUserStore()
  resetGalleryStore()
  api = createManoramaApi()
})

describe('subrequest budget', () => {
  test('a full-capped album stays inside the 1000-subrequest ceiling', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      '.tag': 'file', name: `IMG_${index}.jpg`, id: `id:abc${index}`,
    }))
    let calls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls += 1
      const url = String(input)
      if (url.includes('files/list_folder')) return json({ entries, cursor: 'c', has_more: false })
      if (url.includes('get_shared_link_metadata')) return json({ name: 'Album' })
      return jpeg()
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await sessionCookieFor((await upsertUser({ accountId: 'dbid:AAAbudget', displayName: 'Budget' })).accountId) },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/budget?rlkey=K' }),
      }, env)
      expect(response.status).toBe(201)
      expect(calls).toBeLessThanOrEqual(1000)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('limit checks before spend', () => {
  test('a paid account already at its gallery limit does not scan the album first', async () => {
    // 99 retained galleries is the paid ceiling; the 100th is refused.
    const owner = await upsertUser({ accountId: 'dbid:AAAlimit', displayName: 'At Limit' })
    await setUserTier(owner.accountId, 'pro')
    for (let index = 0; index < 99; index += 1) await createGallery(owner.accountId, gallery(`full-${index}`))

    let calls = 0
    const realFetch = globalThis.fetch
    // 200 images: a scan would spend 200+ provider calls to reach a refusal.
    const entries = Array.from({ length: 200 }, (_, index) => ({ '.tag': 'file', name: `IMG_${index}.jpg`, id: `id:abc${index}` }))
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls += 1
      const url = String(input)
      if (url.includes('files/list_folder')) return json({ entries, cursor: 'c', has_more: false })
      if (url.includes('get_shared_link_metadata')) return json({ name: 'Album' })
      return jpeg()
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await sessionCookieFor(owner.accountId) },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/over?rlkey=K' }),
      }, env)
      expect(response.status).toBe(403)
      expect(((await response.json()) as { code: string }).code).toBe('GALLERY_LIMIT')
      // Listing plus title is three calls; anything near 200 means the album
      // was read in full just to be refused.
      expect(calls).toBeLessThanOrEqual(10)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('free accounts get temporary galleries, so they are never limit-blocked', async () => {
    const owner = await upsertUser({ accountId: 'dbid:AAAfree', displayName: 'Free Tier' })
    for (let index = 0; index < FREE_RETAINED_LIMIT; index += 1) await createGallery(owner.accountId, gallery(`free-${index}`))
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch
    try {
      // No listing shape needed: this only asserts the tier is not refused.
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: await sessionCookieFor(owner.accountId) },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/free?rlkey=K' }),
      }, env)
      expect(response.status).not.toBe(403)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('partial responses', () => {
  test('a 206 from the provider survives the proxy with its range headers', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array(10), {
      status: 206,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Range': 'bytes 0-9/4096', 'Content-Length': '10' },
    })) as typeof fetch
    try {
      const response = await api.request(
        '/api/dropbox/file?sourceUrl=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fa&filename=x.jpg',
        { headers: { Range: 'bytes=0-9' } },
        { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
      )
      expect(response.status).toBe(206)
      expect(response.headers.get('Content-Range')).toBe('bytes 0-9/4096')
      expect(response.headers.get('Content-Length')).toBe('10')
      await response.arrayBuffer()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('dropbox path construction', () => {
  const pathFor = async (filename: string) => {
    let argument = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      argument = new Headers(init?.headers).get('dropbox-api-arg') ?? ''
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 })
    }) as typeof fetch
    try {
      await api.request(
        `/api/dropbox/file?sourceUrl=${encodeURIComponent('https://www.dropbox.com/scl/fo/a')}&filename=${encodeURIComponent(filename)}`,
        {},
        { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' },
      )
    } finally {
      globalThis.fetch = realFetch
    }
    return (JSON.parse(argument) as { path: string }).path
  }

  test('a plain filename is rooted at the link', async () => {
    expect(await pathFor('IMG_0001.jpg')).toBe('/IMG_0001.jpg')
  })

  test('a subfolder path is preserved', async () => {
    expect(await pathFor('sub/dir/IMG_0001.jpg')).toBe('/sub/dir/IMG_0001.jpg')
  })

  test('a leading slash does not double the separator', async () => {
    expect(await pathFor('/abs.jpg')).toBe('/abs.jpg')
  })

  test('dot segments are resolved against the link root, not left dangling', async () => {
    expect(await pathFor('../../outside.jpg')).toBe('/outside.jpg')
  })
})

describe('mega preview cap', () => {
  test('an oversized preview is refused rather than cached whole', async () => {
    const size = 12 * 1024 * 1024
    const handle = new Uint8Array(8).fill(7)
    const encoded = btoa(String.fromCharCode(...handle)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('g.api.mega.co.nz')) return json({ p: 'https://ufa.example/x' })
      const record = new Uint8Array(12 + size)
      record.set(handle)
      new DataView(record.buffer).setUint32(8, size, true)
      return new Response(record, { status: 200 })
    }) as typeof fetch
    await expect(
      fetchMegaPreview('SYNTH', undefined, encoded, 'AAAAAAAAAAAAAAAAAAAAAA', fetchImpl),
    ).rejects.toMatchObject({ status: 413 })
  })

  test('a normal-sized preview still passes through', async () => {
    const size = 300 * 1024
    const handle = new Uint8Array(8).fill(7)
    const encoded = btoa(String.fromCharCode(...handle)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('g.api.mega.co.nz')) return json({ p: 'https://ufa.example/x' })
      const record = new Uint8Array(12 + size)
      record.set(handle)
      new DataView(record.buffer).setUint32(8, size, true)
      return new Response(record, { status: 200 })
    }) as typeof fetch
    const response = await fetchMegaPreview('SYNTH', undefined, encoded, 'AAAAAAAAAAAAAAAAAAAAAA', fetchImpl)
    expect((await response.arrayBuffer()).byteLength).toBe(size)
  })
})

describe('og compositor host', () => {
  test('the card is built from the pinned public host, not the request host', async () => {
    const owner = await upsertUser({ accountId: 'dbid:AAAoghost', displayName: 'Og Host' })
    await createGallery(owner.accountId, gallery('host-test'))
    let fetched = ''
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      fetched = String(input)
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    try {
      await api.request(`https://attacker.example/api/og/${owner.ownerSlug}/host-test`, {}, { PUBLIC_HOST: 'manorama.xyz' })
      // Whatever Host reached the Worker, the compositor sub-requests the
      // pinned public host.
      expect(fetched.startsWith('https://manorama.xyz/')).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
