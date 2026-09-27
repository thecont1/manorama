import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { createManoramaApi } from '../../api'
import { consumeAuthFlow, createAuthFlow, pkceChallenge, resetAuthFlowStore } from '../../lib/auth-flows'
import { DESKTOP_CALLBACK, verifyDesktopHandoffToken } from '../../lib/desktop-auth'
import { findAccountByIdentity, listIdentities, linkIdentity, upsertIdentitySignIn } from '../../lib/identity-repository'
import { finishProviderAuth } from '../../lib/oauth-flow'
import type { OidcDependencies } from '../../lib/oidc'
import {
  createSessionToken,
  resolveManoramaSession,
  RETURNING_COOKIE,
  SESSION_COOKIE,
  verifyNativeHandoffToken,
} from '../../lib/session'
import { TEST_SESSION_SECRET } from '../../lib/test-fixtures'
import dropboxStartRoute from './dropbox'
import dropboxCallbackRoute from './dropbox/callback'
import googleStartRoute from './google'
import googleCallbackRoute from './google/callback'
import appleStartRoute from './apple'
import appleCallbackGet, { POST as appleCallbackPost } from './apple/callback'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

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

const GOOGLE_CLIENT_ID = 'test-google-client'
const APPLE_CLIENT_ID = 'com.manorama.signin'

const googleKeys = await generateKeyPair('RS256')
const googleJwk = { ...(await exportJWK(googleKeys.publicKey)), kid: 'g-key-1' }
const googleResolver = createLocalJWKSet({ keys: [googleJwk] })

const appleKeys = await generateKeyPair('RS256')
const appleJwk = { ...(await exportJWK(appleKeys.publicKey)), kid: 'a-key-1' }
const appleResolver = createLocalJWKSet({ keys: [appleJwk] })
const appleSecretKeys = await generateKeyPair('ES256', { extractable: true })
const APPLE_PRIVATE_KEY = await exportPKCS8(appleSecretKeys.privateKey)

const signJwt = (payload: Record<string, unknown>, key: CryptoKey, kid: string) =>
  new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'RS256', kid }).sign(key)

const googleClaims = (nonce: string, overrides: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: GOOGLE_CLIENT_ID,
  sub: 'google-sub-1',
  nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: 'g@manorama.xyz',
  email_verified: true,
  name: 'Google User',
  ...overrides,
})

const appleClaims = (nonce: string, overrides: Record<string, unknown> = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: APPLE_CLIENT_ID,
  sub: 'apple-sub-1',
  nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: 'a@privaterelay.appleid.com',
  email_verified: 'true',
  ...overrides,
})

/** A fetch that records calls and answers the token exchange with the
 *  supplied id_token; paired with a local JWKS resolver so no network is
 *  ever touched. */
const oidcDeps = (idToken: string, extra: Record<string, unknown> = {}) => {
  const calls: string[] = []
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === 'string' ? input : String(input))
    return new Response(JSON.stringify({ id_token: idToken, ...extra }), { status: 200 })
  }) as typeof fetch
  return { calls, fetcher }
}

const googleDeps = async (nonce: string, overrides: Record<string, unknown> = {}) => {
  const token = await signJwt(googleClaims(nonce, overrides), googleKeys.privateKey, 'g-key-1')
  const { calls, fetcher } = oidcDeps(token)
  return { calls, deps: { fetch: fetcher, keyResolver: googleResolver } satisfies OidcDependencies }
}

const appleDeps = async (nonce: string, overrides: Record<string, unknown> = {}) => {
  const token = await signJwt(appleClaims(nonce, overrides), appleKeys.privateKey, 'a-key-1')
  const { calls, fetcher } = oidcDeps(token)
  return { calls, deps: { fetch: fetcher, keyResolver: appleResolver } satisfies OidcDependencies }
}

let sharedD1: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null

beforeAll(async () => {
  sharedD1 = await getPlatformProxy<{ DB: D1Database }>({
    configPath: `${repoRoot}/wrangler.toml`,
    persist: false,
  })
  const db = sharedD1.env.DB
  await applyMigration(db, '0001_users_and_galleries.sql')
  await applyMigration(db, '0005_provider_neutral_accounts.sql')
  await applyMigration(db, '0006_auth_flows.sql')
}, 15_000)

