import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { resetAuthFlowStore } from '../../app/lib/auth-flows'
import { confirmPendingAccount, finishProviderAuth } from '../../app/lib/oauth-flow'
import type { OidcDependencies } from '../../app/lib/oidc'
import { SESSION_COOKIE } from '../../app/lib/session'
import { TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'
import googleStartRoute from '../../app/routes/auth/google'

/**
 * FINDING F-03 — the OAuth `state` is a bearer value, not a value bound to the
 * browser that started the flow.
 *
 * The state row is server-side and single-use, which stops replay by the same
 * client. Nothing ties it to the user-agent: no state cookie is set and the
 * callback compares nothing from the requester. So a callback URL (code +
 * state) that an attacker obtains can be opened in a victim's browser and
 * silently installs a session for the *attacker's* account — classic login
 * CSRF. Everything the victim then does (add a gallery, adopt a library, edit
 * a caption, save to vault) lands in the attacker's account, which the
 * attacker can still sign in to afterwards.
 *
 * The provider round-trip is the only simulated part: the token endpoint
 * answers with an id_token signed by a locally generated key, and the JWKS
 * resolver is local.
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

/** The real start route: creates the state row and redirects to Google. */
const beginFlow = async () => {
  const app = new Hono()
  app.get('/auth/google', ...googleStartRoute)
  const response = await app.request(`${BASE}/auth/google`, undefined, env())
  expect(response.status).toBe(302)
  const state = new URL(response.headers.get('Location')!).searchParams.get('state')!
  const row = await proxy!.env.DB.prepare('SELECT nonce FROM auth_flows WHERE state = ?').bind(state)
    .first<{ nonce: string }>()
  return { state, nonce: row!.nonce }
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

describe('F-03 OAuth state is not browser-bound (login CSRF)', () => {
  test('a callback URL opened by a cookie-less victim installs the attacker’s account', async () => {
    // The attacker has an account; the provider subject already maps to it.
    await seedAttacker()

    // 1. Attacker's browser starts a flow and completes the provider round-trip.
    const { state, nonce } = await beginFlow()
    const callbackUrl = `${BASE}/auth/google/callback?code=attacker-code&state=${state}`
    const app = callbackApp(await depsFor(nonce, 'attacker-sub', 'Attacker'))

    // 2. Attacker deliberately does NOT open the callback. The victim does —
    //    with no Cookie header at all, i.e. a clean browser.
    const victimBrowserRequest = new Request(callbackUrl)
    expect(victimBrowserRequest.headers.get('Cookie')).toBeNull()

    const victimResponse = await app.request(callbackUrl, {}, env())
    expect(victimResponse.status).toBe(302)

    const session = sessionCookieFrom(victimResponse)
    expect(session).not.toBe(`${SESSION_COOKIE}=`)
    expect(accountIdFrom(session)).toBe('acct_audit_attacker')
    expect(victimResponse.headers.get('Location')).toBe('/audit-attacker')
  })

  test('an existing session in the victim’s browser is replaced, not preserved', async () => {
    await seedAttacker()

    const { state, nonce } = await beginFlow()
    const response = await callbackApp(await depsFor(nonce, 'attacker-sub', 'Attacker')).request(
      `${BASE}/auth/google/callback?code=attacker-code&state=${state}`,
      { headers: { Cookie: `${SESSION_COOKIE}=victims-existing-session` } },
      env(),
    )

    expect(response.status).toBe(302)
    // Set-Cookie overrides: the browser now holds the attacker's session.
    expect(accountIdFrom(sessionCookieFrom(response))).toBe('acct_audit_attacker')
  })

  test('the first-sign-in confirm step also needs no cookie from the requester', async () => {
    const { state, nonce } = await beginFlow()
    const app = callbackApp(await depsFor(nonce, 'new-attacker-sub', 'New Attacker'))

    const pending = await app.request(`${BASE}/auth/google/callback?code=attacker-code&state=${state}`, {}, env())
    expect(pending.status).toBe(200)
    const token = /name="token" value="([^"]+)"/.exec(await pending.text())![1]!

    const confirm = await app.request(`${BASE}/auth/confirm-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    }, env())

    expect(confirm.status).toBe(302)
    expect(sessionCookieFrom(confirm)).not.toBe(`${SESSION_COOKIE}=`)
  })
})
