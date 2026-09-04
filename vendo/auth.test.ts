import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import { requireSession, type AccessEnv, type AccessJwtVerifier, type SessionEnv } from '../app/lib/session'
import { createVendoAuth } from './server'

const accessEnv: AccessEnv = {
  CF_ACCESS_TEAM_DOMAIN: 'manorama-team',
  CF_ACCESS_AUD: 'manorama-test-audience',
}
const issuer = `https://${accessEnv.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`

let verifier: AccessJwtVerifier
let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey }

beforeAll(async () => {
  keyPair = await generateKeyPair('RS256')
  verifier = (token, checks) => jwtVerify(token, keyPair.publicKey, {
    issuer: checks.issuer,
    audience: checks.audience,
  }).then(({ payload }) => payload as { sub?: unknown; email?: unknown })
})

const signedToken = (claims: Record<string, unknown>) =>
  new SignJWT({ iss: issuer, aud: accessEnv.CF_ACCESS_AUD, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(keyPair.privateKey)

const request = (init?: RequestInit) => new Request('https://manorama.xyz/api/vendo/threads', init)

describe('Vendo principals resolve from the Manorama Access session', () => {
  test('anonymous requests produce a null principal', async () => {
    const auth = createVendoAuth(accessEnv, verifier)
    expect(await auth.principal(request())).toBeNull()
  })

  test('invalid Access assertions produce a null principal', async () => {
    const auth = createVendoAuth(accessEnv, verifier)
    expect(await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' } }))).toBeNull()
    const foreign = await generateKeyPair('RS256')
    const forged = await new SignJWT({ sub: 'attacker', iss: issuer, aud: accessEnv.CF_ACCESS_AUD })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(foreign.privateKey)
    expect(await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': forged } }))).toBeNull()
  })

  test('missing Access configuration fails closed', async () => {
    const auth = createVendoAuth({}, verifier)
    const assertion = await signedToken({ sub: 'owner-1' })
    expect(await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': assertion } }))).toBeNull()
  })

  test('a valid Access request produces the cf-access principal', async () => {
    const auth = createVendoAuth(accessEnv, verifier)
    const assertion = await signedToken({ sub: '85d2ac0a-4fbb-4a52-8b53-55b1a3d4e5f6', email: 'mahesh@manorama.xyz' })
    expect(await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': assertion } })))
      .toEqual({ kind: 'user', subject: 'cf-access:85d2ac0a-4fbb-4a52-8b53-55b1a3d4e5f6' })
  })

  test('email changes never change the principal subject', async () => {
    const auth = createVendoAuth(accessEnv, verifier)
    const first = await signedToken({ sub: 'same-sub', email: 'mahesh@manorama.xyz' })
    const second = await signedToken({ sub: 'same-sub', email: 'mahesh+alias@manorama.xyz' })
    const firstPrincipal = await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': first } }))
    const secondPrincipal = await auth.principal(request({ headers: { 'Cf-Access-Jwt-Assertion': second } }))
    expect(firstPrincipal).toEqual(secondPrincipal)
    expect(JSON.stringify(firstPrincipal)).not.toContain('manorama.xyz')
  })

  test('the verified email is exposed only through facts, never the subject', async () => {
    const auth = createVendoAuth(accessEnv, verifier)
    const withEmail = await signedToken({ sub: 'owner-2', email: 'mahesh@manorama.xyz' })
    const withoutEmail = await signedToken({ sub: 'owner-3' })
    expect(await auth.facts?.(request({ headers: { 'Cf-Access-Jwt-Assertion': withEmail } })))
      .toEqual({ email: 'mahesh@manorama.xyz' })
    expect(await auth.facts?.(request({ headers: { 'Cf-Access-Jwt-Assertion': withoutEmail } }))).toBeUndefined()
    expect(await auth.facts?.(request())).toBeUndefined()
  })

  test('the API middleware and Vendo resolve byte-for-byte identical subjects', async () => {
    const app = new Hono<SessionEnv>()
    app.use(requireSession(verifier))
    app.get('/whoami', (c) => c.json({ id: c.get('manoramaSession').id }))
    const assertion = await signedToken({ sub: 'shared-subject', email: 'mahesh@manorama.xyz' })
    const init = { headers: { 'Cf-Access-Jwt-Assertion': assertion } }
    const response = await app.request('/whoami', init, accessEnv)
    expect(response.status).toBe(200)
    const { id } = await response.json() as { id: string }
    const auth = createVendoAuth(accessEnv, verifier)
    expect((await auth.principal(request(init)))?.subject).toBe(id)
  })
})
