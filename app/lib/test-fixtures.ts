import { createSessionToken, SESSION_COOKIE } from './session'
import { upsertUser, type UserRecord } from './user-repository'

/**
 * Test-only fixtures for the session layer. Tests seed users into
 * the in-memory repository fallback and mint real HS256 session cookies —
 * the same verification path production uses, minus any network.
 */

/** Must be at least 32 bytes to satisfy sessionKey's minimum length. */
export const TEST_SESSION_SECRET = 'manorama-test-session-secret-min32'

export const TEST_OWNER = {
  accountId: 'dbid:AAATESTowner1',
  displayName: 'Test Owner',
  email: 'mahesh@manorama.xyz',
} as const

/** Seeds (or refreshes) the canonical test user; returns its record. */
export const seedTestUser = async (overrides: Partial<{ accountId: string; displayName: string; email: string | undefined }> = {}): Promise<UserRecord> =>
  upsertUser({ ...TEST_OWNER, ...overrides })

/** A Cookie header value authenticating the given account. */
export const sessionCookieFor = async (accountId: string, issuedAtSeconds?: number): Promise<string> => {
  const token = await createSessionToken(accountId, TEST_SESSION_SECRET, issuedAtSeconds)
  return `${SESSION_COOKIE}=${token}`
}

/** A real jar between requests: the response's Set-Cookie headers update or
 *  delete entries in the Cookie header the next request sends. Without it a
 *  test replays a cookie the server just told the browser to drop — which is
 *  how a verifier deleted too early once went unnoticed in this suite. */
export const applySetCookie = (header: string, response: Response): string => {
  const jar = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('Set-Cookie') ?? '']
  for (const setCookie of setCookies) {
    const [pair, ...attrs] = setCookie.split(';')
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    const expired = attrs.some((attr) => /max-age=0/i.test(attr.trim()) || /expires=thu, 01 jan 1970/i.test(attr.trim()))
    if (expired || !pair.slice(eq + 1).trim()) jar.delete(name)
    else jar.set(name, pair.slice(eq + 1).trim())
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}
