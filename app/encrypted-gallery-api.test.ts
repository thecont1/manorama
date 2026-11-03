import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, getGallery, resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const sourceUrl = 'https://mega.nz/folder/AbCdEf12'
const item = {
  id: 'mega-node1', ref: 'node1', filename: 'one.jpg', src: '',
  media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'node1' },
  contentVersion: 'a'.repeat(64), width: 4000, height: 3000,
  alt: 'One', c2pa: true, placeholder: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
} as const
const manifest = () => ({ provider: 'mega', sourceUrl, title: 'Encrypted', images: [item] })
let api: ReturnType<typeof createManoramaApi>
let cookie: string

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
  api = createManoramaApi()
})
const post = (path: string, body: unknown) => api.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
}, env)

describe('encrypted gallery API', () => {
  test('creates from a validated keyless manifest with immutable identity', async () => {
    const response = await post('/api/galleries', { manifest: manifest() })
    expect(response.status).toBe(201)
    const payload = await response.json() as any
    expect(payload.gallery.id).toBeTruthy()
    expect(payload.gallery.manifestVersion).toBe(2)
    expect(payload.gallery.sourceUrl).toBe(sourceUrl)
    expect(JSON.stringify(payload)).not.toContain('#a2V5')
    const stored = await getGallery(TEST_OWNER.accountId, payload.gallery.slug)
    expect(stored?.images[0] && 'media' in stored.images[0] ? stored.images[0].media?.kind : undefined).toBe('encrypted')
  })

  test('server scan routes reject encrypted URLs instead of receiving custody', async () => {
    const response = await post('/api/galleries/scan', { url: `${sourceUrl}#secret` })
    expect(response.status).toBe(422)
    expect((await response.json() as any).code).toBe('CLIENT_SCAN_REQUIRED')
  })

  test('refresh accepts only a client manifest for the same keyless source', async () => {
    const created = await post('/api/galleries', { manifest: manifest() })
    const { gallery } = await created.json() as any
    const next = manifest()
    next.images[0] = { ...item, contentVersion: 'b'.repeat(64) }
    const refreshed = await post(`/api/galleries/${gallery.slug}/refresh`, { manifest: next })
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json() as any).gallery.images[0].contentVersion).toBe('b'.repeat(64))
    const wrong = await post(`/api/galleries/${gallery.slug}/refresh`, {})
    expect(wrong.status).toBe(400)
  })
  test('legacy #F! source spelling refreshes by canonical identity', async () => {
    await createGallery(TEST_OWNER.accountId, {
      slug: 'legacy-mega', title: 'Legacy', caption: '', date: '',
      sourceUrl: 'https://mega.nz/#F!AbCdEf12!secret', images: [item],
    })
    const response = await post('/api/galleries/legacy-mega/refresh', { manifest: manifest() })
    expect(response.status).toBe(200)
    // The persisted manifest is now client-scanned — its keyless refs can
    // never render through the legacy path, so the version promotes too.
    const stored = await getGallery(TEST_OWNER.accountId, 'legacy-mega')
    expect(stored?.manifestVersion).toBe(2)
  })
  test('legacy server decrypt is retired by default with an explicit migration override', async () => {
    const retired = await api.request('/api/mega/file?folder=Ab&node=node&k=secret')
    expect(retired.status).toBe(410)
    expect((await retired.json() as any).code).toBe('SERVER_DECRYPT_RETIRED')
    const transitional = await api.request('/api/mega/file?folder=Ab&node=node&k=secret', {}, { LEGACY_ENCRYPTED_DECRYPT: 'enabled' })
    expect(transitional.status).toBe(400)
  })
})
