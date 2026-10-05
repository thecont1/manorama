import { describe, expect, test } from 'bun:test'
import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from 'jose'
import type { JWTPayload } from 'jose'
import { appleAuthorizeUrl, createAppleClientSecret, fetchAppleIdentity } from './apple-auth'
import type { OidcDependencies } from './oidc'

const CLIENT_ID = 'com.manorama.signin'
const ENV = {
  APPLE_CLIENT_ID: CLIENT_ID,
  APPLE_TEAM_ID: 'TEAM12345',
  APPLE_KEY_ID: 'KEY12345',
}
const EXCHANGE = {
  redirectUri: 'https://manorama.xyz/auth/apple/callback',
  code: 'a/b+c=123',
  nonce: 'nonce-abc-123',
  codeVerifier: '',
}

const keys = await generateKeyPair('RS256')
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'a-key-1' }
const keyResolver = createLocalJWKSet({ keys: [publicJwk] })
const es256 = await generateKeyPair('ES256', { extractable: true })
const env = { ...ENV, APPLE_PRIVATE_KEY: await exportPKCS8(es256.privateKey) }

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: CLIENT_ID,
  sub: 'apple-sub-1',
  nonce: EXCHANGE.nonce,
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  email: 'a@privaterelay.appleid.com',
  email_verified: 'true',
  ...overrides,
})

const sign = (
  payload: Record<string, unknown>,
  key: CryptoKey | Uint8Array = keys.privateKey,
  header: Record<string, unknown> = {},
) => new SignJWT(payload as JWTPayload)
  .setProtectedHeader({ alg: 'RS256', kid: 'a-key-1', ...header })
  .sign(key)

const stubFetch = (token: string, extra: Record<string, unknown> = {}) => {
  const calls: { url: string; form: URLSearchParams; init?: RequestInit }[] = []
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, form: (init?.body as URLSearchParams) ?? new URLSearchParams(), init })
    return new Response(JSON.stringify({ id_token: token, ...extra }), { status: 200 })
  }
  return { calls, fetcher: fetcher as typeof fetch }
}

const deps = (token: string, extra: Record<string, unknown> = {}) => {
  const stub = stubFetch(token, extra)
  return { stub, deps: { fetch: stub.fetcher, keyResolver } satisfies OidcDependencies }
}

describe('apple client secret', () => {
  test('is a ≤5-minute ES256 JWT bound to team, client id and Apple', async () => {
    const secret = await createAppleClientSecret(env)
    const { payload, protectedHeader } = await jwtVerify(secret, es256.publicKey, {
      algorithms: ['ES256'],
    })
    expect(protectedHeader.kid).toBe('KEY12345')
    expect(payload.iss).toBe('TEAM12345')
    expect(payload.sub).toBe(CLIENT_ID)
    expect(payload.aud).toBe('https://appleid.apple.com')
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300)
  })

  test('fails closed when the key material is missing or malformed', async () => {
    await expect(createAppleClientSecret(ENV)).rejects.toThrow()
    await expect(createAppleClientSecret({ ...env, APPLE_PRIVATE_KEY: 'not a key' })).rejects.toThrow()
  })
})

describe('apple authorize URL', () => {
  const input = {
    redirectUri: 'https://manorama.xyz/auth/apple/callback',
    state: 'state-1',
    nonce: 'nonce-1',
    codeChallenge: 'c'.repeat(43),
  }

  test('posts back with form_post and no PKCE challenge', () => {
    const url = new URL(appleAuthorizeUrl(input, env))
    expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('response_mode')).toBe('form_post')
    expect(url.searchParams.get('scope')).toBe('name email')
    expect(url.searchParams.get('state')).toBe('state-1')
    expect(url.searchParams.get('nonce')).toBe('nonce-1')
    expect(url.searchParams.get('code_challenge')).toBeNull()
    expect(url.searchParams.get('code_challenge_method')).toBeNull()
  })

  test('requires HTTPS redirects — even loopback http is refused', () => {
    expect(() => appleAuthorizeUrl(input, env)).not.toThrow()
    expect(() => appleAuthorizeUrl({ ...input, redirectUri: 'http://localhost:5173/cb' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, redirectUri: 'http://example.com/cb' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, redirectUri: 'https://u:p@manorama.xyz/cb' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, redirectUri: 'https://manorama.xyz/cb#f' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, redirectUri: 'not a url' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, state: '' }, env)).toThrow()
    expect(() => appleAuthorizeUrl({ ...input, nonce: '  ' }, env)).toThrow()
    expect(() => appleAuthorizeUrl(input, {} as typeof env)).toThrow()
    expect(() => appleAuthorizeUrl(input, { ...env, APPLE_CLIENT_ID: ' ' })).toThrow()
  })
})