afterAll(async () => {
  await sharedD1?.dispose()
  sharedD1 = null
})

beforeEach(() => {
  resetAuthFlowStore()
})

const db = () => sharedD1!.env.DB

const env = (overrides: Record<string, unknown> = {}) => ({
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  DROPBOX_APP_KEY: 'test-key',
  DROPBOX_APP_SECRET: 'test-secret',
  GOOGLE_AUTH_CLIENT_ID: GOOGLE_CLIENT_ID,
  GOOGLE_AUTH_CLIENT_SECRET: 'test-google-secret',
  APPLE_CLIENT_ID,
  APPLE_TEAM_ID: 'TEAM12345',
  APPLE_KEY_ID: 'KEY12345',
  APPLE_PRIVATE_KEY,
  DB: db(),
  ...overrides,
})

/** The real route files, mounted the way honox serves them. */
const realApp = () => {
  const app = new Hono()
  app.get('/auth/dropbox', ...dropboxStartRoute)
  app.get('/auth/dropbox/callback', ...dropboxCallbackRoute)
  app.get('/auth/google', ...googleStartRoute)
  app.get('/auth/google/callback', ...googleCallbackRoute)
  app.get('/auth/apple', ...appleStartRoute)
  app.get('/auth/apple/callback', ...appleCallbackGet)
  app.post('/auth/apple/callback', ...appleCallbackPost)
  return app
}

/** Callback routes with provider dependencies injected — same wiring as
 *  the real files, plus the OIDC fetch/keyResolver seam. */
const callbackApp = (deps: OidcDependencies) => {
  const field = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const app = new Hono()
  app.get('/auth/google/callback', (c) => finishProviderAuth(c, 'google', {
    code: c.req.query('code'),
    state: c.req.query('state'),
    error: c.req.query('error'),
  }, deps))
  app.post('/auth/apple/callback', async (c) => {
    const form = await c.req.parseBody()
    return finishProviderAuth(c, 'apple', {
      code: field(form.code),
      state: field(form.state),
      error: field(form.error),
      user: form.user,
    }, deps)
  })
  return app
}

const BASE = 'https://manorama.xyz'

