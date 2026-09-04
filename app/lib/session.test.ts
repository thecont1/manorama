import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import type { AccessJwtVerifier } from './session'

const env = { CF_ACCESS_TEAM_DOMAIN: 'manorama-team', CF_ACCESS_AUD: 'manorama-test-audience' }
const issuer = `https://${env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`

let verifier: AccessJwtVerifier
let otherVerifier: AccessJwtVerifier
let privateKey: CryptoKey
let publicKey: CryptoKey
let foreignKey: CryptoKey

beforeAll(async () => {
  const own = await generateKeyPair('RS256', { extractable: true })
  const foreign = await generateKeyPair('RS256', { extractable: true })
  privateKey = own.privateKey
  publicKey = own.publicKey
  foreignKey = foreign.privateKey
  verifier = (token, checks) => jwtVerify(token, own.publicKey, {
    issuer: checks.issuer,
    audience: checks.audience,
  }).then(({ payload }) => payload as { sub?: unknown; email?: unknown })
  otherVerifier = (token, checks) => jwtVerify(token, foreign.publicKey, {
    issuer: checks.issuer,
    audience: checks.audience,
  }).then(({ payload }) => payload as { sub?: unknown; email?: unknown })
})

const token = async (claims: Record<string, unknown>, key: CryptoKey = privateKey) =>
  new SignJWT({ iss: issuer, aud: env.CF_ACCESS_AUD, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(key)

const request = (url: string, init?: RequestInit) => new Request(url, init)

describe('resolveManoramaSession', () => {
  test('resolves a valid RS256 Access token to a session keyed on the immutable sub', async () => {
    const { resolveManoramaSession } = await import('./session')
    const sub = '85d2ac0a-4fbb-4a52-8b53-55b1a3d4e5f6'
    const assertion = await token({ sub, email: 'mahesh@manorama.xyz' })
    const session = await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )
    expect(session).toEqual({ id: `cf-access:${sub}`, email: 'mahesh@manorama.xyz' })
  })

  test('omits email when the verified token carries none', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's1' })
    const session = await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )
    expect(session).toEqual({ id: 'cf-access:s1' })
  })

  test('missing token resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    expect(await resolveManoramaSession(request('https://manorama.xyz/api/galleries'), env, verifier)).toBeNull()
  })

  test('wrong audience resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's2', aud: 'some-other-application' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('wrong issuer resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's3', iss: 'https://attacker.example.com' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('expired token resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await new SignJWT({ sub: 's4' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(env.CF_ACCESS_AUD)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey)
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('not-yet-valid token resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await new SignJWT({ sub: 's5' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(env.CF_ACCESS_AUD)
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) + 600)
      .setExpirationTime('2m')
      .sign(privateKey)
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('invalid signature resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's6' }, foreignKey)
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
    const trustedForeign = await token({ sub: 's6' }, foreignKey)
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': trustedForeign } }),
      env,
      otherVerifier,
    )).toEqual({ id: 'cf-access:s6' })
  })

  test('missing sub resolves to null', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ email: 'mahesh@manorama.xyz' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('an unverified email header never becomes identity or session email', async () => {
    const { resolveManoramaSession } = await import('./session')
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'x-user-email': 'attacker@example.com' } }),
      env,
      verifier,
    )).toBeNull()
    const assertion = await token({ sub: 's7' })
    const session = await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', {
        headers: { 'Cf-Access-Jwt-Assertion': assertion, 'x-user-email': 'attacker@example.com' },
      }),
      env,
      verifier,
    )
    expect(session).toEqual({ id: 'cf-access:s7' })
  })

  test('an x-user-id header is never accepted as identity', async () => {
    const { resolveManoramaSession } = await import('./session')
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'x-user-id': 'user_42' } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('a query or body subject is never accepted as identity', async () => {
    const { resolveManoramaSession } = await import('./session')
    expect(await resolveManoramaSession(request('https://manorama.xyz/api/galleries?sub=user_42'), env, verifier)).toBeNull()
    expect(await resolveManoramaSession(request('https://manorama.xyz/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sub: 'user_42' }),
    }), env, verifier)).toBeNull()
  })

  test('accepts the CF_Authorization cookie only through the same verification path', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's8', email: 'mahesh@manorama.xyz' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { Cookie: `CF_Authorization=${assertion}; other=1` } }),
      env,
      verifier,
    )).toEqual({ id: 'cf-access:s8', email: 'mahesh@manorama.xyz' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { Cookie: 'CF_Authorization=not-a-jwt' } }),
      env,
      verifier,
    )).toBeNull()
  })

  test('the assertion header wins over a stale cookie', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's9' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', {
        headers: { 'Cf-Access-Jwt-Assertion': assertion, Cookie: 'CF_Authorization=stale-garbage' },
      }),
      env,
      verifier,
    )).toEqual({ id: 'cf-access:s9' })
  })

  test('missing Access configuration fails closed', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 's10' })
    for (const broken of [{ CF_ACCESS_AUD: 'aud' }, { CF_ACCESS_TEAM_DOMAIN: 'team' }, {}]) {
      expect(await resolveManoramaSession(
        request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
        broken,
        verifier,
      )).toBeNull()
    }
  })

  test('caches the remote JWKS client per team, never request or user state', async () => {
    const { accessJwksUrl, cachedJwksClient, resetAccessJwksCache } = await import('./session')
    expect(accessJwksUrl(issuer)).toBe(`${issuer}/cdn-cgi/access/certs`)
    const first = cachedJwksClient(issuer)
    const second = cachedJwksClient(issuer)
    expect(second).toBe(first)
    const other = cachedJwksClient('https://another-team.cloudflareaccess.com')
    expect(other).not.toBe(first)
    resetAccessJwksCache()
    expect(cachedJwksClient(issuer)).not.toBe(first)
  })

  test('a dev inline JWKS verifies through the same path without a network', async () => {
    const { resolveManoramaSession, exportPublicJwk } = await import('./session')
    const jwks = JSON.stringify({ keys: [await exportPublicJwk(publicKey)] })
    const devEnv = { ...env, CF_ACCESS_JWKS: jwks }
    const sub = 'dev-owner-1'
    const assertion = await token({ sub, email: 'mahesh@manorama.xyz' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      devEnv,
    )).toEqual({ id: `cf-access:${sub}`, email: 'mahesh@manorama.xyz' })
    const wrongIssuer = await token({ sub, iss: 'https://attacker.example.com' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': wrongIssuer } }),
      devEnv,
    )).toBeNull()
  })

  test('a malformed inline JWKS fails closed', async () => {
    const { resolveManoramaSession } = await import('./session')
    const assertion = await token({ sub: 'dev-owner-2' })
    expect(await resolveManoramaSession(
      request('https://manorama.xyz/api/galleries', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }),
      { ...env, CF_ACCESS_JWKS: 'not-json' },
    )).toBeNull()
  })
})
