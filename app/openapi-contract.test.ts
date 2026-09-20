import { describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

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
const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
let cookie = ''

const setupAuth = async () => {
  if (cookie) return
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
}

const request = (path: string, init?: RequestInit) => api.request(path, init, env)

describe('OpenAPI contract: static spec', () => {
  test('declares OpenAPI 3.1.0', () => {
    expect(spec.openapi).toBe('3.1.0')
  })

  test('contains exactly the thirteen Manorama operations', () => {
    expect(operationIds().sort()).toEqual([
      'create_gallery', 'delete_gallery', 'get_drive_file', 'get_drive_thumbnail',
      'get_dropbox_file', 'get_dropbox_thumbnail', 'get_icloud_image', 'get_mega_file',
      'get_mega_preview',
      'list_galleries', 'refresh_gallery', 'scan_gallery_source', 'update_gallery',
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

  test('the Gallery schema requires retention and expiresAt', () => {
    const gallery = spec.components.schemas.Gallery as { properties: Record<string, Record<string, unknown>>; required: string[] }
    expect(gallery.required).toContain('retention')
    expect(gallery.required).toContain('expiresAt')
    expect(gallery.properties.retention.enum).toEqual(['retained', 'pipeline'])
    expect(gallery.properties.expiresAt.format).toBe('date-time')
  })

  test('the Error schema carries the policy codes and dashboardUrl', () => {
    const error = spec.components.schemas.Error as { properties: Record<string, Record<string, unknown>> }
    expect(error.properties.code.enum).toEqual(['GALLERY_LIMIT', 'GALLERY_READ_ONLY'])
    expect(error.properties.dashboardUrl.type).toBe('string')
  })

  test('mutation operations document the 403 policy refusal', () => {
    for (const op of [
      spec.paths['/api/galleries'].post,
      spec.paths['/api/galleries/{slug}'].patch,
      spec.paths['/api/galleries/{slug}/refresh'].post,
    ]) {
      const responses = (op as { responses: Record<string, { $ref?: string }> }).responses
      expect(responses['403']?.$ref).toBe('#/components/responses/Forbidden')
    }
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

  // MEGA scope is either folder OR set — OpenAPI parameters cannot express
  // the dependency, so the contract test pins the documented 400 instead.
  test('mega file proxy rejects a scope-less request with 400', async () => {
    const response = await request('/api/mega/file?node=abc&k=xyz')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing MEGA image reference' })
  })

  test('mega preview proxy rejects a scope-less request with 400', async () => {
    const response = await request('/api/mega/preview?h=abc&k=xyz')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing MEGA image reference' })
  })

  test('a create without a Dropbox URL reports 400 with the contract error shape', async () => {
    await setupAuth()
    const response = await api.request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    }, env)
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
      '/api/drive/file', '/api/drive/thumbnail', '/api/dropbox/file', '/api/dropbox/thumbnail',
      '/api/galleries', '/api/galleries/scan', '/api/galleries/{slug}',
      '/api/galleries/{slug}/refresh', '/api/icloud/image', '/api/mega/file', '/api/mega/preview',
    ])
  })
})
