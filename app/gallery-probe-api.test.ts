import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, getGallery, markGallerySourceChecked, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

/**
 * The probe endpoint's contract: session-gated like every gallery write,
 * throttled by last_source_check_at, honest about encrypted sources
 * (device) and records their verdicts without a second listing.
 * In-memory repository fallback — no provider traffic is made here; the
 * provider compare logic lives in source-probe.test.ts.
 */

const api = createManoramaApi()
const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

const image = { id: 'i1', filename: 'a.jpg', src: '/img/a.jpg', width: 4000, height: 3000, alt: 'a', c2pa: false, placeholder: 'x', contentVersion: 'v1' }

const seedGallery = async (slug: string, sourceUrl: string | null, extras: Record<string, unknown> = {}) =>
  createGallery(TEST_OWNER.accountId, {
    id: `gal-${slug}`,
    slug,
    title: slug,
    caption: '',
    date: '',
    sourceUrl: sourceUrl ?? undefined,
    images: [image],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extras,
  })

let cookie = ''

beforeEach(async () => {
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
})

const probe = (slug: string, init?: RequestInit) =>
  api.request(`/api/galleries/${encodeURIComponent(slug)}/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}', ...init }, env)

describe('POST /api/galleries/:slug/probe', () => {
  test('an anonymous caller is refused before any gallery work', async () => {
    await seedGallery('kashmir', 'https://www.dropbox.com/scl/fo/x/y?rlkey=z')
    const response = await api.request('/api/galleries/kashmir/probe', { method: 'POST' }, env)
    expect(response.status).toBe(401)
  })

  test('a missing gallery answers 404', async () => {
    const response = await probe('missing')
    expect(response.status).toBe(404)
  })

  test('a source-less gallery answers skipped without stamping a check', async () => {
    await seedGallery('local-only', null)
    const response = await probe('local-only')
    const payload = await response.json() as { status: string; reason: string }
    expect(response.status).toBe(200)
    expect(payload.status).toBe('skipped')
    expect(payload.reason).toBe('no-source')
    expect((await getGallery(TEST_OWNER.accountId, 'local-only'))?.lastSourceCheckAt ?? null).toBeNull()
  })

  test('an encrypted source answers device WITHOUT stamping — an un-keyed device must not suppress another device', async () => {
    await seedGallery('enc', 'https://mega.nz/folder/AbCdEfGh#secretkey')
    const response = await probe('enc')
    const payload = await response.json() as { status: string; reason: string }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ status: 'device', reason: 'encrypted-source' })
    expect((await getGallery(TEST_OWNER.accountId, 'enc'))?.lastSourceCheckAt ?? null).toBeNull()
  })

  test('a reported device verdict stamps the shared check', async () => {
    await seedGallery('enc', 'https://mega.nz/folder/AbCdEfGh#secretkey')
    const response = await probe('enc', { body: JSON.stringify({ reported: 'unchanged' }) })
    const payload = await response.json() as { status: string; recorded: string; lastSourceCheckAt: string }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ status: 'device', recorded: 'unchanged' })
    expect(payload.lastSourceCheckAt).toBeTruthy()
    expect((await getGallery(TEST_OWNER.accountId, 'enc'))?.lastSourceCheckAt).toBe(payload.lastSourceCheckAt)
  })

  test('a fresh check is throttled to a recent skip — the 24h Library rule', async () => {
    await seedGallery('drop', 'https://www.dropbox.com/scl/fo/x/y?rlkey=z')
    await markGallerySourceChecked(TEST_OWNER.accountId, 'drop')
    const response = await probe('drop')
    const payload = await response.json() as { status: string; reason: string; lastSourceCheckAt: string }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ status: 'skipped', reason: 'recent' })
    expect(payload.lastSourceCheckAt).toBeTruthy()
  })

  test('an old check is due — the probe runs and stamps even when the listing fails', async () => {
    await seedGallery('drop', 'https://www.dropbox.com/scl/fo/x/y?rlkey=z')
    await markGallerySourceChecked(TEST_OWNER.accountId, 'drop', undefined, '2000-01-01T00:00:00.000Z')
    const response = await probe('drop')
    const payload = await response.json() as { status: string; lastSourceCheckAt: string }
    expect(response.status).toBe(200)
    // No Dropbox credentials are configured in the test env — the listing
    // fails closed as unknown, but the check still stamps.
    expect(payload.status).toBe('unknown')
    expect(payload.lastSourceCheckAt).not.toBe('2000-01-01T00:00:00.000Z')
    const stamp = (await getGallery(TEST_OWNER.accountId, 'drop'))?.lastSourceCheckAt
    expect(stamp).toBeTruthy()
    expect(Date.parse(stamp!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'))
  })

  test('force bypasses the throttle', async () => {
    await seedGallery('drop', 'https://www.dropbox.com/scl/fo/x/y?rlkey=z')
    await markGallerySourceChecked(TEST_OWNER.accountId, 'drop')
    const response = await probe('drop', { body: JSON.stringify({ force: true }) })
    const payload = await response.json() as { status: string }
    expect(response.status).toBe(200)
    expect(payload.status).toBe('unknown')
  })
})
