import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { createManoramaApi } from './api'
import type { HonoSessionEnv } from './lib/dropbox-session'
import renderer from './routes/_renderer'
import ownerPage from './routes/[owner]'
import viewerPage from './routes/[owner]/[slug]'
import indexPage from './routes/index'
import { resetUserStore } from './lib/user-repository'
import { resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

/** honox's createApp runs every request inside this context store; route
 *  modules (HasIslands) rely on it. Replicated here for plain-Hono tests. */
const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let cookie: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
})

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), Cookie: cookie },
})

/** Mounts a honox route module's default export (a handler or handler array,
 *  exactly the two shapes honox's server accepts). */
const mountRoute = (app: Hono, path: string, route: unknown) => {
  // hono's app.get overloads are fixed-arity per handler count, so a spread
  // of an unknown-length array can't satisfy them. Bind and cast to a
  // variadic signature so the runtime registers the route as-is.
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

describe('gallery management API authentication', () => {
  const api = () => createManoramaApi()
  const request = (app: Hono<HonoSessionEnv>, path: string, init: RequestInit = {}) => app.request(path, init, env)

  const managementEndpoints: readonly (readonly [method: string, path: string, init?: RequestInit])[] = [
    ['GET', '/api/galleries'],
    ['POST', '/api/galleries', { method: 'POST', body: '{}' }],
    ['POST', '/api/galleries/scan', { method: 'POST', body: '{}' }],
    ['PATCH', '/api/galleries/italy-2018', { method: 'PATCH', body: '{}' }],
    ['DELETE', '/api/galleries/italy-2018', { method: 'DELETE' }],
    ['POST', '/api/galleries/italy-2018/refresh', { method: 'POST' }],
    ['PATCH', '/api/account', { method: 'PATCH', body: '{}' }],
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
        headers: { Cookie: 'manorama_session=not-a-jwt' },
      })
      expect(response.status).toBe(401)
    })
  }

  test('a valid session reaches the gallery list handler', async () => {
    const response = await request(api(), '/api/galleries', authed())
    expect(response.status).toBe(200)
    const payload = await response.json() as { galleries?: { slug: string }[] }
    // The bundled italy-2018 fixture resolves for every owner in the
    // in-memory fallback.
    expect(payload.galleries?.some((gallery) => gallery.slug === 'italy-2018')).toBe(true)
  })

  test('a valid session reaches the scan validation handler', async () => {
    const response = await request(api(), '/api/galleries/scan', authed({ method: 'POST', body: '{}' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Paste a public Dropbox folder URL' })
  })

  test('a valid session reaches the update validation handler', async () => {
    const response = await request(api(), '/api/galleries/italy-2018', authed({ method: 'PATCH', body: '{}' }))
    expect(response.status).toBe(400)
  })

  test('a valid session reaches the delete handler for a missing gallery', async () => {
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

describe('owner dashboard authentication', () => {
  const page = () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner', ownerPage)
    return app
  }

  test('an unknown owner slug is a 404, no session required', async () => {
    const response = await page().request('/nobody-here', undefined, env)
    expect(response.status).toBe(404)
  })

  test('an anonymous request is redirected to the landing page', async () => {
    const response = await page().request('/test-owner', undefined, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
  })

  test('a valid owner session renders the dashboard with the Vendo surface', async () => {
    const response = await page().request('/test-owner', authed(), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Add from Dropbox')
    expect(html).toContain('Sign out')
    expect(html).toContain('id="vendo-root"')
    expect(html.indexOf('/app/vendo-client.tsx')).toBeGreaterThan(html.indexOf('id="vendo-root"'))
  })

  test('a signed-in owner cannot open another owner\'s dashboard', async () => {
    await seedTestUser({ dropboxAccountId: 'dbid:AAATOTHERuser', displayName: 'Other Owner' })
    const response = await page().request('/other-owner', authed(), env)
    expect(response.status).toBe(404)
  })

  test('the page itself fails closed when no session can be verified', async () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner', ownerPage)
    const response = await app.request('/test-owner', { headers: { Cookie: 'manorama_session=garbage' } }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
  })
})

describe('the landing page is the sign-in door', () => {
  const page = () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/', indexPage)
    return app
  }

  test('anonymous visitors get the landing page with the Dropbox button', async () => {
    const response = await page().request('/', undefined, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Continue with Dropbox')
    expect(html).toContain('href="/auth/dropbox"')
  })

  test('a failed sign-in shows the quiet retry note', async () => {
    const response = await page().request('/?error=1', undefined, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Sign-in didn')
    expect(html).toContain('try again')
  })

  test('a signed-in editor is redirected to their dashboard', async () => {
    const response = await page().request('/', authed(), env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/test-owner')
  })
})

describe('public gallery pages stay public', () => {
  test('the viewer page renders without a session and without the Vendo surface', async () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner/:slug', viewerPage)
    const response = await app.request('/test-owner/italy-2018', undefined, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('curtain')
    expect(html).not.toContain('vendo-root')
    expect(html).not.toContain('vendo-client')
  })

  test('a gallery under an unknown owner is a 404', async () => {
    const app = new Hono()
    app.use(honoxContext)
    app.use(renderer)
    mountRoute(app, '/:owner/:slug', viewerPage)
    const response = await app.request('/nobody-here/italy-2018', undefined, env)
    expect(response.status).toBe(404)
  })
})
