import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { createManoramaApi } from '../../app/api'
import { resetAuthFlowStore } from '../../app/lib/auth-flows'
import { finishProviderAuth, stateCookieName } from '../../app/lib/oauth-flow'
import type { OidcDependencies } from '../../app/lib/oidc'
import { sessionCookieFor, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'
import { upsertIdentitySignIn } from '../../app/lib/identity-repository'
import { resetUserStore, upsertUser } from '../../app/lib/user-repository'
import appleStartRoute from '../../app/routes/auth/apple'
import googleStartRoute from '../../app/routes/auth/google'

/**
 * Second-review edges on the F-03 / F-05 fixes: behaviour the first pass did
 * not pin, and the places a further change is most likely to get them wrong.
 *
 * These are not new findings — they are the fixed properties' corners, kept
 * explicit so "the fix works" is not the only thing anyone ever asserted.
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

const GOOGLE_CLIENT_ID = 'review2-google-client'
const googleKeys = await generateKeyPair('RS256')
const googleJwk = { ...(await exportJWK(googleKeys.publicKey)), kid: 'review2-key-1' }
const googleResolver = createLocalJWKSet({ keys: [googleJwk] })
const appleKeys = await generateKeyPair('ES256', { extractable: true })
const APPLE_PRIVATE_KEY = await exportPKCS8(appleKeys.privateKey)

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: `${repoRoot}/wrangler.toml`, persist: false })
  // Every migration, in order — the schema is the deployment's, not a subset.
  const migrations = readdirSync(`${repoRoot}/migrations`).filter((name) => name.endsWith('.sql')).sort()
  for (const name of migrations) await applyMigration(proxy.env.DB, name)
}, 20_000)

afterAll(async () => {
  await proxy?.dispose()
  proxy = null
})

beforeEach(async () => {
  resetAuthFlowStore()
  resetUserStore()
  await proxy!.env.DB.batch([
    proxy!.env.DB.prepare('DELETE FROM auth_identities'),
    proxy!.env.DB.prepare('DELETE FROM gallery_keys'),
    proxy!.env.DB.prepare('DELETE FROM owner_key_vault'),
    proxy!.env.DB.prepare('DELETE FROM galleries'),
    proxy!.env.DB.prepare('DELETE FROM users'),
  ])
})

const env = () => ({
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  GOOGLE_AUTH_CLIENT_ID: GOOGLE_CLIENT_ID,
  GOOGLE_AUTH_CLIENT_SECRET: 'review2-google-secret',
  APPLE_CLIENT_ID: 'com.manorama.signin',
  APPLE_TEAM_ID: 'TEAM12345',
  APPLE_KEY_ID: 'KEY12345',
  APPLE_PRIVATE_KEY,
  DB: proxy!.env.DB,
})

const BASE = 'https://manorama.xyz'

const begin = async (provider: 'google' | 'apple', origin = BASE) => {
  const app = new Hono()
  const { providerAuthEntry } = await import('../../app/lib/oauth-flow')
  if (provider === 'google') app.get('/auth/google', (c) => providerAuthEntry(c, 'google'))
  else app.get('/auth/apple', (c) => providerAuthEntry(c, 'apple'))
  const response = await app.request(`${origin}/auth/${provider}`, undefined, env())
  const location = response.headers.get('Location') ?? ''
  const state = new URL(location).searchParams.get('state')!
  const nonce = (await proxy!.env.DB.prepare('SELECT nonce FROM auth_flows WHERE state = ?').bind(state)
    .first<{ nonce: string }>())!.nonce
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith(stateCookieName(state))) ?? ''
  const verifier = setCookie.split(';')[0]!.split('=').slice(1).join('=')
  return { state, nonce, verifier, setCookie }
}

const googleDeps = async (nonce: string): Promise<OidcDependencies> => {
  const idToken = await new SignJWT({
    iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: 'r2-sub', nonce,
    exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000),
    email: 'r2@example.test', email_verified: true, name: 'R2',
  } as JWTPayload).setProtectedHeader({ alg: 'RS256', kid: 'review2-key-1' }).sign(googleKeys.privateKey)
  return {
    keyResolver: googleResolver,
    fetch: (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as unknown as typeof fetch,
  }
}

describe('F-03 edges', () => {
  test('a mismatched callback sweeps the verifier cookie, a matched one keeps it for the pause', async () => {
    const { state, nonce } = await begin('google')
    const deps = await googleDeps(nonce)
    const app = new Hono()
    app.get('/auth/google/callback', (c) => finishProviderAuth(c, 'google', {
      code: c.req.query('code'), state: c.req.query('state'),
    }, deps))

    // No cookie → mismatch → the (absent) cookie is swept and the flow dies.
    const missing = await app.request(`${BASE}/auth/google/callback?code=x&state=${state}`, {}, env())
    expect(missing.headers.get('Location')).toBe('/?error=1')
    const swept = missing.headers.getSetCookie().find((cookie) => cookie.startsWith(stateCookieName(state)))
    expect(swept).toBeTruthy()
    // Delete = empty value or maxAge 0.
    expect(/max-age=0|=$|="$/i.test(swept!.split(';')[0]!) || /max-age=0/i.test(swept!)).toBe(true)
  })

  test('a sign-in that completes without pausing sweeps the verifier', async () => {
    // The identity already has an account, so the callback goes straight to
    // completeSignIn — no interstitial owes the binding anything.
    const owner = await upsertIdentitySignIn(
      { provider: 'google', subject: 'r2-sub', displayName: 'Returning R2' }, { DB: proxy!.env.DB })
    expect(owner.accountId).toBeTruthy()
    const { state, nonce, verifier } = await begin('google')
    const deps = await googleDeps(nonce)
    const app = new Hono()
    app.get('/auth/google/callback', (c) => finishProviderAuth(c, 'google', {
      code: c.req.query('code'), state: c.req.query('state'),
    }, deps))

    const done = await app.request(`${BASE}/auth/google/callback?code=x&state=${state}`,
      { headers: { Cookie: `${stateCookieName(state)}=${verifier}` } }, env())
    expect(done.status).toBe(302)
    const swept = done.headers.getSetCookie().find((cookie) => cookie.startsWith(stateCookieName(state)))
    expect(swept).toBeTruthy()
    expect(/max-age=0|=$|="$/i.test(swept!.split(';')[0]!) || /max-age=0/i.test(swept!)).toBe(true)
  })

  test('a first-time pause keeps the verifier so the confirm step can re-check it', async () => {
    const { state, nonce, verifier } = await begin('google')
    const deps = await googleDeps(nonce)
    const app = new Hono()
    app.get('/auth/google/callback', (c) => finishProviderAuth(c, 'google', {
      code: c.req.query('code'), state: c.req.query('state'),
    }, deps))

    const pending = await app.request(`${BASE}/auth/google/callback?code=x&state=${state}`,
      { headers: { Cookie: `${stateCookieName(state)}=${verifier}` } }, env())
    expect(pending.status).toBe(200)
    // Not swept: the confirm POST still owes this binding.
    expect(pending.headers.getSetCookie().some((cookie) => cookie.startsWith(`${stateCookieName(state)}=`))).toBe(false)
    expect(pending.headers.getSetCookie().some((cookie) => /max-age=0/i.test(cookie) && cookie.startsWith(stateCookieName(state)))).toBe(false)
  })

  test('Apple uses SameSite=None over https and falls back to Lax over http', async () => {
    const secure = await begin('apple')
    expect(secure.setCookie).toContain('SameSite=None')
    expect(secure.setCookie.toLowerCase()).toContain('secure')
    expect(secure.setCookie.toLowerCase()).toContain('httponly')

    // Dev over plain http: None without Secure would be dropped, so the
    // helper would downgrade to Lax — but Apple rejects a loopback-http
    // redirect URI before it gets that far, so the whole flow fails at the
    // start route (pre-existing dev limitation, not this fix's doing).
    const app = new Hono()
    const { providerAuthEntry } = await import('../../app/lib/oauth-flow')
    app.get('/auth/apple', (c) => providerAuthEntry(c, 'apple'))
    const insecure = await app.request('http://localhost:5173/auth/apple', undefined, env())
    expect(insecure.headers.get('Location')).toBe('/?error=1')
  })
})

describe('F-05 edges', () => {
  const api = createManoramaApi()

  const vaultRecord = (salt: string) => ({
    version: 1, kdfSalt: salt, kdfIterations: 600_000, wrappedVk: 'wrapped', vkNonce: 'nonce',
  })

  const put = (cookie: string, body: Record<string, unknown>) => api.request('/api/account/key-vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }, env())

  test('an old client that omits the CAS token still writes — the server does its read half', async () => {
    const user = await upsertUser({ accountId: 'acct_r2_vault', displayName: 'Vault Owner' }, { DB: proxy!.env.DB })
    const cookie = await sessionCookieFor(user.accountId)

    // Pre-CAS build: no expectedUpdatedAt at all. A missing token is not a
    // payload error — the server reads the current stamp and guards on it,
    // so the old create and the old replace both keep working.
    expect((await put(cookie, vaultRecord('salt-one'))).status).toBe(200)
    expect((await put(cookie, vaultRecord('salt-two'))).status).toBe(200)
    // A malformed token (wrong type, not absent) is still a 400.
    expect((await put(cookie, { ...vaultRecord('salt-three'), expectedUpdatedAt: 7 })).status).toBe(400)
    // And a modern create against the existing row still conflicts.
    const conflict = await put(cookie, { ...vaultRecord('salt-three'), expectedUpdatedAt: null })
    expect(conflict.status).toBe(409)
    const body = await conflict.json() as { vault: { kdfSalt: string } }
    expect(body.vault.kdfSalt).toBe('salt-two')
  })

  test('a replace must name the stamp it read', async () => {
    const user = await upsertUser({ accountId: 'acct_r2_vault2', displayName: 'Vault Owner 2' }, { DB: proxy!.env.DB })
    const cookie = await sessionCookieFor(user.accountId)
    const created = await put(cookie, { ...vaultRecord('first'), expectedUpdatedAt: null })
    const stamp = ((await created.json()) as { vault: { updatedAt: string } }).vault.updatedAt

    expect((await put(cookie, { ...vaultRecord('second'), expectedUpdatedAt: 'stale-stamp' })).status).toBe(409)
    expect((await put(cookie, { ...vaultRecord('second'), expectedUpdatedAt: stamp })).status).toBe(200)
  })

  test('gallery keys have their own create-only guard and a 409 carries the survivor', async () => {
    const user = await upsertUser({ accountId: 'acct_r2_key', displayName: 'Key Owner' }, { DB: proxy!.env.DB })
    const cookie = await sessionCookieFor(user.accountId)
    const gallery = await proxy!.env.DB.prepare(
      "INSERT INTO galleries (id, slug, owner_id, title, caption, date, images_json, created_at) VALUES ('g-r2', 'r2-gallery', ?, 'R2', '', '', '[]', datetime('now')) RETURNING id",
    ).bind(user.accountId).first<{ id: string }>()
    expect(gallery?.id).toBe('g-r2')

    const putKey = (body: Record<string, unknown>) => api.request('/api/galleries/r2-gallery/key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    }, env())

    expect((await putKey({ wrappedSource: 'one', nonce: 'n1', expectedUpdatedAt: null })).status).toBe(200)
    const conflict = await putKey({ wrappedSource: 'two', nonce: 'n2', expectedUpdatedAt: null })
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { key: { wrappedSource: string } }).key.wrappedSource).toBe('one')
  })
})
