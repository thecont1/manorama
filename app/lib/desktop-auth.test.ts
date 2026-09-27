import { beforeEach, describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { createManoramaApi } from '../api'
import {
  createDesktopHandoffToken,
  desktopCodeChallenge,
  isDesktopChallenge,
  verifyDesktopHandoffToken,
} from './desktop-auth'
import { createNativeHandoffToken, createSessionToken, sessionKey } from './session'
import { resetUserStore } from './user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from './test-fixtures'

const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

describe('desktop code challenge', () => {
  test('matches the RFC 7636 appendix B vector', async () => {
    expect(await desktopCodeChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE)
  })

  test('isDesktopChallenge accepts exactly 43 unreserved characters', () => {
    expect(isDesktopChallenge(RFC7636_CHALLENGE)).toBe(true)
    expect(isDesktopChallenge('short')).toBe(false)
    expect(isDesktopChallenge(`${RFC7636_CHALLENGE}x`)).toBe(false)
    expect(isDesktopChallenge(`${RFC7636_CHALLENGE.slice(0, 42)}+`)).toBe(false)
    expect(isDesktopChallenge(RFC7636_CHALLENGE.replace('-', '='))).toBe(false)
    expect(isDesktopChallenge(null)).toBe(false)
    expect(isDesktopChallenge(43)).toBe(false)
  })
})

describe('desktop handoff token', () => {
  test('round-trips account id only for the matching verifier', async () => {
    const verifier = 'a'.repeat(43)
    const challenge = await desktopCodeChallenge(verifier)
    const token = await createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, challenge)
    expect(await verifyDesktopHandoffToken(token, TEST_SESSION_SECRET, verifier)).toBe(TEST_OWNER.accountId)
    expect(await verifyDesktopHandoffToken(token, TEST_SESSION_SECRET, 'b'.repeat(43))).toBeNull()
  })

  test('create rejects a malformed challenge', () => {
    expect(() => createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, 'not-a-challenge')).toThrow()
    expect(() => createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, '')).toThrow()
  })

  test('verify rejects a missing, malformed, or mistyped verifier', async () => {
    const challenge = await desktopCodeChallenge('c'.repeat(43))
    const token = await createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, challenge)
    expect(await verifyDesktopHandoffToken(token, TEST_SESSION_SECRET, '')).toBeNull()
    expect(await verifyDesktopHandoffToken(token, TEST_SESSION_SECRET, 'too short')).toBeNull()
    expect(await verifyDesktopHandoffToken(token, TEST_SESSION_SECRET, null as unknown as string)).toBeNull()
  })

  test('verify rejects malformed, expired, and wrongly-signed tokens', async () => {
    const verifier = 'd'.repeat(50)
    const challenge = await desktopCodeChallenge(verifier)
    expect(await verifyDesktopHandoffToken('not-a-jwt', TEST_SESSION_SECRET, verifier)).toBeNull()
    const wrongSecret = await createDesktopHandoffToken(TEST_OWNER.accountId, 'a-different-secret-that-is-long-enough', challenge)
    expect(await verifyDesktopHandoffToken(wrongSecret, TEST_SESSION_SECRET, verifier)).toBeNull()
    const now = Math.floor(Date.now() / 1000)
    const expired = await new SignJWT({ sub: TEST_OWNER.accountId, typ: 'desktop-handoff', codeChallenge: challenge })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(sessionKey(TEST_SESSION_SECRET))
    expect(await verifyDesktopHandoffToken(expired, TEST_SESSION_SECRET, verifier)).toBeNull()
  })

  test('verify rejects session and native handoff tokens and foreign typ claims', async () => {
    const verifier = 'e'.repeat(43)
    const challenge = await desktopCodeChallenge(verifier)
    const session = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    expect(await verifyDesktopHandoffToken(session, TEST_SESSION_SECRET, verifier)).toBeNull()
    const native = await createNativeHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    expect(await verifyDesktopHandoffToken(native, TEST_SESSION_SECRET, verifier)).toBeNull()
    const foreign = await new SignJWT({ sub: TEST_OWNER.accountId, typ: 'desktop-handoff ' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(sessionKey(TEST_SESSION_SECRET))
    expect(await verifyDesktopHandoffToken(foreign, TEST_SESSION_SECRET, verifier)).toBeNull()
    const wrongChallenge = await new SignJWT({ sub: TEST_OWNER.accountId, typ: 'desktop-handoff', codeChallenge: await desktopCodeChallenge('z'.repeat(43)) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(sessionKey(TEST_SESSION_SECRET))
    expect(await verifyDesktopHandoffToken(wrongChallenge, TEST_SESSION_SECRET, verifier)).toBeNull()
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('desktop exchange endpoint', () => {
  const api = createManoramaApi()
  const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

  beforeEach(async () => {
    resetUserStore()
    await seedTestUser()
  })

  const exchange = (body: unknown, raw = false) =>
    api.request('/api/auth/desktop/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? body as string : JSON.stringify(body),
    }, env)

  test('mints a working session for a valid handoff and verifier', async () => {
    const verifier = RFC7636_VERIFIER
    const challenge = await desktopCodeChallenge(verifier)
    const handoff = await createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, challenge)
    const response = await exchange({ handoffToken: handoff, codeVerifier: verifier })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const payload = await response.json() as { token?: string; ownerSlug?: string }
    expect(payload.ownerSlug).toBe('test-owner')
    const api2 = createManoramaApi()
    const authed = await api2.request('/api/galleries', {
      headers: { Authorization: `Bearer ${payload.token}` },
    }, env)
    expect(authed.status).toBe(200)
  })

  test('rejects wrong or missing verifiers, wrong types, and foreign tokens with a generic 401', async () => {
    const challenge = await desktopCodeChallenge('f'.repeat(43))
    const handoff = await createDesktopHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET, challenge)
    expect((await exchange({ handoffToken: handoff, codeVerifier: 'g'.repeat(43) })).status).toBe(401)
    expect((await exchange({ handoffToken: handoff })).status).toBe(401)
    expect((await exchange({ codeVerifier: 'f'.repeat(43) })).status).toBe(401)
    expect((await exchange({ handoffToken: 42, codeVerifier: 'f'.repeat(43) })).status).toBe(401)
    expect((await exchange({ handoffToken: handoff, codeVerifier: 43 })).status).toBe(401)
    expect((await exchange(null)).status).toBe(401)
    expect((await exchange([handoff, 'f'.repeat(43)])).status).toBe(401)
    expect((await exchange('{broken', true)).status).toBe(401)
    const session = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    expect((await exchange({ handoffToken: session, codeVerifier: 'f'.repeat(43) })).status).toBe(401)
    const native = await createNativeHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    expect((await exchange({ handoffToken: native, codeVerifier: 'f'.repeat(43) })).status).toBe(401)
    for (const rejected of [await exchange({ handoffToken: session, codeVerifier: 'x' })]) {
      expect(await rejected.json()).toEqual({ error: 'Authentication could not be completed' })
    }
  })

  test('rejects a handoff for a deleted account with a generic 401', async () => {
    const verifier = 'h'.repeat(43)
    const challenge = await desktopCodeChallenge(verifier)
    const handoff = await createDesktopHandoffToken('acct_00000000-0000-4000-8000-000000000000', TEST_SESSION_SECRET, challenge)
    const response = await exchange({ handoffToken: handoff, codeVerifier: verifier })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication could not be completed' })
  })
})
