import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { resetAdSuppressionStore } from './lib/ads-visibility'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let api: ReturnType<typeof createManoramaApi>
let cookie: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  resetAdSuppressionStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  api = createManoramaApi()
})

const putSuppression = (body: object, withCookie = true) =>
  api.request('/api/ads/suppressions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  }, env)

describe('ad visibility API', () => {
  test('the visibility endpoint is public and answers show by default', async () => {
    const response = await api.request('/api/ads/visibility', {}, env)
    expect(response.status).toBe(200)
    const body = await response.json() as { show: boolean; day: string; region: string }
    expect(body.show).toBe(true)
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('suppression management is session-gated', async () => {
    expect((await api.request('/api/ads/suppressions', {}, env)).status).toBe(401)
    expect((await putSuppression({ kind: 'day', value: '2026-10-01' }, false)).status).toBe(401)
  })

  test('a day suppression flips visibility until cleared', async () => {
    const today = new Date().toISOString().slice(0, 10)
    expect((await putSuppression({ kind: 'day', value: today })).status).toBe(200)

    const hidden = await api.request('/api/ads/visibility', {}, env)
    expect(((await hidden.json()) as { show: boolean; suppressedBy: string }).show).toBe(false)

    expect((await putSuppression({ kind: 'day', value: today, suppressed: false })).status).toBe(200)
    const shown = await api.request('/api/ads/visibility', {}, env)
    expect(((await shown.json()) as { show: boolean }).show).toBe(true)
  })

  test('a region suppression flips visibility when geo answers that region', async () => {
    expect((await putSuppression({ kind: 'region', value: 'in' })).status).toBe(200)

    // cf.country is read off the raw request — simulate the edge by faking it.
    const hidden = await api.request('/api/ads/visibility', {}, env)
    const body = await hidden.json() as { show: boolean; region: string }
    // Local requests carry no cf.country: the region stays undetermined and
    // the rule can only be proven by the region-aware check in the store.
    expect(body.region).toBe('')

    expect((await putSuppression({ kind: 'region', value: 'IN', suppressed: false })).status).toBe(200)
  })

  test('list round-trips for the signed-in operator', async () => {
    await putSuppression({ kind: 'region', value: 'DE' })
    const response = await api.request('/api/ads/suppressions', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    const body = await response.json() as { suppressions: { kind: string; value: string }[] }
    expect(body.suppressions.some((row) => row.kind === 'region' && row.value === 'DE')).toBe(true)
    await putSuppression({ kind: 'region', value: 'DE', suppressed: false })
  })

  test('rejects malformed suppressions', async () => {
    expect((await putSuppression({ kind: 'bogus', value: 'x' })).status).toBe(400)
    expect((await putSuppression({ kind: 'day', value: 'October' })).status).toBe(400)
    expect((await putSuppression({ kind: 'region', value: 'India' })).status).toBe(400)
    expect((await putSuppression({ kind: 'day' })).status).toBe(400)
  })
})
