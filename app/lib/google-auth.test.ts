import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { JWTPayload } from 'jose'
import { fetchGoogleIdentity, googleAuthorizeUrl } from './google-auth'
import type { OidcDependencies } from './oidc'

const CLIENT_ID = 'test-google-client'
const ENV = { GOOGLE_AUTH_CLIENT_ID: CLIENT_ID, GOOGLE_AUTH_CLIENT_SECRET: 'test-google-secret' }
const EXCHANGE = {
  redirectUri: 'https://manorama.xyz/auth/google/callback',
  code: 'a/b+c=123',
  nonce: 'nonce-abc-123',
  codeVerifier: 'v'.repeat(50),
}

const keys = await generateKeyPair('RS256')
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'g-key-1' }
const keyResolver = createLocalJWKSet({ keys: [publicJwk] })

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: 'google-sub-1',
  nonce: EXCHANGE.nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: 'g@manorama.xyz',
  email_verified: true,
  name: 'Google User',
  ...overrides,
})

const sign = (
  payload: Record<string, unknown>,
  key: CryptoKey = keys.privateKey,
  header: Record<string, unknown> = {},
) => new SignJWT(payload as JWTPayload)
  .setProtectedHeader({ alg: 'RS256', kid: 'g-key-1', ...header })
  .sign(key)

const stubFetch = (token: string, extra: Record<string, unknown> = {}) => {
  const calls: { url: string; form: URLSearchParams; init?: RequestInit }[] = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, form: (init?.body as URLSearchParams) ?? new URLSearchParams(), init })
    return new Response(JSON.stringify({ id_token: token, access_token: 'ignored', ...extra }), { status: 200 })
  }
  return { calls, fetcher: fetcher as typeof fetch }
}

const deps = (token: string, extra: Record<string, unknown> = {}) => {
  const stub = stubFetch(token, extra)
  return { stub, deps: { fetch: stub.fetcher, keyResolver } satisfies OidcDependencies }
}

describe('google authorize URL', () => {
  const input = {
    redirectUri: 'https://manorama.xyz/auth/google/callback',
    state: 'state-1',
    nonce: 'nonce-1',
    codeChallenge: 'c'.repeat(43),
  }

  test('builds the pinned endpoint with code, S256 PKCE and minimal scopes only', () => {
    const url = new URL(googleAuthorizeUrl(input, ENV))
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('nonce')).toBe('nonce-1')
    expect(url.searchParams.get('code_challenge')).toBe(input.codeChallenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBeNull()
    expect(url.searchParams.get('prompt')).toBeNull()
  })

  test('rejects unconfigured, blank state/nonce, bad challenge and unsafe redirect URIs', () => {
    expect(() => googleAuthorizeUrl(input, {})).toThrow()
    expect(() => googleAuthorizeUrl(input, { GOOGLE_AUTH_CLIENT_ID: '  ', GOOGLE_AUTH_CLIENT_SECRET: 's' })).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, state: ' ' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, nonce: '' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, codeChallenge: 'short' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, codeChallenge: `${'c'.repeat(42)}+` }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'http://example.com/cb' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'https://user:pass@manorama.xyz/cb' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'https://manorama.xyz/cb#frag' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'not a url' }, ENV)).toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'http://localhost:5173/cb' }, ENV)).not.toThrow()
    expect(() => googleAuthorizeUrl({ ...input, redirectUri: 'http://127.0.0.1:8787/cb' }, ENV)).not.toThrow()
  })
})

