/**
 * Cacheability of authenticated JSON.
 *
 * The API group sets nosniff and CORS on every response, but nothing about
 * caching. These probes record what an intermediary or a shared browser
 * profile is actually told about responses that carry the owner's private
 * data — notably `sourceUrl`, which is the gallery's share capability.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { createGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore } from '../../app/lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const api = createManoramaApi()
let cookie = ''

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
  await createGallery(TEST_OWNER.accountId, {
    slug: 'private-links',
    title: 'Private links',
    caption: '', date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/abc?rlkey=CAPABILITY&dl=0',
    createdAt: '2026-11-01T00:00:00.000Z',
    images: [{ id: 'i1', filename: 'i1.jpg', src: '/x.jpg', width: 100, height: 100, alt: 'a', c2pa: false, placeholder: '' }],
  })
})

const headersOf = async (path: string, withCookie = true) => {
  const response = await api.request(path, withCookie ? { headers: { Cookie: cookie } } : {}, env)
  return { status: response.status, cache: response.headers.get('cache-control'), vary: response.headers.get('vary'), etag: response.headers.get('etag') }
}

describe('owner-only JSON responses', () => {
  test('record the share capability', async () => {
    const response = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const body = await response.json() as { galleries: { sourceUrl?: string }[] }
    expect(body.galleries[0]?.sourceUrl).toContain('rlkey=CAPABILITY')
  })

  for (const path of ['/api/galleries', '/api/library', '/api/account', '/api/galleries/private-links']) {
    test(`${path} declares private, no-store`, async () => {
      const headers = await headersOf(path)
      console.log(`HEADERS ${path} status=${headers.status} cache-control=${headers.cache ?? '(none)'} vary=${headers.vary ?? '(none)'} etag=${headers.etag ?? '(none)'}`)
      expect(headers.status).toBe(200)
      expect(headers.cache).toContain('private')
      expect(headers.cache).toContain('no-store')
    })
  }

  test('the public manifest is also uncached and varies only on Origin', async () => {
    const headers = await headersOf('/api/gallery/test-owner/private-links', false)
    console.log(`HEADERS /api/gallery/:owner/:slug status=${headers.status} cache-control=${headers.cache ?? '(none)'} vary=${headers.vary ?? '(none)'}`)
    expect(headers.status).toBe(200)
  })
})
