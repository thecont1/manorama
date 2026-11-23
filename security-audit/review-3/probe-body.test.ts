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

  test('the native exchange has no bound', async () => {
    const body = JSON.stringify({ handoffToken: pad(4 * 1024 * 1024) })
    const response = await post('/api/auth/native/exchange', body)
    // Parsed and refused on the token's merits, not on size.
    expect(response.status).toBe(401)
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024)
  })

  test('the scan endpoint has no bound', async () => {
    const body = JSON.stringify({ url: pad(2 * 1024 * 1024) })
    const response = await post('/api/galleries/scan', body, true)
    expect([400, 422]).toContain(response.status)
  })
})
