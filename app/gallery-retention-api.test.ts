import { beforeEach, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { createManoramaApi } from './api'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { getUserByDropboxId, resetUserStore, setUserTier, upsertUser } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { paidGalleryLimitError, PIPELINE_LOCK_MESSAGE } from './lib/gallery-policy'
import type { GalleryImage } from './lib/imagesource'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET, PUBLIC_HOST: 'manorama.xyz' }
const api = createManoramaApi()

let cookie: string
let ownerSlug: string

const image = (id: string): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3,
  alt: 'a photograph', c2pa: false, placeholder: '',
})

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  ownerSlug = (await getUserByDropboxId(TEST_OWNER.dropboxAccountId))!.ownerSlug
})

const seedGalleries = async () => {
  for (let index = 0; index < 3; index += 1) {
    await createGallery(TEST_OWNER.dropboxAccountId, {
      slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '', images: [image(`k-${index}`)],
    })
  }
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'locked',
    title: 'Locked',
    caption: '',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/album',
    images: [image('img-locked')],
  })
}

const patch = (slug: string, body: object) =>
  api.request(`/api/galleries/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }, env)

describe('a pipeline gallery is read-only through the session API', () => {
  test('every PATCH payload shape answers the typed 403', async () => {
    await seedGalleries()
    const payloads: object[] = [
      { title: 'Renamed' },
      { caption: 'New caption' },
      { newSlug: 'renamed' },
      { order: ['img-locked.jpg'] },
      { sourceUrl: 'https://www.dropbox.com/scl/fo/other' },
      { images: [] },
      { settings: { mode: 'vertical' } },
      { defaultMode: 'vertical' },
      {},
    ]
    for (const body of payloads) {
      const response = await patch('locked', body)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ code: 'GALLERY_READ_ONLY', error: PIPELINE_LOCK_MESSAGE })
    }
    const listing = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const payload = await listing.json() as { galleries?: { slug: string; title: string; retention: string }[] }
    expect(payload.galleries?.some((gallery) => gallery.slug === 'locked' && gallery.retention === 'pipeline')).toBe(true)
    expect(payload.galleries?.find((gallery) => gallery.slug === 'locked')?.title).toBe('Locked')
  })

  test('refresh answers the typed 403 without touching the provider', async () => {
    await seedGalleries()
    const realFetch = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => { called += 1; throw new Error('provider access attempted') }) as typeof fetch
    try {
      const response = await api.request('/api/galleries/locked/refresh', {
        method: 'POST',
        headers: { Cookie: cookie },
      }, env)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ code: 'GALLERY_READ_ONLY', error: PIPELINE_LOCK_MESSAGE })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(called).toBe(0)
  })

  test('revisiting the same source link reopens the pipeline gallery without a scan', async () => {
    await seedGalleries()
    const realFetch = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => { called += 1; throw new Error('provider access attempted') }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/album' }),
      }, env)
      expect(response.status).toBe(409)
      const payload = await response.json() as { error?: string; galleryUrl?: string }
      expect(payload.galleryUrl).toBe(`/${ownerSlug}/locked`)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(called).toBe(0)
  })

  test('the owner can delete a pipeline gallery, after which it is simply missing', async () => {
    await seedGalleries()
    const deleted = await api.request('/api/galleries/locked', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }, env)
    expect(deleted.status).toBe(200)
    const missing = await patch('locked', { title: 'Nope' })
    expect(missing.status).toBe(404)
    const again = await api.request('/api/galleries/locked', {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }, env)
    expect(again.status).toBe(404)
  })
})

describe('a paid owner at the retained cap', () => {
  const PAID = 'dbid:AAATESTpaid99'

  test('POST of a new source answers the typed limit response', async () => {
    const paid = await upsertUser({ dropboxAccountId: PAID, displayName: 'Paid Owner' })
    await setUserTier(PAID, 'pro')
    for (let index = 0; index < 99; index += 1) {
      await createGallery(PAID, {
        slug: `full-${index}`, title: `Full ${index}`, caption: '', date: '', images: [image(`f-${index}`)],
      })
    }
    const paidCookie = await sessionCookieFor(PAID)
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
      if (url.includes('get_shared_link_metadata')) return Response.json({ name: 'New Album' })
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      const response = await api.request('/api/galleries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: paidCookie },
        body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/new-album' }),
      }, { ...env, DROPBOX_APP_KEY: 'key', DROPBOX_APP_SECRET: 'secret' })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        code: 'GALLERY_LIMIT',
        error: paidGalleryLimitError().message,
        dashboardUrl: `/${paid.ownerSlug}`,
      })
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('pipeline OG cards are never cached', () => {
  const jpegPngStubs = async () => {
    const jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 70, b: 50 } } }).jpeg().toBuffer()
    const png = await sharp({ create: { width: 360, height: 96, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 0.6 } } }).png().toBuffer()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('pill')) return new Response(png as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } })
      return new Response(jpeg as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    return () => { globalThis.fetch = realFetch }
  }

  test('a pipeline gallery with nothing to composite redirects with no-store', async () => {
    await seedGalleries()
    await createGallery(TEST_OWNER.dropboxAccountId, {
      slug: 'empty-pipe', title: 'Empty', caption: '', date: '', images: [],
    })
    const response = await api.request(`/api/og/${ownerSlug}/empty-pipe`, {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Location')).toContain('/og-image.png')
  })

  test('a composited pipeline card is still no-store', async () => {
    await seedGalleries()
    const restore = await jpegPngStubs()
    try {
      const response = await api.request(`/api/og/${ownerSlug}/locked?i=img-locked`, {}, env)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    } finally {
      restore()
    }
  })

  test('a retained composite keeps its day cache and an unknown gallery is never cached', async () => {
    await seedGalleries()
    const restore = await jpegPngStubs()
    try {
      const retained = await api.request(`/api/og/${ownerSlug}/kept-0?i=k-0`, {}, env)
      expect(retained.status).toBe(200)
      expect(retained.headers.get('Cache-Control')).toBe('public, max-age=86400')
      const missing = await api.request(`/api/og/${ownerSlug}/does-not-exist`, {}, env)
      expect(missing.status).toBe(302)
      expect(missing.headers.get('Cache-Control')).toBe('no-store')
    } finally {
      restore()
    }
  })
})
