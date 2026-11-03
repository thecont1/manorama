import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, getGallery, resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const source = 'https://mega.nz/folder/AbCdEf12#secret'
const manifest = () => ({
  provider: 'mega', sourceUrl: 'https://mega.nz/folder/AbCdEf12', title: 'Legacy',
  images: [{ id: 'mega-node1', ref: 'node1', filename: 'one.jpg', src: '', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'node1' }, contentVersion: 'a'.repeat(64), width: 4000, height: 3000, alt: '', c2pa: false, placeholder: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" }],
})

describe('legacy encrypted-source migration', () => {
  let api: ReturnType<typeof createManoramaApi>
  let cookie: string
  let ownerSlug: string
  beforeEach(async () => {
    resetUserStore(); resetGalleryStore()
    ownerSlug = (await seedTestUser()).ownerSlug
    cookie = await sessionCookieFor(TEST_OWNER.accountId)
    api = createManoramaApi()
    await createGallery(TEST_OWNER.accountId, { slug: 'legacy', title: 'Legacy', caption: '', date: '', sourceUrl: source, images: [
      { id: 'a', filename: 'a.jpg', src: '', width: 1, height: 1, alt: '', c2pa: false, placeholder: '' },
      { id: 'b', filename: 'b.jpg', src: '', width: 1, height: 1, alt: '', c2pa: false, placeholder: '' },
    ] })
  })
  const migrate = async (deviceId: string, extra: Record<string, unknown> = {}) => {
    const response = await api.request('/api/galleries/legacy/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ manifest: manifest(), deviceId, ...extra }),
    }, { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })
    return response
  }

  test('two distinct verified devices are required before server key retirement', async () => {
    const first = await migrate('device-one')
    expect(first.status).toBe(200)
    expect((await first.json() as any).keyRetired).toBe(false)
    let gallery = await getGallery(TEST_OWNER.accountId, 'legacy')
    expect(gallery?.manifestVersion).toBe(2)
    expect(gallery?.sourceUrl).toBe(source)
    expect(gallery?.migrationDevices).toEqual(['device-one'])

    expect((await migrate('device-one')).status).toBe(200)
    gallery = await getGallery(TEST_OWNER.accountId, 'legacy')
    expect(gallery?.keyRetiredAt).toBeNull()

    const second = await migrate('device-two')
    expect(second.status).toBe(200)
    expect((await second.json() as any).keyRetired).toBe(true)
    gallery = await getGallery(TEST_OWNER.accountId, 'legacy')
    expect(gallery?.sourceUrl).toBe('https://mega.nz/folder/AbCdEf12')
    expect(typeof gallery?.keyRetiredAt).toBe('string')
  })

  test('an explicit owner opt-out retires immediately and anonymously cannot migrate', async () => {
    const anonymous = await api.request('/api/galleries/legacy/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: manifest(), deviceId: 'device-one' }) })
    expect(anonymous.status).toBe(401)
    const response = await migrate('device-one', { optOut: true })
    expect(response.status).toBe(200)
    expect((await getGallery(TEST_OWNER.accountId, 'legacy'))?.sourceUrl).toBe(manifest().sourceUrl)
  })

  test('the device manifest publishes only the keyless source URL', async () => {
    const response = await api.request(`/api/gallery/${ownerSlug}/legacy`, {}, { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })
    expect(response.status).toBe(200)
    const { manifest } = await response.json() as { manifest: { sourceUrl?: string } }
    expect(manifest.sourceUrl).toBe('https://mega.nz/folder/AbCdEf12')
    expect(manifest.sourceUrl).not.toContain('#')
  })

  test('migrate refuses a truncated manifest', async () => {
    const response = await migrate('device-one', { manifest: { ...manifest(), truncated: 40 } })
    expect(response.status).toBe(422)
    expect((await response.json() as any).code).toBe('PARTIAL_SCAN')
    const gallery = await getGallery(TEST_OWNER.accountId, 'legacy')
    expect(gallery?.images).toHaveLength(2)
    expect(gallery?.keyRetiredAt).toBeNull()
  })

  test('a different source identity cannot replace the stored key', async () => {
    const wrong = { ...manifest(), sourceUrl: 'https://mega.nz/folder/ZzYyXw99' }
    const response = await api.request('/api/galleries/legacy/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ manifest: wrong, deviceId: 'device-one' }) }, { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })
    expect(response.status).toBe(400)
    expect((await getGallery(TEST_OWNER.accountId, 'legacy'))?.sourceUrl).toBe(source)
  })
})