describe('apple identity exchange', () => {
  test('a valid RS256 token resolves subject, verified email and the one-time user name', async () => {
    const token = await sign(claims())
    const { stub, deps: d } = deps(token, { refresh_token: 'apple-refresh-1' })
    const user = JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'forged@evil.example' })
    const result = await fetchAppleIdentity({ ...EXCHANGE, user }, env, d)
    expect(result.identity).toEqual({
      provider: 'apple',
      subject: 'apple-sub-1',
      email: 'a@privaterelay.appleid.com',
      displayName: 'Ada Lovelace',
    })
    expect(result.refreshToken).toBe('apple-refresh-1')
    expect(stub.calls[0].url).toBe('https://appleid.apple.com/auth/token')
    expect(stub.calls[0].init?.method).toBe('POST')
    expect(stub.calls[0].init?.redirect).toBe('manual')
    expect(stub.calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect((stub.calls[0].init?.headers as Record<string, string>)['Content-Type'])
      .toBe('application/x-www-form-urlencoded')
    const form = stub.calls[0].form
    expect(form.get('code')).toBe(EXCHANGE.code)
    expect(form.get('client_id')).toBe(CLIENT_ID)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('redirect_uri')).toBe(EXCHANGE.redirectUri)
    expect(form.has('code_verifier')).toBe(false)
    const clientSecret = form.get('client_secret')!
    const { payload } = await jwtVerify(clientSecret, es256.publicKey, { algorithms: ['ES256'] })
    expect(payload.iss).toBe('TEAM12345')
    expect(payload.sub).toBe(CLIENT_ID)
  })

  test('user name forms: object, string, partial, oversized and malformed', async () => {
    const token = await sign(claims())
    const cases: [unknown, string | undefined][] = [
      [{ name: { firstName: 'Ada' } }, 'Ada'],
      [JSON.stringify({ name: { firstName: 'Ada', lastName: 'Byron' } }), 'Ada Byron'],
      [{ name: { firstName: `${'N'.repeat(200)}` } }, 'N'.repeat(120)],
      [{ name: { firstName: '  ' } }, undefined],
      [{ name: 'string' }, undefined],
      [{ name: { firstName: 42, lastName: 'Only' } }, 'Only'],
      ['{broken json', undefined],
      [`${'x'.repeat(8193)}`, undefined],
      [[1, 2], undefined],
      [undefined, undefined],
    ]
    for (const [user, expected] of cases) {
      const { deps: d } = deps(token)
      const result = await fetchAppleIdentity({ ...EXCHANGE, user }, env, d)
      expect(result.identity.displayName).toBe(expected)
      expect(result.identity.email).toBe('a@privaterelay.appleid.com')
    }
  })

  test('a missing user payload and a missing refresh token stay absent', async () => {
    const { deps: d } = deps(await sign(claims()))
    const result = await fetchAppleIdentity(EXCHANGE, env, d)
    expect(result.identity.displayName).toBeUndefined()
    expect(result.refreshToken).toBeUndefined()
    expect('refreshToken' in result).toBe(false)
  })

  test('bad signatures, keys, issuers, audiences and algorithms are rejected', async () => {
    const otherKeys = await generateKeyPair('RS256')
    const cases = [
      sign(claims(), otherKeys.privateKey),
      sign(claims(), keys.privateKey, { kid: 'unknown-kid' }),
      sign(claims({ iss: 'https://evil.example.com' })),
      sign(claims({ iss: 'appleid.apple.com' })),
      sign(claims({ aud: 'other-client' })),
      sign(claims(), new TextEncoder().encode('a'.repeat(48)), { alg: 'HS256' }),
    ]
    for (const token of await Promise.all(cases)) {
      const { deps: d } = deps(token)
      await expect(fetchAppleIdentity(EXCHANGE, env, d)).rejects.toThrow()
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
      claims({ aud: [CLIENT_ID, 'other-aud'] }),
      claims({ azp: 'other-client' }),
    ]
    for (const payload of cases) {
      const { deps: d } = deps(await sign(payload))
      await expect(fetchAppleIdentity(EXCHANGE, env, d)).rejects.toThrow()
    }
    const { deps: blankNonce } = deps(await sign(claims()))
    await expect(fetchAppleIdentity({ ...EXCHANGE, nonce: '' }, env, blankNonce)).rejects.toThrow()
  })

  test('only a strictly verified email claim lands on the identity', async () => {
    for (const [verified, expected] of [
      [true, 'a@privaterelay.appleid.com'],
      ['true', 'a@privaterelay.appleid.com'],
      [false, undefined],
      ['false', undefined],
      ['yes', undefined],
      [undefined, undefined],
    ] as const) {
      const { deps: d } = deps(await sign(claims({ email_verified: verified })))
      const result = await fetchAppleIdentity(EXCHANGE, env, d)
      expect(result.identity.email).toBe(expected)
    }
  })

  test('token endpoint failures and malformed responses are rejected', async () => {
    for (const response of [
      new Response('denied', { status: 400 }),
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }),
      new Response(JSON.stringify({ id_token: null }), { status: 200 }),
    ]) {
      const fetcher = (async () => response) as typeof fetch
      await expect(fetchAppleIdentity(EXCHANGE, env, { fetch: fetcher, keyResolver })).rejects.toThrow()
    }
  })

  test('a rejecting fetch propagates as failure', async () => {
    const fetcher = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    await expect(fetchAppleIdentity(EXCHANGE, env, { fetch: fetcher, keyResolver })).rejects.toThrow()
  })

  test('malformed codes, URIs, blank nonce and missing config fail before any fetch', async () => {
    const { stub, deps: d } = deps(await sign(claims()))
    for (const code of ['', '   ', 'x'.repeat(4097), 'code\u0007', 42 as unknown as string]) {
      await expect(fetchAppleIdentity({ ...EXCHANGE, code }, env, d)).rejects.toThrow()
    }
    await expect(fetchAppleIdentity({ ...EXCHANGE, nonce: '' }, env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity({ ...EXCHANGE, redirectUri: 'http://localhost/cb' }, env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity({ ...EXCHANGE, redirectUri: 'https://u:p@manorama.xyz/cb' }, env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity({ ...EXCHANGE, redirectUri: 'https://manorama.xyz/cb#f' }, env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity({ ...EXCHANGE, redirectUri: 'not a url' }, env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity(EXCHANGE, {} as typeof env, d)).rejects.toThrow()
    await expect(fetchAppleIdentity(EXCHANGE, { ...env, APPLE_PRIVATE_KEY: ' ' }, d)).rejects.toThrow()
    expect(stub.calls).toHaveLength(0)
  })
})
