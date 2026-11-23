/**
 * Review-3 audit probes — the boundaries this pass tried to break.
 *
 * Everything here runs against the in-memory repositories (no D1) except the
 * device-gallery block, which needs the real schema. The point of each test is
 * stated above it: a failure names a broken boundary, not a broken UI.
 *
 * Run from the mirrored test root:
 *   bun run test:unit -- security-audit/review-3
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { createGallery, getStoredGallery, resetGalleryStore, setGalleryRetained } from '../../app/lib/gallery-repository'
import type { GalleryImage } from '../../app/lib/imagesource'
import { resetUserStore } from '../../app/lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const SECOND = { accountId: 'dbid:AAAauditstranger', displayName: 'Audit Stranger' }

const api = createManoramaApi()

const image = (id: string, extra: Partial<GalleryImage> = {}): GalleryImage => ({
  id,
  filename: `${id}.jpg`,
  src: `/api/dropbox/file?sourceUrl=x&filename=${id}.jpg`,
  width: 1200,
  height: 800,
  alt: id,
  c2pa: false,
  placeholder: '',
  ...extra,
})

const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
})

let ownerCookie = ''
let strangerCookie = ''

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  await seedTestUser(SECOND)
  ownerCookie = await sessionCookieFor(TEST_OWNER.accountId)
  strangerCookie = await sessionCookieFor(SECOND.accountId)

  await createGallery(TEST_OWNER.accountId, {
    slug: 'alpha',
    title: 'Alpha',
    caption: 'A caption',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/abc?rlkey=secret&dl=0',
    createdAt: '2026-11-01T00:00:00.000Z',
    images: [image('one'), image('two', { hidden: true }), image('three')],
  })
  // A pipeline gallery the owner keeps as-is, and one already past its clock.
  await createGallery(TEST_OWNER.accountId, {
    slug: 'alpha-temp',
    title: 'Temporary',
    caption: '',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/temp?rlkey=t&dl=0',
    createdAt: '2026-11-01T00:00:00.000Z',
    images: [image('temp-one')],
  })
})

describe('cross-owner object access', () => {
  const mutations: [string, string, object][] = [
    ['PATCH', '/api/galleries/alpha', { title: 'Stolen' }],
    ['PATCH', '/api/galleries/alpha/pin', { pinned: true }],
    ['PATCH', '/api/galleries/alpha/hide', { hidden: true }],
    ['DELETE', '/api/galleries/alpha', {}],
    ['POST', '/api/galleries/alpha/swap', {}],
    ['POST', '/api/galleries/alpha/refresh', {}],
    ['POST', '/api/galleries/alpha/probe', { force: true }],
    ['PUT', '/api/galleries/alpha/key', { wrappedSource: 'AAAA', nonce: 'BBBB', expectedUpdatedAt: null }],
  ]

  for (const [method, path, body] of mutations) {
    test(`a stranger's ${method} ${path} never reaches the owner's row`, async () => {
      const response = await api.request(path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
        body: JSON.stringify(body),
      }, env)
      expect([403, 404, 422]).toContain(response.status)
    })
  }

  test('the owner row survived every stranger request', async () => {
    const stored = await getStoredGallery(TEST_OWNER.accountId, 'alpha')
    expect(stored?.title).toBe('Alpha')
    expect(stored?.images.map((entry) => entry.id)).toEqual(['one', 'two', 'three'])
    expect(stored?.images[1]?.hidden).toBe(true)
    expect(stored?.hiddenAt ?? null).toBeNull()
    expect(stored?.pinnedAt ?? null).toBeNull()
  })

  test('the stranger can still read the public manifest (public is not a hole)', async () => {
    const response = await api.request('/api/gallery/test-owner/alpha', {}, env)
    expect(response.status).toBe(200)
  })
})

describe('public manifest shape', () => {
  test('hidden items are omitted for everyone but the owner', async () => {
    const visitor = await api.request('/api/gallery/test-owner/alpha', {}, env)
    const visitorBody = await visitor.json() as { manifest: { images: { id: string }[] } }
    expect(visitorBody.manifest.images.map((entry) => entry.id)).toEqual(['one', 'three'])

    const owner = await api.request('/api/gallery/test-owner/alpha?includeHidden=1', { headers: { Cookie: ownerCookie } }, env)
    const ownerBody = await owner.json() as { manifest: { images: { id: string }[] } }
    expect(ownerBody.manifest.images.map((entry) => entry.id)).toEqual(['one', 'two', 'three'])

    const stranger = await api.request('/api/gallery/test-owner/alpha?includeHidden=1', { headers: { Cookie: strangerCookie } }, env)
    const strangerBody = await stranger.json() as { manifest: { images: { id: string }[] } }
    expect(strangerBody.manifest.images.map((entry) => entry.id)).toEqual(['one', 'three'])
  })

  test('the public manifest does not carry the share capability URL', async () => {
    const response = await api.request('/api/gallery/test-owner/alpha', {}, env)
    const body = await response.json() as { manifest: Record<string, unknown> }
    expect(body.manifest.sourceUrl).toBeUndefined()
  })
})

describe('pipeline semantics', () => {
  test('a temporary gallery refuses edits but is publicly readable', async () => {
    // Three permanent galleries first, so the next create becomes temporary.
    for (const slug of ['p1', 'p2', 'p3']) {
      await createGallery(TEST_OWNER.accountId, {
        slug, title: slug, caption: '', date: '',
        sourceUrl: `https://www.dropbox.com/scl/fo/${slug}?rlkey=${slug}&dl=0`,
        createdAt: '2026-11-01T00:00:00.000Z',
        images: [image(`${slug}-one`)],
      })
    }
    const temp = await createGallery(TEST_OWNER.accountId, {
      slug: 'alpha-temp2', title: 'Temporary two', caption: '', date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/temp2?rlkey=t2&dl=0',
      createdAt: new Date().toISOString(),
      images: [image('temp-two')],
    })
    expect(temp.retention).toBe('pipeline')

    const patch = await api.request('/api/galleries/alpha-temp2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ title: 'x' }),
    }, env)
    expect(patch.status).toBe(403)
    expect((await patch.json() as { code?: string }).code).toBe('GALLERY_READ_ONLY')
    expect((await api.request('/api/gallery/test-owner/alpha-temp2', {}, env)).status).toBe(200)
  })

  test('a temporary gallery past its clock is gone from every read', async () => {
    // A fourth user whose single permanent slot is exhausted and whose
    // temporary gallery was created 60 days ago — expired on arrival.
    const EXPIRED = { accountId: 'dbid:AAAauditexpired', displayName: 'Expired Owner' }
    await seedTestUser(EXPIRED)
    for (const slug of ['e1', 'e2', 'e3']) {
      await createGallery(EXPIRED.accountId, {
        slug, title: slug, caption: '', date: '',
        sourceUrl: `https://www.dropbox.com/scl/fo/${slug}?rlkey=${slug}&dl=0`,
        createdAt: '2026-11-01T00:00:00.000Z',
        images: [image(`${slug}-one`)],
      })
    }
    const old = await createGallery(EXPIRED.accountId, {
      slug: 'e-old', title: 'Old temporary', caption: '', date: '',
      sourceUrl: 'https://www.dropbox.com/scl/fo/old?rlkey=old&dl=0',
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      images: [image('old-one')],
    })
    expect(old.retention).toBe('pipeline')
    expect(old.expiresAt).toBeTruthy()

    expect((await api.request('/api/gallery/expired-owner/e-old', {}, env)).status).toBe(404)
    const cookie = await sessionCookieFor(EXPIRED.accountId)
    const list = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const body = await list.json() as { galleries: { slug: string }[] }
    expect(body.galleries.map((entry) => entry.slug)).not.toContain('e-old')
    // The row is still there (the daily sweep owns the delete) and the owner
    // can still delete it.
    expect((await getStoredGallery(EXPIRED.accountId, 'e-old'))?.slug).toBe('e-old')
    expect((await api.request('/api/galleries/e-old', { method: 'DELETE', headers: { Cookie: cookie } }, env)).status).toBe(200)
  })
})
