import { beforeAll, describe, expect, test } from 'bun:test'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import { createManoramaApi } from './api'
import { createGallery } from './lib/gallery-repository'
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

let api: ReturnType<typeof createManoramaApi>
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
  api = createManoramaApi({ sessionVerifier: verifier })

  // Seed a runtime gallery (no Airtable env -> in-memory store) with a slug
  // distinct from the bundled italy-2018 fixture, which always resolves.
  await createGallery({
    slug: 'test-gallery',
    title: 'Test Gallery',
    caption: '',
    date: '',
    createdAt: '2026-09-04T00:00:00.000Z',
    images: [],
  })
})

const patch = (slug: string, body: object) =>
  api.request(`/api/galleries/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': assertion },
    body: JSON.stringify(body),
  }, env)

describe('slug rename contract', () => {
  test('renames via body newSlug, not body slug', async () => {
    const response = await patch('test-gallery', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('the URL slug stays the resource identity: the old slug is gone', async () => {
    const response = await patch('test-gallery', { title: 'Stale' })
    expect(response.status).toBe(404)
  })

  test('a body-level replacement slug is no longer accepted', async () => {
    const response = await patch('test-renamed', { slug: 'something-else' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Provide a gallery URL, metadata, or an image order to update' })
  })

  test('an invalid newSlug is rejected with the URL guidance', async () => {
    const response = await patch('test-renamed', { newSlug: 'Not A Valid Slug' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' })
  })

  test('renaming onto an existing slug reports a collision', async () => {
    // The bundled italy-2018 fixture always resolves, so it is a guaranteed
    // collision target in the local runtime store.
    const response = await patch('test-renamed', { newSlug: 'italy-2018' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That gallery URL is already in use' })
  })

  test('a no-op rename returns the unchanged gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('metadata combines with newSlug and lands on the renamed gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-final', title: 'Final Title' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string; title: string } }
    expect(payload.gallery?.slug).toBe('test-final')
    expect(payload.gallery?.title).toBe('Final Title')
    // Metadata was NOT applied to the pre-rename identity.
    expect((await patch('test-renamed', { caption: 'x' })).status).toBe(404)
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
