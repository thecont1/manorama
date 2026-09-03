import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { generateKeyPair, SignJWT, jwtVerify } from 'jose'
import type { AccessEnv, AccessJwtVerifier } from './lib/session'
import { createManoramaApi } from './api'
import { ownerAdminGate } from './lib/admin-gate'
import renderer from './routes/_renderer'
import ownerPage from './routes/[owner]'
import viewerPage from './routes/[owner]/[slug]'

/** honox's createApp runs every request inside this context store; route
 *  modules (HasIslands) rely on it. Replicated here for plain-Hono tests. */
const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const accessEnv: AccessEnv = {
  CF_ACCESS_TEAM_DOMAIN: 'manorama-team',
  CF_ACCESS_AUD: 'manorama-test-audience',
}
const env = { OWNER_SLUG: 'thecontrarian', ...accessEnv }
const issuer = `https://${accessEnv.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`

let verifier: AccessJwtVerifier
let assertion: string

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  verifier = (token, checks) => jwtVerify(token, publicKey, {
    issuer: checks.issuer,
    audience: checks.audience,
  }).then(({ payload }) => payload as { sub?: unknown; email?: unknown })
  assertion = await new SignJWT({ sub: 'owner-1', email: 'mahesh@manorama.xyz' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(accessEnv.CF_ACCESS_AUD!)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey)
})

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), 'Cf-Access-Jwt-Assertion': assertion },
})

/** Mounts a honox route module's default export (a handler or handler array,
 *  exactly the two shapes honox's server accepts). */
const mountRoute = (app: Hono, path: string, route: unknown) => {
  if (Array.isArray(route)) app.get(path, ...(route as Handler[]))
  else app.get(path, route as Handler)
}

describe('gallery management API authentication', () => {
  const api = () => createManoramaApi({ sessionVerifier: verifier })
  const request = (app: Hono, path: string, init: RequestInit = {}) => app.request(path, init, env)

  const managementEndpoints: readonly (readonly [method: string, path: string, init?: RequestInit])[] = [
    ['GET', '/api/galleries'],
    ['POST', '/api/galleries', { method: 'POST', body: '{}' }],
    ['POST', '/api/galleries/scan', { method: 'POST', body: '{}' }],
    ['PATCH', '/api/galleries/italy-2018', { method: 'PATCH', body: '{}' }],
    ['DELETE', '/api/galleries/italy-2018', { method: 'DELETE' }],
    ['POST', '/api/galleries/italy-2018/refresh', { method: 'POST' }],
  ]

  for (const [method, path, init] of managementEndpoints) {
    test(`anonymous ${method} ${path} returns 401 JSON`, async () => {
      const response = await request(api(), path, init)
      expect(response.status).toBe(401)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toEqual({ error: 'Authentication required' })
    })

    test(`an invalid session ${method} ${path} returns 401`, async () => {
      const response = await request(api(), path, {
        ...init,
        headers: { 'Cf-Access-Jwt-Assertion': 'not-a-jwt' },
      })
      expect(response.status).toBe(401)
    })
  }

  test('a valid owner session reaches the gallery list handler', async () => {
    const response = await request(api(), '/api/galleries', authed())
    expect(response.status).toBe(200)
    const payload = await response.json() as { galleries?: { slug: string }[] }
    expect(payload.galleries?.some((gallery) => gallery.slug === 'italy-2018')).toBe(true)
  })

  test('a valid owner session reaches the scan validation handler', async () => {
    const response = await request(api(), '/api/galleries/scan', authed({ method: 'POST', body: '{}' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Paste a public Dropbox folder URL' })
  })

  test('a valid owner session reaches the update validation handler', async () => {
    const response = await request(api(), '/api/galleries/italy-2018', authed({ method: 'PATCH', body: '{}' }))
    expect(response.status).toBe(400)
  })

  test('a valid owner session reaches the delete handler for a missing gallery', async () => {
    const response = await request(api(), '/api/galleries/never-created', authed({ method: 'DELETE' }))
    expect(response.status).toBe(404)
  })

  test('the Dropbox image proxy stays public for gallery pages', async () => {
    const app = api()
    const thumbnail = await request(app, '/api/dropbox/thumbnail')
    expect(thumbnail.status).toBe(400)
    expect(await thumbnail.json()).toEqual({ error: 'Missing Dropbox image reference' })
    const file = await request(app, '/api/dropbox/file')
    expect(file.status).toBe(400)
    expect(await file.json()).toEqual({ error: 'Missing Dropbox image reference' })
  })
})

describe('owner admin page authentication', () => {
  const page = () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use('/:owner', ownerAdminGate(verifier))
    app.use(renderer)
    mountRoute(app, '/:owner', ownerPage)
    return app
  }

  test('anonymous request does not render the admin application', async () => {
    const response = await page().request('/thecontrarian', undefined, env)
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  test('a valid owner session renders the admin application', async () => {
    const response = await page().request('/thecontrarian', authed(), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Add from Dropbox')
  })

  test('a non-owner single-segment path is not locked by the admin gate', async () => {
    const response = await page().request('/some-other-page', undefined, env)
    expect(response.status).toBe(404)
  })

  test('the page itself fails closed when no session was resolved', async () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner', ownerPage)
    const response = await app.request('/thecontrarian', undefined, env)
    expect(response.status).toBe(401)
  })
})

describe('public gallery pages stay public', () => {
  test('the viewer page renders without a session', async () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner/:slug', viewerPage)
    const response = await app.request('/thecontrarian/italy-2018', undefined, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('curtain')
  })
})
