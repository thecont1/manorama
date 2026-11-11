import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { resetAuthFlowStore } from '../../app/lib/auth-flows'
import { confirmPendingAccount, finishProviderAuth, stateCookieName } from '../../app/lib/oauth-flow'
import type { OidcDependencies } from '../../app/lib/oidc'
import { SESSION_COOKIE } from '../../app/lib/session'
import { TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'
import googleStartRoute from '../../app/routes/auth/google'

/**
 * FINDING F-03 — the OAuth `state` was a bearer value, not a value bound to
 * the browser that started the flow. FIXED.
 *
 * The start route now plants an HttpOnly verifier cookie named for the
 * state and stores only its SHA-256 on the auth_flows row. The callback
 * consumes the row first (single-use) and then demands the cookie back —
 * an attacker-forwarded callback URL opened in a victim's browser dies on
 * the generic error redirect before any provider call, and no session is
 * minted. The first-sign-in confirm step carries the same binding inside
 * the signed pending token, so a forwarded confirm POST fails too.
 *
 * What this file proves now:
 *   - a cookie-less callback never reaches the provider and mints no session;
 *   - a callback with a verifier minted for a DIFFERENT flow fails the same way;
 *   - the victim's existing session is never replaced;
 *   - the honest same-browser round-trip still signs in;
 *   - a confirm POST without the verifier creates no account.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const applyMigration = async (db: D1Database, name: string) => {
  const sql = readFileSync(`${repoRoot}/migrations/${name}`, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  for (const statement of sql.split(';')) {
    const trimmed = statement.trim()
    if (trimmed) await db.prepare(trimmed).run()
  }
}

const GOOGLE_CLIENT_ID = 'audit-google-client'
const googleKeys = await generateKeyPair('RS256')
const googleJwk = { ...(await exportJWK(googleKeys.publicKey)), kid: 'audit-key-1' }
const googleResolver = createLocalJWKSet({ keys: [googleJwk] })
const appleKeys = await generateKeyPair('ES256', { extractable: true })
const APPLE_PRIVATE_KEY = await exportPKCS8(appleKeys.privateKey)

const claims = (nonce: string, sub: string, name: string) => ({
  iss: 'https://accounts.google.com',
  aud: GOOGLE_CLIENT_ID,
  sub,
  nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: `${sub}@example.test`,
  email_verified: true,
  name,
})

const signJwt = (payload: Record<string, unknown>, key: CryptoKey) =>
  new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'RS256', kid: 'audit-key-1' }).sign(key)

/** Provider seam: the token endpoint answers with a locally signed id_token. */
const depsFor = async (nonce: string, sub: string, name: string): Promise<OidcDependencies> => {
  const idToken = await signJwt(claims(nonce, sub, name), googleKeys.privateKey)
  return {
    keyResolver: googleResolver,
    fetch: (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as unknown as typeof fetch,
  }
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: `${repoRoot}/wrangler.toml`, persist: false })
  for (const name of [
    '0001_users_and_galleries.sql',
    '0005_provider_neutral_accounts.sql',
    '0006_auth_flows.sql',
    '0008_master_accounts_and_country.sql',
    '0009_user_disabled.sql',
    '0010_session_revocation.sql',
    '0011_last_seen_location.sql',
    '0018_auth_flow_state_cookie.sql',
  ]) await applyMigration(proxy.env.DB, name)
}, 20_000)

afterAll(async () => {
  await proxy?.dispose()
  proxy = null
})

beforeEach(async () => {
  resetAuthFlowStore()
  await proxy!.env.DB.batch([
    proxy!.env.DB.prepare('DELETE FROM auth_identities'),
    proxy!.env.DB.prepare('DELETE FROM users'),
  ])
})

/** The attacker already has an account; their provider subject resolves to it. */
const seedAttacker = () => proxy!.env.DB.batch([
  proxy!.env.DB.prepare(
    "INSERT INTO users (account_id, owner_slug, display_name) VALUES ('acct_audit_attacker', 'audit-attacker', 'Attacker')",
  ),
  proxy!.env.DB.prepare(
    `INSERT INTO auth_identities (provider, provider_subject, account_id, display_name)
     VALUES ('google', 'attacker-sub', 'acct_audit_attacker', 'Attacker')`,
  ),
])

const env = () => ({
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  GOOGLE_AUTH_CLIENT_ID: GOOGLE_CLIENT_ID,
  GOOGLE_AUTH_CLIENT_SECRET: 'audit-google-secret',
  APPLE_CLIENT_ID: 'com.manorama.signin',
  APPLE_TEAM_ID: 'TEAM12345',
  APPLE_KEY_ID: 'KEY12345',
  APPLE_PRIVATE_KEY,
  DB: proxy!.env.DB,
})

const BASE = 'https://manorama.xyz'

/** The real start route: creates the state row, plants the verifier cookie,
 *  and redirects to Google. Returns what the browser holds. */
const beginFlow = async () => {
  const app = new Hono()
  app.get('/auth/google', ...googleStartRoute)
  const response = await app.request(`${BASE}/auth/google`, undefined, env())
  expect(response.status).toBe(302)
  const state = new URL(response.headers.get('Location')!).searchParams.get('state')!
  const cookieHeader = (response.headers.getSetCookie().find((cookie) => cookie.startsWith('manorama_oauth_')) ?? '')
  expect(cookieHeader).toContain(stateCookieName(state))
  expect(cookieHeader).toContain('HttpOnly')
  const row = await proxy!.env.DB.prepare('SELECT nonce, state_cookie_hash FROM auth_flows WHERE state = ?').bind(state)
    .first<{ nonce: string; state_cookie_hash: string | null }>()
  // Only the hash is persisted — the verifier itself never touches storage.
  expect(row!.state_cookie_hash).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return { state, nonce: row!.nonce, stateCookie: cookieHeader.split(';')[0] }
}

