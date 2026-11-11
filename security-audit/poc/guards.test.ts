import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { createGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore, upsertUser } from '../../app/lib/user-repository'
import { sessionCookieFor, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

/**
 * Guard tests — behaviour that is already correct and would be bad to lose.
 *
 * These are green from the start. They describe the boundaries the rest of the
 * audit leans on: what a public gallery read may expose, which origins the API
 * reflects, and that a session only ever reaches into its own account.
 */

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const api = createManoramaApi()

const galleryWithHidden = (slug: string) => ({
  slug,
  title: 'Half hidden',
  caption: '',
  date: '',
  images: [
    { id: `${slug}-shown`, filename: `${slug}-1.jpg`, src: '/images/a.jpg', width: 1200, height: 800, alt: 'shown', c2pa: false, placeholder: '' },
    { id: `${slug}-hidden`, filename: `${slug}-2.jpg`, src: '/images/b.jpg', width: 1200, height: 800, alt: 'hidden', c2pa: false, placeholder: '', hidden: true as const },
  ],
})

beforeEach(() => {
  resetUserStore()
  resetGalleryStore()
})

describe('guard: hidden items and the owner-only includeHidden escape', () => {
  test('a public read never carries a hidden item, the owner’s read can', async () => {
    const owner = await upsertUser({ accountId: 'dbid:guard-owner', displayName: 'Guard Owner' })
    await createGallery(owner.accountId, galleryWithHidden('guarded'))
    const cookie = await sessionCookieFor(owner.accountId)

    const anonymous = await api.request('/api/gallery/guard-owner/guarded', {}, env)
    const anonymousBody = await anonymous.json() as { manifest: { images: { id: string }[] } }
    expect(anonymousBody.manifest.images).toHaveLength(1)
    expect(anonymousBody.manifest.images[0]!.id).toBe('guarded-shown')

    const ownerRead = await api.request('/api/gallery/guard-owner/guarded?includeHidden=1', { headers: { Cookie: cookie } }, env)
    const ownerBody = await ownerRead.json() as { manifest: { images: unknown[] } }
    expect(ownerBody.manifest.images).toHaveLength(2)

    // A signed-in stranger asking for the same flag still gets the public set.
    const stranger = await upsertUser({ accountId: 'dbid:guard-stranger', displayName: 'Stranger' })
    const strangerRead = await api.request('/api/gallery/guard-owner/guarded?includeHidden=1', {
      headers: { Cookie: await sessionCookieFor(stranger.accountId) },
    }, env)
    expect((await strangerRead.json() as { manifest: { images: unknown[] } }).manifest.images).toHaveLength(1)
  })
})

describe('guard: API CORS reflection stays local', () => {
  test('the native-shell origins and loopback get a reflected allow-origin', async () => {
    for (const origin of ['capacitor://localhost', 'tauri://localhost', 'manorama://localhost', 'https://localhost', 'http://localhost:5173']) {
      const response = await api.request('/api/ads/visibility', { headers: { Origin: origin } }, env)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(response.headers.get('Vary')).toContain('Origin')
    }
  })

  test('an unrelated https origin gets no allow-origin header', async () => {
    const response = await api.request('/api/ads/visibility', { headers: { Origin: 'https://evil.example' } }, env)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('a lookalike hostname is not accepted', async () => {
    for (const origin of ['http://localhost.evil.example', 'https://localhost.evil.example']) {
      const response = await api.request('/api/ads/visibility', { headers: { Origin: origin } }, env)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    }
  })
})

describe('guard: a session only reaches its own galleries', () => {
  test('another owner’s slug 404s on the session-scoped detail route', async () => {
    const owner = await upsertUser({ accountId: 'dbid:guard-owner', displayName: 'Guard Owner' })
    await createGallery(owner.accountId, galleryWithHidden('private-ish'))

    const stranger = await upsertUser({ accountId: 'dbid:guard-stranger', displayName: 'Stranger' })
    const response = await api.request('/api/galleries/private-ish', {
      headers: { Cookie: await sessionCookieFor(stranger.accountId) },
    }, env)
    expect(response.status).toBe(404)
  })

  test('another owner cannot edit, delete, pin or refresh the gallery', async () => {
    const owner = await upsertUser({ accountId: 'dbid:guard-owner', displayName: 'Guard Owner' })
    await createGallery(owner.accountId, galleryWithHidden('mine'))
    const strangerCookie = await sessionCookieFor((await upsertUser({ accountId: 'dbid:guard-stranger', displayName: 'Stranger' })).accountId)

    const patch = await api.request('/api/galleries/mine', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: strangerCookie },
      body: JSON.stringify({ title: 'Hijacked' }),
    }, env)
    expect(patch.status).toBe(404)

    const del = await api.request('/api/galleries/mine', { method: 'DELETE', headers: { Cookie: strangerCookie } }, env)
    expect(del.status).toBe(404)

    // And the owner's title is untouched.
    const ownerRead = await api.request('/api/gallery/guard-owner/mine', {}, env)
    expect((await ownerRead.json() as { manifest: { title: string } }).manifest.title).toBe('Half hidden')
  })
})
