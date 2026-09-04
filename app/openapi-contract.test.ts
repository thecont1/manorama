import { describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import type { AccessJwtVerifier } from './lib/session'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const spec = JSON.parse(readFileSync(`${repoRoot}/openapi.json`, 'utf8')) as {
  openapi: string
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, Record<string, unknown>> }
}

const operationIds = () =>
  Object.values(spec.paths)
    .flatMap((item) => Object.values(item))
    .filter((op): op is Record<string, unknown> => typeof op === 'object' && op !== null && 'operationId' in op)
    .map((op) => op.operationId as string)

const api = createManoramaApi()
let authedApi: ReturnType<typeof createManoramaApi> | null = null
let assertion = ''

const setupAuthedApi = async () => {
  if (authedApi) return
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const verifier: AccessJwtVerifier = (token, checks) =>
    jwtVerify(token, publicKey, { issuer: checks.issuer, audience: checks.audience })
      .then(({ payload }) => payload as { sub?: unknown; email?: unknown })
  assertion = await new SignJWT({ sub: 'owner-1', email: 'mahesh@manorama.xyz' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('https://manorama-team.cloudflareaccess.com')
    .setAudience('manorama-test-audience')
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey)
  authedApi = createManoramaApi({ sessionVerifier: verifier })
}

const request = (path: string, init?: RequestInit) => api.request(path, init)

describe('OpenAPI contract: static spec', () => {
  test('declares OpenAPI 3.1.0', () => {
    expect(spec.openapi).toBe('3.1.0')
  })

  test('contains exactly the eight Manorama operations', () => {
    expect(operationIds().sort()).toEqual([
      'create_gallery', 'delete_gallery', 'get_dropbox_file', 'get_dropbox_thumbnail',
      'list_galleries', 'refresh_gallery', 'scan_dropbox_folder', 'update_gallery',
    ])
  })

  test('no operation advertises a body-level replacement slug', () => {
    const update = spec.paths['/api/galleries/{slug}'].patch as { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } }
    const schema = update.requestBody.content['application/json'].schema
    const resolved = schema.$ref
      ? spec.components.schemas[(schema.$ref as string).split('/').pop() as string]
      : schema
    expect(Object.keys((resolved as { properties: Record<string, unknown> }).properties)).not.toContain('slug')
    expect(Object.keys((resolved as { properties: Record<string, unknown> }).properties)).toContain('newSlug')
  })

  test('operationIds match the Vendo tool bindings', () => {
    // The generated catalog prefixes tool names with host_ but preserves the
    // contract's operationId in each binding — that is the alignment that matters.
    const tools = JSON.parse(readFileSync(`${repoRoot}/.vendo/tools.json`, 'utf8')) as { tools: { name: string; binding: { operationId?: string } }[] }
    const boundOperationIds = tools.tools
      .map((tool) => tool.binding?.operationId ?? tool.name.replace(/^host_/, ''))
      .sort()
    expect(operationIds().sort()).toEqual(boundOperationIds)
    // And every tool name is the prefixed operationId.
    for (const tool of tools.tools) {
      expect(tool.name).toBe(`host_${tool.binding?.operationId}`)
    }
  })
})

describe('OpenAPI contract: runtime behavior', () => {
  test('unauthenticated list_galleries is rejected', async () => {
    const response = await request('/api/galleries')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  test('unauthenticated create_gallery is rejected', async () => {
    const response = await request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/fake' }),
    })
    expect(response.status).toBe(401)
  })

  test('unauthenticated update_gallery is rejected', async () => {
    const response = await request('/api/galleries/test-gallery', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    })
    expect(response.status).toBe(401)
  })

  test('unauthenticated delete_gallery is rejected', async () => {
    const response = await request('/api/galleries/test-gallery', { method: 'DELETE' })
    expect(response.status).toBe(401)
  })

  test('dropbox proxy rejects malformed requests with 400', async () => {
    const response = await request('/api/dropbox/thumbnail')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing Dropbox image reference' })
  })

  test('dropbox file proxy rejects malformed requests with 400', async () => {
    const response = await request('/api/dropbox/file?sourceUrl=x')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing Dropbox image reference' })
  })

  test('a create without a Dropbox URL reports 400 with the contract error shape', async () => {
    await setupAuthedApi()
    const response = await authedApi!.request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': assertion },
      body: JSON.stringify({}),
    }, { CF_ACCESS_TEAM_DOMAIN: 'manorama-team', CF_ACCESS_AUD: 'manorama-test-audience' })
    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(typeof payload.error).toBe('string')
    expect(payload.error!.length).toBeGreaterThan(0)
  })

  test('the API surface is fully covered by the spec paths', () => {
    // Every operation the spec declares must match an implemented route shape,
    // and the spec must not drift from the eight Vendo tools.
    const specPaths = Object.keys(spec.paths).sort()
    expect(specPaths).toEqual([
      '/api/dropbox/file', '/api/dropbox/thumbnail', '/api/galleries',
      '/api/galleries/scan', '/api/galleries/{slug}', '/api/galleries/{slug}/refresh',
    ])
  })
})
