import { beforeAll, describe, expect, test } from 'bun:test'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import { createManoramaApi } from './api'
import type { AccessEnv, AccessJwtVerifier } from './lib/session'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const accessEnv: AccessEnv = {
  CF_ACCESS_TEAM_DOMAIN: 'manorama-team',
  CF_ACCESS_AUD: 'manorama-test-audience',
}
const env = { ...accessEnv }
const issuer = `https://${accessEnv.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`

let assertion: string

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const verifier: AccessJwtVerifier = (token, checks) =>
    jwtVerify(token, publicKey, { issuer: checks.issuer, audience: checks.audience })
      .then(({ payload }) => payload as { sub?: unknown; email?: unknown })
  assertion = await new SignJWT({ sub: 'owner-1', email: 'mahesh@manorama.xyz' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(accessEnv.CF_ACCESS_AUD!)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey)
  // Keep a reference so the closure is exercised at least once per run.
  await verifier(assertion, { issuer, audience: accessEnv.CF_ACCESS_AUD! })
})

const request = (path: string, init: RequestInit = {}) =>
  createManoramaApi().request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), 'Cf-Access-Jwt-Assertion': assertion },
  }, env)

const patch = (slug: string, body: object) =>
  request(`/api/galleries/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('slug rename contract', () => {
  test('renames via body newSlug, not body slug', async () => {
    const response = await patch('italy-2018', { newSlug: 'italy-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('italy-renamed')
  })

  test('the URL slug stays the resource identity: the old slug is gone', async () => {
    const response = await patch('italy-2018', { title: 'Stale' })
    expect(response.status).toBe(404)
  })

  test('a body-level replacement slug is no longer accepted', async () => {
    const response = await patch('italy-renamed', { slug: 'something-else' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Provide a gallery URL, metadata, or an image order to update' })
  })

  test('an invalid newSlug is rejected with the URL guidance', async () => {
    const response = await patch('italy-renamed', { newSlug: 'Not A Valid Slug' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' })
  })

  test('renaming onto an existing slug reports a collision', async () => {
    // The bundled italy-2018 fixture always resolves, so it is a guaranteed
    // collision target in the local runtime store.
    const response = await patch('italy-renamed', { newSlug: 'italy-2018' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That gallery URL is already in use' })
  })

  test('a no-op rename returns the unchanged gallery', async () => {
    const response = await patch('italy-renamed', { newSlug: 'italy-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('italy-renamed')
  })

  test('metadata combines with newSlug and lands on the renamed gallery', async () => {
    const response = await patch('italy-renamed', { newSlug: 'italy-final', title: 'Final Title' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string; title: string } }
    expect(payload.gallery?.slug).toBe('italy-final')
    expect(payload.gallery?.title).toBe('Final Title')
    // Metadata was NOT applied to the pre-rename identity.
    expect((await patch('italy-renamed', { caption: 'x' })).status).toBe(404)
  })

  test('a missing gallery reports 404 for rename attempts', async () => {
    const response = await patch('never-created', { newSlug: 'whatever' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'That gallery was not found' })
  })

  test('the Admin island sends newSlug when editing the slug', () => {
    const admin = readFileSync(`${repoRoot}/app/islands/Admin.tsx`, 'utf8')
    expect(admin).toContain('newSlug')
  })
})