describe('provider start routes', () => {
  test('GET /auth/dropbox opens a signin flow and redirects to Dropbox', async () => {
    const response = await realApp().request(`${BASE}/auth/dropbox`, undefined, env())
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(`${location.origin}${location.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(location.searchParams.get('client_id')).toBe('test-key')
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/dropbox/callback`)
    expect(location.searchParams.get('response_type')).toBe('code')
    const state = location.searchParams.get('state')!
    expect(state).toMatch(/^[0-9a-f]{64}$/)
    // The row is persisted server-side: consume it directly to inspect.
    const flow = await db().prepare('SELECT * FROM auth_flows WHERE state = ?').bind(state).first<Record<string, unknown>>()
    expect(flow?.provider).toBe('dropbox')
    expect(flow?.intent).toBe('signin')
    expect(flow?.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(flow?.code_verifier).toBeNull()
    expect(flow?.native).toBe('')
  })

  test('GET /auth/google opens a PKCE flow and redirects to Google', async () => {
    const response = await realApp().request(`${BASE}/auth/google`, undefined, env())
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/google/callback`)
    const state = location.searchParams.get('state')!
    const challenge = location.searchParams.get('code_challenge')!
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const flow = await db().prepare('SELECT * FROM auth_flows WHERE state = ?').bind(state).first<{ code_verifier: string; nonce: string }>()
    expect(location.searchParams.get('nonce')).toBe(flow?.nonce)
    expect(await pkceChallenge(flow!.code_verifier)).toBe(challenge)
  })

  test('GET /auth/apple redirects to Apple with form_post', async () => {
    const response = await realApp().request(`${BASE}/auth/apple`, undefined, env())
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(`${location.origin}${location.pathname}`).toBe('https://appleid.apple.com/auth/authorize')
    expect(location.searchParams.get('response_mode')).toBe('form_post')
    expect(location.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('an unconfigured provider lands on the generic error redirect', async () => {
    const response = await realApp().request(`${BASE}/auth/google`, undefined, env({ GOOGLE_AUTH_CLIENT_ID: '', GOOGLE_AUTH_CLIENT_SECRET: '' }))
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?error=1')
  })

  test('native, next and the desktop challenge are stored on the flow row', async () => {
    const challenge = await pkceChallenge('v'.repeat(50))
    const app = realApp()
    const ios = await app.request(`${BASE}/auth/dropbox?native=1`, undefined, env())
    const iosState = new URL(ios.headers.get('Location')!).searchParams.get('state')!
    expect((await consumeAuthFlow(iosState, { DB: db() }))?.native).toBe('1')

    const desktop = await app.request(`${BASE}/auth/dropbox?native=desktop&code_challenge=${challenge}`, undefined, env())
    const desktopState = new URL(desktop.headers.get('Location')!).searchParams.get('state')!
    const desktopFlow = await consumeAuthFlow(desktopState, { DB: db() })
    expect(desktopFlow?.native).toBe('desktop')
    expect(desktopFlow?.appChallenge).toBe(challenge)

    const next = await app.request(`${BASE}/auth/dropbox?next=${encodeURIComponent(`${BASE}/return-here`)}`, undefined, env())
    const nextState = new URL(next.headers.get('Location')!).searchParams.get('state')!
    expect((await consumeAuthFlow(nextState, { DB: db() }))?.nextUrl).toBe(`${BASE}/return-here`)
  })

  test('bad native values and a challenge without desktop are refused', async () => {
    const app = realApp()
    for (const query of ['native=bogus', 'native=desktop', `native=1&code_challenge=${'c'.repeat(43)}`]) {
      const response = await app.request(`${BASE}/auth/dropbox?${query}`, undefined, env())
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/?error=1')
    }
  })

  test('?link=1 needs a session, then opens a link flow bound to that account', async () => {
    const app = realApp()
    const anon = await app.request(`${BASE}/auth/dropbox?link=1`, undefined, env())
    expect(anon.headers.get('Location')).toBe('/?error=1')

    const user = await upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:LINKstarter', displayName: 'Link Starter' }, { DB: db() })
    const token = await createSessionToken(user.accountId, TEST_SESSION_SECRET)
    const linked = await app.request(`${BASE}/auth/google?link=1`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, env())
    expect(linked.status).toBe(302)
    const state = new URL(linked.headers.get('Location')!).searchParams.get('state')!
    const flow = await db().prepare('SELECT intent, account_id, native FROM auth_flows WHERE state = ?').bind(state).first<Record<string, unknown>>()
    expect(flow?.intent).toBe('link')
    expect(flow?.account_id).toBe(user.accountId)
    // Handoff params are meaningless on a link flow — ignored, not stored.
    const withNative = await app.request(`${BASE}/auth/google?link=1&native=1`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } }, env())
    const nativeState = new URL(withNative.headers.get('Location')!).searchParams.get('state')!
    expect((await consumeAuthFlow(nativeState, { DB: db() }))?.native).toBe('')
  })
})

describe('callback state handling', () => {
  test('an unknown state never reaches the provider and errors generically', async () => {
    const { calls, deps } = await googleDeps('nonce-any')
    const response = await callbackApp(deps).request(`${BASE}/auth/google/callback?code=x&state=bogus`, undefined, env())
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
  })

  test('a consumed state is single-use — the exchange is never attempted twice', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin' }, { DB: db() })
    const { calls, deps } = await googleDeps(nonce)
    const app = callbackApp(deps)
    const first = await app.request(`${BASE}/auth/google/callback?code=ok&state=${state}`, undefined, env())
    expect(first.headers.get('Location')).not.toBe('/?error=1')
    const second = await app.request(`${BASE}/auth/google/callback?code=ok&state=${state}`, undefined, env())
    expect(second.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(1)
  })

  test('a flow consumed out-of-band cannot drive an exchange either', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin' }, { DB: db() })
    expect((await consumeAuthFlow(state, { DB: db() }))?.nonce).toBe(nonce)
    const { calls, deps } = await googleDeps(nonce)
    const response = await callbackApp(deps).request(`${BASE}/auth/google/callback?code=ok&state=${state}`, undefined, env())
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
  })

  test('oauth errors and a missing code consume the flow without a provider call', async () => {
    const app = realApp()
    const start = await app.request(`${BASE}/auth/google`, undefined, env())
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    const denied = await app.request(`${BASE}/auth/google/callback?error=access_denied&state=${state}`, undefined, env())
    expect(denied.headers.get('Location')).toBe('/?error=1')
    const replay = await app.request(`${BASE}/auth/google/callback?code=x&state=${state}`, undefined, env())
    expect(replay.headers.get('Location')).toBe('/?error=1')

    const start2 = await app.request(`${BASE}/auth/dropbox`, undefined, env())
    const state2 = new URL(start2.headers.get('Location')!).searchParams.get('state')!
    const noCode = await app.request(`${BASE}/auth/dropbox/callback?state=${state2}`, undefined, env())
    expect(noCode.headers.get('Location')).toBe('/?error=1')
  })

  test('a state minted for one provider cannot be spent on another', async () => {
    const { state } = await createAuthFlow({ provider: 'dropbox', intent: 'signin' }, { DB: db() })
    const { calls, deps } = await googleDeps('nonce-any')
    const response = await callbackApp(deps).request(`${BASE}/auth/google/callback?code=x&state=${state}`, undefined, env())
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
  })

  test('a missing session secret fails closed', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin' }, { DB: db() })
    const { calls, deps } = await googleDeps(nonce)
    const response = await callbackApp(deps).request(`${BASE}/auth/google/callback?code=ok&state=${state}`, undefined, env({ HOST_API_JWT_SECRET: '' }))
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
  })
})

describe('google sign-in end to end', () => {
  const runCallback = async (deps: OidcDependencies, state: string, init?: RequestInit) =>
    callbackApp(deps).request(`${BASE}/auth/google/callback?code=ok&state=${state}`, init, env())

  test('a minted transaction signs in, sets cookies and lands on the dashboard', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin' }, { DB: db() })
    const { calls, deps } = await googleDeps(nonce, { sub: 'google-sub-e2e' })
    const response = await runCallback(deps, state)
    expect(response.status).toBe(302)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('https://oauth2.googleapis.com/token')
    const cookies = response.headers.get('Set-Cookie') ?? ''
    expect(cookies).toContain(SESSION_COOKIE)
    expect(cookies).toContain(RETURNING_COOKIE)
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('Secure')
    const account = await findAccountByIdentity('google', 'google-sub-e2e', { DB: db() })
    expect(account?.displayName).toBe('Google User')
    expect(response.headers.get('Location')).toBe(`/${account!.ownerSlug}`)
    const sessionToken = /manorama_session=([^;]+)/.exec(cookies)?.[1]!
    const session = await resolveManoramaSession(
      new Request(`${BASE}/api/galleries`, { headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` } }),
      env(),
    )
    expect(session?.accountId).toBe(account!.accountId)
  })

  test('a same-origin next is honoured; a foreign one falls back to the dashboard', async () => {
    const same = await createAuthFlow({ provider: 'google', intent: 'signin', next: `${BASE}/come/back` }, { DB: db() })
    const { deps: sameDeps } = await googleDeps(same.nonce, { sub: 'google-sub-next1' })
    const sameResponse = await runCallback(sameDeps, same.state)
    expect(sameResponse.headers.get('Location')).toBe(`${BASE}/come/back`)

    const relative = await createAuthFlow({ provider: 'google', intent: 'signin', next: '/relative/path' }, { DB: db() })
    const { deps: relativeDeps } = await googleDeps(relative.nonce, { sub: 'google-sub-next2' })
    const relativeResponse = await runCallback(relativeDeps, relative.state)
    expect(relativeResponse.headers.get('Location')).toBe('/relative/path')

    const foreign = await createAuthFlow({ provider: 'google', intent: 'signin', next: 'https://evil.example.com/x' }, { DB: db() })
    const { deps: foreignDeps } = await googleDeps(foreign.nonce, { sub: 'google-sub-next3' })
    const foreignResponse = await runCallback(foreignDeps, foreign.state)
    const account = await findAccountByIdentity('google', 'google-sub-next3', { DB: db() })
    expect(foreignResponse.headers.get('Location')).toBe(`/${account!.ownerSlug}`)
  })

  test('native=1 mints a session and redirects the handoff to the app scheme', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin', native: '1' }, { DB: db() })
    const { deps } = await googleDeps(nonce, { sub: 'google-sub-native' })
    const response = await runCallback(deps, state)
    const location = response.headers.get('Location')!
    expect(location).toMatch(/^in\.thecontrarian\.manorama:\/\/auth\/callback\?handoff=/)
    expect(response.headers.get('Set-Cookie')).toContain(SESSION_COOKIE)
    const handoff = decodeURIComponent(location.split('handoff=')[1])
    const account = await findAccountByIdentity('google', 'google-sub-native', { DB: db() })
    expect(await verifyNativeHandoffToken(handoff, TEST_SESSION_SECRET)).toBe(account!.accountId)
  })

  test('native=desktop binds the handoff to the app challenge', async () => {
    const verifier = 'd'.repeat(64)
    const appChallenge = await pkceChallenge(verifier)
    const { state, nonce } = await createAuthFlow(
      { provider: 'google', intent: 'signin', native: 'desktop', appChallenge },
      { DB: db() },
    )
    const { deps } = await googleDeps(nonce, { sub: 'google-sub-desktop' })
    const response = await runCallback(deps, state)
    const location = response.headers.get('Location')!
    expect(location).toMatch(new RegExp(`^${DESKTOP_CALLBACK.replace(/[.:]/g, '\\$&')}\\?handoff=`))
    const handoff = decodeURIComponent(location.split('handoff=')[1])
    const account = await findAccountByIdentity('google', 'google-sub-desktop', { DB: db() })
    expect(await verifyDesktopHandoffToken(handoff, TEST_SESSION_SECRET, verifier)).toBe(account!.accountId)
    expect(await verifyDesktopHandoffToken(handoff, TEST_SESSION_SECRET, 'x'.repeat(43))).toBeNull()
  })

  test('without D1 the callback answers a no-store 503, not a credential error', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'google', intent: 'signin' })
    const { deps } = await googleDeps(nonce, { sub: 'google-sub-nodb' })
    const response = await callbackApp(deps).request(
      `${BASE}/auth/google/callback?code=ok&state=${state}`,
      undefined,
      env({ DB: undefined }),
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('Sign-in is temporarily unavailable')
  })
})

