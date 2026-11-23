/**
 * Request-body bounds.
 *
 * `bodyLimit` is applied per route, not to the `/api/*` group, so the routes
 * that forgot it buffer whatever arrives. These probes show which endpoints
 * refuse an oversized body and which accept one — the difference is a
 * per-request memory cost an unauthenticated caller can choose.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore } from '../../app/lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const api = createManoramaApi()
let cookie = ''

const pad = (bytes: number) => 'x'.repeat(bytes)

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor('dbid:AAATESTowner1')
})

const post = (path: string, body: string, withCookie = false) =>
  api.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withCookie ? { Cookie: cookie } : {}) },
    body,
  }, env)

describe('body limits', () => {
  test('a route with bodyLimit refuses an oversized body with 413', async () => {
    const response = await post('/api/auth/desktop/exchange', JSON.stringify({ handoffToken: pad(9 * 1024), codeVerifier: pad(10) }))
    expect(response.status).toBe(413)
  })

  test('the native exchange is bounded (R3-04)', async () => {
    const response = await post('/api/auth/native/exchange', JSON.stringify({ handoffToken: pad(4 * 1024 * 1024) }))
    expect(response.status).toBe(413)
    // A body inside the bound still reaches the handler and is refused on
    // the token's merits, not on size.
    const inside = await post('/api/auth/native/exchange', JSON.stringify({ handoffToken: pad(4 * 1024) }))
    expect(inside.status).toBe(401)
  })

  test('the scan endpoint is bounded (R3-04)', async () => {
    const response = await post('/api/galleries/scan', JSON.stringify({ url: pad(2 * 1024 * 1024) }), true)
    expect(response.status).toBe(413)
    const inside = await post('/api/galleries/scan', JSON.stringify({ url: 'not-a-provider-link' }), true)
    expect([400, 422]).toContain(inside.status)
  })
})