const callbackApp = (deps: OidcDependencies) => {
  const app = new Hono()
  app.get('/auth/google/callback', (c) => finishProviderAuth(c, 'google', {
    code: c.req.query('code'),
    state: c.req.query('state'),
  }, deps))
  app.post('/auth/confirm-account', (c) => confirmPendingAccount(c))
  return app
}

/** The Set-Cookie session value, without attributes. */
const sessionCookieFrom = (response: Response) =>
  (response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? ''

const accountIdFrom = (session: string) => {
  const payload = JSON.parse(atob(session.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
  return payload.sub as string
}

describe('F-03 OAuth state is bound to the browser (login CSRF fixed)', () => {
  test('a callback URL opened by a cookie-less victim dies before the provider call', async () => {
    await seedAttacker()

    // Attacker's browser starts a flow; the callback URL leaks to a victim.
    const { state, nonce } = await beginFlow()
    const callbackUrl = `${BASE}/auth/google/callback?code=attacker-code&state=${state}`
    let providerCalls = 0
    const deps = await depsFor(nonce, 'attacker-sub', 'Attacker')
    const providerFetch = deps.fetch!
    deps.fetch = ((...args: Parameters<typeof fetch>) => {
      providerCalls++
      return providerFetch(...args)
    }) as typeof fetch

    const app = callbackApp(deps)
    const victimBrowserRequest = new Request(callbackUrl)
    expect(victimBrowserRequest.headers.get('Cookie')).toBeNull()

    const victimResponse = await app.request(callbackUrl, {}, env())
    expect(victimResponse.status).toBe(302)
    expect(victimResponse.headers.get('Location')).toBe('/?error=1')
    // No session was minted — the victim keeps nothing of the attacker's.
    expect(sessionCookieFrom(victimResponse)).toBe('')
    expect(providerCalls).toBe(0)
  })

  test('a verifier minted for a different flow fails just like a missing one', async () => {
    await seedAttacker()
    const { state, nonce } = await beginFlow()
    const { stateCookie: wrongCookie } = await beginFlow() // a second tab's cookie

    const response = await callbackApp(await depsFor(nonce, 'attacker-sub', 'Attacker')).request(
      `${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: wrongCookie } },
      env(),
    )
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(sessionCookieFrom(response)).toBe('')
  })

  test('an existing session in the victim’s browser is never replaced', async () => {
    await seedAttacker()

    const { state, nonce } = await beginFlow()
    const response = await callbackApp(await depsFor(nonce, 'attacker-sub', 'Attacker')).request(
      `${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: `${SESSION_COOKIE}=victims-existing-session` } },
      env(),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?error=1')
    // No Set-Cookie overrides — the browser still holds only its own session.
    expect(sessionCookieFrom(response)).toBe('')
  })

  test('the honest same-browser round-trip still signs in', async () => {
    await seedAttacker()

    const { state, nonce, stateCookie } = await beginFlow()
    const response = await callbackApp(await depsFor(nonce, 'attacker-sub', 'Attacker')).request(
      `${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: stateCookie } },
      env(),
    )

    expect(response.status).toBe(302)
    const session = sessionCookieFrom(response)
    expect(session).not.toBe(`${SESSION_COOKIE}=`)
    expect(accountIdFrom(session)).toBe('acct_audit_attacker')
    expect(response.headers.get('Location')).toBe('/audit-attacker')
  })

  test('a forwarded confirm POST without the verifier creates no account', async () => {
    const { state, nonce, stateCookie } = await beginFlow()
    const app = callbackApp(await depsFor(nonce, 'new-attacker-sub', 'New Attacker'))

    const pending = await app.request(`${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: stateCookie } }, env())
    expect(pending.status).toBe(200)
    const token = /name="token" value="([^"]+)"/.exec(await pending.text())![1]!

    // The attacker forwards the interstitial's token to the victim — but the
    // verifier cookie was deleted when the callback ran, and the victim's
    // browser never held it anyway.
    const confirm = await app.request(`${BASE}/auth/confirm-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    }, env())

    expect(confirm.status).toBe(302)
    expect(confirm.headers.get('Location')).toBe('/?error=1')
    expect(sessionCookieFrom(confirm)).toBe('')
    const row = await proxy!.env.DB.prepare("SELECT account_id FROM auth_identities WHERE provider_subject = 'new-attacker-sub'").first()
    expect(row).toBeNull()
  })

  test('the same browser posting its own confirm still creates the account', async () => {
    const { state, nonce, stateCookie } = await beginFlow()
    const app = callbackApp(await depsFor(nonce, 'new-attacker-sub', 'New Attacker'))

    const pending = await app.request(`${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: stateCookie } }, env())
    expect(pending.status).toBe(200)
    const token = /name="token" value="([^"]+)"/.exec(await pending.text())![1]!

    const confirm = await app.request(`${BASE}/auth/confirm-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: stateCookie },
      body: `token=${encodeURIComponent(token)}`,
    }, env())

    expect(confirm.status).toBe(302)
    const session = sessionCookieFrom(confirm)
    expect(session).not.toBe(`${SESSION_COOKIE}=`)
    expect(accountIdFrom(session)).not.toBe('acct_audit_attacker')
  })
})
