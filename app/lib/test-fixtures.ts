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
export const sessionCookieFor = async (accountId: string): Promise<string> => {
  const token = await createSessionToken(accountId, TEST_SESSION_SECRET)
  return `${SESSION_COOKIE}=${token}`
}
