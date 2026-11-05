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
  cookie = await sessionCookieFor(TEST_OWNER.accountId)
}

const request = (path: string, init?: RequestInit) => api.request(path, init, env)

describe('OpenAPI contract: static spec', () => {
  test('declares OpenAPI 3.1.0', () => {
    expect(spec.openapi).toBe('3.1.0')
  })

  test('contains exactly the thirteen Manorama operations', () => {
    expect(operationIds().sort()).toEqual([
      'create_gallery', 'delete_gallery', 'get_drive_file', 'get_drive_thumbnail',
      'get_dropbox_file', 'get_dropbox_thumbnail', 'get_icloud_image',
      'list_galleries', 'migrate_gallery', 'pin_gallery', 'refresh_gallery', 'scan_gallery_source', 'update_gallery',
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
    // The runtime PATCH also accepts hidden (image keys) and pinned — both
    // were undocumented until issue #175; keep them declared.
    const fields = Object.keys((resolved as { properties: Record<string, unknown> }).properties)
    expect(fields).toContain('hidden')
    expect(fields).toContain('pinned')
  })

  test('the Gallery schema requires retention and expiresAt', () => {
    const gallery = spec.components.schemas.Gallery as { properties: Record<string, Record<string, unknown>>; required: string[] }
    expect(gallery.required).toContain('retention')
    expect(gallery.required).toContain('expiresAt')
    expect(gallery.properties.retention.enum).toEqual(['retained', 'pipeline'])
    expect(gallery.properties.expiresAt.format).toBe('date-time')
  })

  test('the Error schema carries the refusal codes and dashboardUrl', () => {
    const error = spec.components.schemas.Error as { properties: Record<string, Record<string, unknown>> }
    expect(error.properties.code.enum).toEqual([
      'CLIENT_SCAN_REQUIRED', 'GALLERY_LIMIT', 'GALLERY_READ_ONLY',
      'MANIFEST_TOO_LARGE', 'PARTIAL_SCAN', 'PIN_LIMIT',
    ])
    expect(error.properties.dashboardUrl.type).toBe('string')
  })

  test('create accepts either an unencrypted url or an encrypted manifest, never both required', () => {
    const create = spec.components.schemas.CreateRequest as {
      anyOf: { required: string[] }[]
      properties: Record<string, unknown>
      additionalProperties: boolean
    }
    expect(create.anyOf).toEqual([{ required: ['url'] }, { required: ['manifest'] }])
    expect(create.additionalProperties).toBe(false)
    // The url form no longer advertises server-side MEGA scanning.
    const url = create.properties.url as { description: string }
    expect(url.description).not.toContain('MEGA folder/collection')
    expect(url.description).toContain('client-scanned manifest')
  })

  test('the encrypted manifest schema mirrors the runtime validator', () => {
    const manifest = spec.components.schemas.EncryptedManifest as {
      required: string[]
      additionalProperties: boolean
      properties: Record<string, Record<string, unknown>>
    }
    expect(manifest.required).toEqual(['provider', 'sourceUrl', 'title', 'images'])
    expect(manifest.additionalProperties).toBe(false)
    expect(manifest.properties.provider.enum).toEqual(['ente', 'mega', 'proton'])
    const image = spec.components.schemas.EncryptedManifestImage as {
      required: string[]
      properties: Record<string, Record<string, unknown>>
    }
    expect(image.properties.src.const).toBe('')
    expect(image.properties.contentVersion.pattern).toBe('^[0-9a-f]{64}$')
    expect(image.required).toContain('media')
    expect(image.required).toContain('contentVersion')
    const media = spec.components.schemas.EncryptedMediaReference as { required: string[] }
    expect(media.required).toEqual(['kind', 'provider', 'sourceKind', 'sourceId', 'nodeId'])
  })

  test('every required field is declared — required ⊆ properties on closed schemas', () => {
    // A required name missing from properties under additionalProperties:false
    // makes the schema unsatisfiable: every runtime-valid manifest violates it.
    const schemas = spec.components.schemas as Record<string, { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean }>
    for (const [name, schema] of Object.entries(schemas)) {
      if (schema.additionalProperties !== false || !schema.required || !schema.properties) continue
      const missing = schema.required.filter((field) => !(field in (schema.properties ?? {})))
      expect({ schema: name, missing }).toEqual({ schema: name, missing: [] })
    }
  })

  test('migrate_gallery is pinned to its path, request shape, and conflict response', () => {
    const migrate = spec.paths['/api/galleries/{slug}/migrate'].post as {
      operationId: string
      requestBody: { required: boolean }
      responses: Record<string, { $ref?: string }>
    }
    expect(migrate.operationId).toBe('migrate_gallery')
    expect(migrate.requestBody.required).toBe(true)
    expect(migrate.responses['409']?.$ref).toBe('#/components/responses/Conflict')
    const request = spec.components.schemas.MigrateRequest as { required: string[] }
    expect(request.required).toEqual(['manifest', 'deviceId'])
  })

  test('pin_gallery documents the required pin body and the PIN_LIMIT conflict', () => {
    const pin = spec.paths['/api/galleries/{slug}/pin'].patch as {
      operationId: string
      requestBody: { required: boolean; content: Record<string, { schema: { $ref?: string } }> }
      responses: Record<string, { $ref?: string }>
    }
    expect(pin.operationId).toBe('pin_gallery')
    expect(pin.requestBody.required).toBe(true)
    expect(pin.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/PinRequest')
    expect(pin.responses['409']?.$ref).toBe('#/components/responses/Conflict')
    const request = spec.components.schemas.PinRequest as { required: string[] }
    expect(request.required).toEqual(['pinned'])
  })

  test('refresh documents the manifest body for encrypted galleries', () => {
    const refresh = spec.paths['/api/galleries/{slug}/refresh'].post as {
      requestBody?: { content: Record<string, { schema: { $ref?: string } }> }
    }
    expect(refresh.requestBody?.content['application/json'].schema.$ref).toBe('#/components/schemas/RefreshRequest')
  })

  test('mutation operations document the 403 policy refusal', () => {
    for (const op of [
      spec.paths['/api/galleries'].post,
      spec.paths['/api/galleries/{slug}'].patch,
      spec.paths['/api/galleries/{slug}/pin'].patch,
      spec.paths['/api/galleries/{slug}/refresh'].post,
    ]) {
      const responses = (op as { responses: Record<string, { $ref?: string }> }).responses
      expect(responses['403']?.$ref).toBe('#/components/responses/Forbidden')
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

  test('mega file proxy is gone', async () => {
    const response = await request('/api/mega/file?node=abc&k=xyz')
    expect(response.status).toBe(404)
  })

  test('mega preview proxy is gone', async () => {
    const response = await request('/api/mega/preview?h=abc&k=xyz')
    expect(response.status).toBe(404)
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
    // Every operation the spec declares must match an implemented route shape.
    const specPaths = Object.keys(spec.paths).sort()
    expect(specPaths).toEqual([
      '/api/drive/file', '/api/drive/thumbnail', '/api/dropbox/file', '/api/dropbox/thumbnail',
      '/api/galleries', '/api/galleries/scan', '/api/galleries/{slug}',
      '/api/galleries/{slug}/migrate', '/api/galleries/{slug}/pin', '/api/galleries/{slug}/refresh', '/api/icloud/image',
    ])
  })
})