describe('dropbox sign-in end to end on the real routes', () => {
  const originalFetch = globalThis.fetch

  const mockDropboxFetch = (accountId: string, email?: string) => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      calls.push(url)
      if (url === 'https://api.dropbox.com/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'mock-access-token' }), { status: 200 })
      }
      if (url === 'https://api.dropboxapi.com/2/users/get_current_account') {
        return new Response(JSON.stringify({
          account_id: accountId,
          email,
          email_verified: Boolean(email),
          name: { display_name: 'Dropbox User' },
        }), { status: 200 })
      }
      return new Response('unexpected fetch', { status: 500 })
    }) as typeof fetch
    return calls
  }

  test('start-to-callback signs in through a transaction, no OAuth cookies anywhere', async () => {
    const calls = mockDropboxFetch('dbid:E2Edropbox', 'e2e@manorama.xyz')
    const app = realApp()
    try {
      const start = await app.request(`${BASE}/auth/dropbox?next=${encodeURIComponent(`${BASE}/welcome`)}`, undefined, env())
      const startCookies = start.headers.get('Set-Cookie') ?? ''
      expect(startCookies).not.toContain('manorama_oauth')
      const state = new URL(start.headers.get('Location')!).searchParams.get('state')!
      const callback = await app.request(`${BASE}/auth/dropbox/callback?code=abc&state=${state}`, undefined, env())
      expect(callback.status).toBe(302)
      expect(callback.headers.get('Location')).toBe(`${BASE}/welcome`)
      expect(callback.headers.get('Set-Cookie')).toContain(SESSION_COOKIE)
      expect(calls).toEqual([
        'https://api.dropbox.com/oauth2/token',
        'https://api.dropboxapi.com/2/users/get_current_account',
      ])
      const account = await findAccountByIdentity('dropbox', 'dbid:E2Edropbox', { DB: db() })
      expect(account?.email).toBe('e2e@manorama.xyz')
      // Replaying the same state fails closed with no further fetches.
      calls.length = 0
      const replay = await app.request(`${BASE}/auth/dropbox/callback?code=abc&state=${state}`, undefined, env())
      expect(replay.headers.get('Location')).toBe('/?error=1')
      expect(calls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('apple sign-in via form_post', () => {
  test('POST parses the form, takes the one-time user name, and signs in', async () => {
    const { state, nonce } = await createAuthFlow({ provider: 'apple', intent: 'signin' }, { DB: db() })
    const { calls, deps } = await appleDeps(nonce, { sub: 'apple-sub-e2e' })
    const body = new URLSearchParams({
      code: 'apple-code-1',
      state,
      user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'spoofed@evil.example' }),
    })
    const response = await callbackApp(deps).request(`${BASE}/auth/apple/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env())
    expect(response.status).toBe(302)
    expect(calls).toEqual(['https://appleid.apple.com/auth/token'])
    const account = await findAccountByIdentity('apple', 'apple-sub-e2e', { DB: db() })
    // The display name comes from the user JSON; the email only from the
    // verified ID token claim — never from the spoofable user payload.
    expect(account?.displayName).toBe('Ada Lovelace')
    expect(account?.email).toBe('a@privaterelay.appleid.com')
    expect(response.headers.get('Location')).toBe(`/${account!.ownerSlug}`)
    expect(response.headers.get('Set-Cookie')).toContain(SESSION_COOKIE)
  })

  test('the real POST route is wired the same way and GET refuses', async () => {
    const get = await realApp().request(`${BASE}/auth/apple/callback?code=x&state=y`, undefined, env())
    expect(get.headers.get('Location')).toBe('/?error=1')
    const badState = await realApp().request(`${BASE}/auth/apple/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=x&state=bogus',
    }, env())
    expect(badState.headers.get('Location')).toBe('/?error=1')
  })
})

describe('the link flow', () => {
  const seedAccount = async (subject: string, displayName: string) =>
    upsertIdentitySignIn({ provider: 'dropbox', subject, displayName }, { DB: db() })

  const sessionCookie = async (accountId: string) =>
    `${SESSION_COOKIE}=${await createSessionToken(accountId, TEST_SESSION_SECRET)}`

  test('a valid session links the provider identity and reports it in the redirect', async () => {
    const user = await seedAccount('dbid:LINKhappy', 'Link Happy')
    const { state, nonce } = await createAuthFlow(
      { provider: 'google', intent: 'link', accountId: user.accountId },
      { DB: db() },
    )
    const { deps } = await googleDeps(nonce, { sub: 'goog-link-happy' })
    const response = await callbackApp(deps).request(
      `${BASE}/auth/google/callback?code=ok&state=${state}`,
      { headers: { Cookie: await sessionCookie(user.accountId) } },
      env(),
    )
    expect(response.headers.get('Location')).toBe(`/${user.ownerSlug}?linked=google`)
    const identities = await listIdentities(user.accountId, { DB: db() })
    expect(identities.map((row) => `${row.provider}:${row.subject}`).sort())
      .toEqual(['dropbox:dbid:LINKhappy', 'google:goog-link-happy'])
    expect((await findAccountByIdentity('google', 'goog-link-happy', { DB: db() }))?.accountId).toBe(user.accountId)
  })

  test('a session for a different account fails before the provider is called', async () => {
    const owner = await seedAccount('dbid:LINKowner', 'Link Owner')
    const intruder = await seedAccount('dbid:LINKother', 'Link Other')
    const { state, nonce } = await createAuthFlow(
      { provider: 'google', intent: 'link', accountId: owner.accountId },
      { DB: db() },
    )
    const { calls, deps } = await googleDeps(nonce, { sub: 'goog-link-nope' })
    const response = await callbackApp(deps).request(
      `${BASE}/auth/google/callback?code=ok&state=${state}`,
      { headers: { Cookie: await sessionCookie(intruder.accountId) } },
      env(),
    )
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
    // And nothing was linked.
    expect(await findAccountByIdentity('google', 'goog-link-nope', { DB: db() })).toBeNull()
  })

  test('a missing session rejects the link callback', async () => {
    const owner = await seedAccount('dbid:LINKanon', 'Link Anon')
    const { state, nonce } = await createAuthFlow(
      { provider: 'google', intent: 'link', accountId: owner.accountId },
      { DB: db() },
    )
    const { calls, deps } = await googleDeps(nonce, { sub: 'goog-link-anon' })
    const response = await callbackApp(deps).request(`${BASE}/auth/google/callback?code=ok&state=${state}`, undefined, env())
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(calls).toHaveLength(0)
  })

  test('a subject already bound elsewhere reports ?link=conflict', async () => {
    const holder = await seedAccount('dbid:LINKholder', 'Link Holder')
    await linkIdentity(holder.accountId, { provider: 'google', subject: 'goog-taken' }, { DB: db() })
    const aspirant = await seedAccount('dbid:LINKaspirant', 'Link Aspirant')
    const { state, nonce } = await createAuthFlow(
      { provider: 'google', intent: 'link', accountId: aspirant.accountId },
      { DB: db() },
    )
    const { deps } = await googleDeps(nonce, { sub: 'goog-taken' })
    const response = await callbackApp(deps).request(
      `${BASE}/auth/google/callback?code=ok&state=${state}`,
      { headers: { Cookie: await sessionCookie(aspirant.accountId) } },
      env(),
    )
    expect(response.headers.get('Location')).toBe(`/${aspirant.ownerSlug}?link=conflict`)
    expect((await listIdentities(aspirant.accountId, { DB: db() })).map((row) => row.provider)).toEqual(['dropbox'])
  })
})

describe('account identity endpoints', () => {
  const api = createManoramaApi()
  const authed = async (accountId: string) => ({
    Cookie: `${SESSION_COOKIE}=${await createSessionToken(accountId, TEST_SESSION_SECRET)}`,
  })

  test('GET lists the linked methods without provider subjects; 401 when signed out', async () => {
    expect((await api.request('/api/account/identities', undefined, env())).status).toBe(401)
    const user = await upsertIdentitySignIn(
      { provider: 'dropbox', subject: 'dbid:LISTme', displayName: 'List Me', email: 'list@manorama.xyz' },
      { DB: db() },
    )
    await linkIdentity(user.accountId, { provider: 'apple', subject: 'apple-list-me', displayName: 'Listy' }, { DB: db() })
    const response = await api.request('/api/account/identities', { headers: await authed(user.accountId) }, env())
    expect(response.status).toBe(200)
    const payload = await response.json() as { identities: Record<string, unknown>[] }
    expect(payload.identities).toEqual([
      { provider: 'apple', displayName: 'Listy' },
      { provider: 'dropbox', displayName: 'List Me', email: 'list@manorama.xyz' },
    ])
    expect(JSON.stringify(payload)).not.toContain('dbid:LISTme')
    expect(JSON.stringify(payload)).not.toContain('apple-list-me')
  })

  test('DELETE removes a secondary method, 404s on an absent one, 409s on the last', async () => {
    const user = await upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:UNLINKme', displayName: 'Unlink Me' }, { DB: db() })
    const headers = await authed(user.accountId)
    const missing = await api.request('/api/account/identities/google', { method: 'DELETE', headers }, env())
    expect(missing.status).toBe(404)
    const last = await api.request('/api/account/identities/dropbox', { method: 'DELETE', headers }, env())
    expect(last.status).toBe(409)
    expect(await last.json()).toEqual({ error: 'last-identity' })
    await linkIdentity(user.accountId, { provider: 'google', subject: 'goog-unlink-me' }, { DB: db() })
    const removed = await api.request('/api/account/identities/google', { method: 'DELETE', headers }, env())
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true })
    expect((await listIdentities(user.accountId, { DB: db() })).map((row) => row.provider)).toEqual(['dropbox'])
  })

  test('DELETE validates the provider name and needs a session', async () => {
    const user = await upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:VALprovider', displayName: 'Val Provider' }, { DB: db() })
    const bogus = await api.request('/api/account/identities/vimeo', { method: 'DELETE', headers: await authed(user.accountId) }, env())
    expect(bogus.status).toBe(404)
    const anon = await api.request('/api/account/identities/dropbox', { method: 'DELETE' }, env())
    expect(anon.status).toBe(401)
  })
})