describe('google identity exchange', () => {
  test('a valid RS256 token resolves subject, verified email and name', async () => {
    const { stub, deps: d } = deps(await sign(claims()))
    const result = await fetchGoogleIdentity(EXCHANGE, ENV, d)
    expect(result.identity).toEqual({
      provider: 'google',
      subject: 'google-sub-1',
      email: 'g@manorama.xyz',
      displayName: 'Google User',
    })
    expect(result.refreshToken).toBeUndefined()
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(stub.calls[0].init?.method).toBe('POST')
    expect(stub.calls[0].init?.redirect).toBe('manual')
    expect(stub.calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect((stub.calls[0].init?.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded')
    const form = stub.calls[0].form
    expect(form.get('code')).toBe(EXCHANGE.code)
    expect(form.get('client_id')).toBe(CLIENT_ID)
    expect(form.get('client_secret')).toBe('test-google-secret')
    expect(form.get('redirect_uri')).toBe(EXCHANGE.redirectUri)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toBe(EXCHANGE.codeVerifier)
  })

  test('a valid token also verifies through the pinned remote JWKS resolver', async () => {
    const token = await sign(claims())
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 })
      }
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 })
      }
      return new Response('unexpected fetch', { status: 404 })
    }) as typeof fetch
    try {
      const result = await fetchGoogleIdentity(EXCHANGE, ENV)
      expect(result.identity.subject).toBe('google-sub-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('the legacy bare issuer is accepted', async () => {
    const { deps: d } = deps(await sign(claims({ iss: 'accounts.google.com' })))
    const result = await fetchGoogleIdentity(EXCHANGE, ENV, d)
    expect(result.identity.subject).toBe('google-sub-1')
  })

  test('bad signatures, keys, issuers, audiences and algorithms are rejected', async () => {
    const otherKeys = await generateKeyPair('RS256')
    const cases = [
      sign(claims(), otherKeys.privateKey),
      sign(claims(), keys.privateKey, { kid: 'unknown-kid' }),
      sign(claims({ iss: 'https://evil.example.com' })),
      sign(claims({ aud: 'other-client' })),
      sign(claims(), new TextEncoder().encode('a'.repeat(48)) as unknown as CryptoKey, { alg: 'HS256' }),
    ]
    for (const token of await Promise.all(cases)) {
      const { deps: d } = deps(token)
      await expect(fetchGoogleIdentity(EXCHANGE, ENV, d)).rejects.toThrow()
    }
  })

  test('expired, missing-claim, wrong-nonce and bad-subject tokens are rejected', async () => {
    const now = Math.floor(Date.now() / 1000)
    const without = (key: string) => {
      const c = claims() as Record<string, unknown>
      delete c[key]
      return c
    }
    const cases = [
      claims({ exp: now - 10 }),
      without('exp'),
      without('iat'),
      without('nonce'),
      without('sub'),
      claims({ nonce: 'other-nonce' }),
      claims({ sub: '  ' }),
      claims({ sub: 'x'.repeat(1025) }),
      claims({ iat: now + 3600 }),
    ]
    for (const payload of cases) {
      const { deps: d } = deps(await sign(payload))
      await expect(fetchGoogleIdentity(EXCHANGE, ENV, d)).rejects.toThrow()
    }
    const { deps: blankNonce } = deps(await sign(claims()))
    await expect(fetchGoogleIdentity({ ...EXCHANGE, nonce: '  ' }, ENV, blankNonce)).rejects.toThrow()
  })

  test('audience/azp consistency rules hold', async () => {
    const mismatchedAzp = deps(await sign(claims({ aud: [CLIENT_ID, 'other-aud'], azp: 'other-aud' })))
    await expect(fetchGoogleIdentity(EXCHANGE, ENV, mismatchedAzp.deps)).rejects.toThrow()
    const missingAzp = deps(await sign(claims({ aud: [CLIENT_ID, 'other-aud'], azp: undefined })))
    await expect(fetchGoogleIdentity(EXCHANGE, ENV, missingAzp.deps)).rejects.toThrow()
    const wrongAzp = deps(await sign(claims({ azp: 'other-client' })))
    await expect(fetchGoogleIdentity(EXCHANGE, ENV, wrongAzp.deps)).rejects.toThrow()
    const matchingAzp = deps(await sign(claims({ aud: [CLIENT_ID, 'other-aud'], azp: CLIENT_ID })))
    const result = await fetchGoogleIdentity(EXCHANGE, ENV, matchingAzp.deps)
    expect(result.identity.subject).toBe('google-sub-1')
  })

  test('only a strictly verified email claim lands on the identity', async () => {
    for (const [verified, expected] of [
      [true, 'g@manorama.xyz'],
      ['true', 'g@manorama.xyz'],
      [false, undefined],
      ['false', undefined],
      ['yes', undefined],
      [undefined, undefined],
    ] as const) {
      const { deps: d } = deps(await sign(claims({ email_verified: verified })))
      const result = await fetchGoogleIdentity(EXCHANGE, ENV, d)
      expect(result.identity.email).toBe(expected)
    }
    const nonString = deps(await sign(claims({ email: 42 })))
    const tooLong = deps(await sign(claims({ email: `${'e'.repeat(321)}` })))
    expect((await fetchGoogleIdentity(EXCHANGE, ENV, nonString.deps)).identity.email).toBeUndefined()
    expect((await fetchGoogleIdentity(EXCHANGE, ENV, tooLong.deps)).identity.email).toBeUndefined()
  })

  test('token endpoint failures and malformed responses are rejected', async () => {
    for (const response of [
      new Response('denied', { status: 400 }),
      new Response('not json', { status: 200 }),
      new Response('null', { status: 200 }),
      new Response('[]', { status: 200 }),
      new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }),
      new Response(JSON.stringify({ id_token: 42 }), { status: 200 }),
    ]) {
      const fetcher = (async () => response) as typeof fetch
      await expect(fetchGoogleIdentity(EXCHANGE, ENV, { fetch: fetcher, keyResolver })).rejects.toThrow()
    }
  })

  test('a rejecting fetch propagates as failure', async () => {
    const fetcher = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    await expect(fetchGoogleIdentity(EXCHANGE, ENV, { fetch: fetcher, keyResolver })).rejects.toThrow()
  })

  test('malformed codes, verifiers, URIs and config fail before any fetch', async () => {
    const { stub, deps: d } = deps(await sign(claims()))
    for (const code of ['', '   ', 'x'.repeat(4097), 'code\u0007', 42 as unknown as string]) {
      await expect(fetchGoogleIdentity({ ...EXCHANGE, code }, ENV, d)).rejects.toThrow()
    }
    await expect(fetchGoogleIdentity({ ...EXCHANGE, codeVerifier: 'bad!' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, codeVerifier: 'short' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, codeVerifier: `${'v'.repeat(42)}!` }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, codeVerifier: 'v'.repeat(129) }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, nonce: ' ' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, redirectUri: 'http://example.com/cb' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, redirectUri: 'https://u:p@manorama.xyz/cb' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, redirectUri: 'https://manorama.xyz/cb#f' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity({ ...EXCHANGE, redirectUri: 'not a url' }, ENV, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity(EXCHANGE, {}, d)).rejects.toThrow()
    await expect(fetchGoogleIdentity(EXCHANGE, { GOOGLE_AUTH_CLIENT_ID: ' ', GOOGLE_AUTH_CLIENT_SECRET: 's' }, d)).rejects.toThrow()
    expect(stub.calls).toHaveLength(0)
  })
})
