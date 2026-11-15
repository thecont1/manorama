import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import {
  appOriginOf,
  isSigninHost,
  sessionCookieDomain,
  signinHostGate,
  signinHostOf,
  signinOriginOf,
} from './lib/signin-host'
import renderer from './routes/_renderer'
import indexPage from './routes/index'
import dropboxStartRoute from './routes/auth/dropbox'
import { POST as logoutPost } from './routes/auth/logout'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_SESSION_SECRET } from './lib/test-fixtures'

/**
 * The dedicated sign-in host. `SIGNIN_HOST` is what turns the feature
 * on: with it set, the gate serves the chooser and the /auth surface on
 * signin.manorama.xyz, redirects every other subdomain path back to the
 * app host, and bounces apex /auth/* requests here. Without it — dev,
 * staging, most tests — nothing changes.
 */

const APEX = 'https://manorama.xyz'
const SIGNIN = 'https://signin.manorama.xyz'

const env = {
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  SIGNIN_HOST: 'signin.manorama.xyz',
  PUBLIC_HOST: 'manorama.xyz',
  DROPBOX_APP_KEY: 'test-key',
  DROPBOX_APP_SECRET: 'test-secret',
}

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

const mountPost = (app: Hono, path: string, route: unknown) => {
  const post = app.post.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) post(path, ...(route as Handler[]))
  else post(path, route as Handler)
}

/** The same middleware order server.ts wires: the host gate sits in
 *  front of every route, inert unless SIGNIN_HOST is configured. */
const gated = (bindings: Record<string, unknown> = env) => {
  const app = new Hono()
  app.use('*', honoxContext)
  app.use('*', signinHostGate())
  app.use('*', renderer)
  mountRoute(app, '/', indexPage)
  app.get('/auth/dropbox', ...dropboxStartRoute)
  mountPost(app, '/auth/logout', logoutPost)
  return { app, bindings }
}

const req = (app: Hono, bindings: Record<string, unknown>, url: string, init?: RequestInit) =>
  app.request(url, init, bindings)

let cookie: string

beforeAll(async () => {
  resetUserStore()
  const user = await seedTestUser()
  cookie = await sessionCookieFor(user.accountId)
})

describe('the host helpers', () => {
  test('the feature is off without SIGNIN_HOST', () => {
    expect(signinHostOf({})).toBeUndefined()
    expect(signinHostOf({ SIGNIN_HOST: '  ' })).toBeUndefined()
    expect(signinOriginOf({})).toBeUndefined()
    expect(sessionCookieDomain({})).toBeUndefined()
    expect(isSigninHost('signin.manorama.xyz', {})).toBe(false)
  })

  test('reads the configured host and derives the shared origins', () => {
    expect(signinHostOf(env)).toBe('signin.manorama.xyz')
    expect(signinOriginOf(env)).toBe(SIGNIN)
    expect(appOriginOf(env)).toBe(APEX)
    expect(sessionCookieDomain(env)).toBe('manorama.xyz')
    expect(isSigninHost('signin.manorama.xyz', env)).toBe(true)
    expect(isSigninHost('SIGNIN.MANORAMA.XYZ', env)).toBe(true)
    expect(isSigninHost('manorama.xyz', env)).toBe(false)
    expect(isSigninHost('downloads.manorama.xyz', env)).toBe(false)
  })

  test('the cookie domain falls back to the apex implied by the host', () => {
    expect(sessionCookieDomain({ SIGNIN_HOST: 'signin.example.com' })).toBe('example.com')
    expect(appOriginOf({})).toBe('https://manorama.xyz')
  })
})

describe('the apex side of the gate', () => {
  test('legacy /auth/* URLs redirect to the sign-in host with path and query intact', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${APEX}/auth/dropbox?next=%2Fthecontrarian%2Fitaly&native=1`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${SIGNIN}/auth/dropbox?next=%2Fthecontrarian%2Fitaly&native=1`)
  })

  test('a POST keeps its method and body through the redirect', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${APEX}/auth/confirm-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=abc',
    })
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(`${SIGNIN}/auth/confirm-account`)
  })

  test('/auth/logout stays on the apex so sign-out lands on the homepage', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${APEX}/auth/logout`, { method: 'POST' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    // The delete carries the shared Domain or the apex cookie survives.
    expect(response.headers.get('set-cookie')).toContain('manorama_session=')
    expect(response.headers.get('set-cookie')).toContain('Domain=manorama.xyz')
  })

  test('the homepage and every other apex path pass straight through', async () => {
    const { app, bindings } = gated()
    const home = await req(app, bindings, `${APEX}/`)
    expect(home.status).toBe(200)
    const gallery = await req(app, bindings, `${APEX}/thecontrarian/italy`)
    // No gallery route is mounted here — a 404 proves the request reached
    // routing instead of being bounced to the sign-in host.
    expect(gallery.status).toBe(404)
  })

  test('with no SIGNIN_HOST the gate is inert', async () => {
    const { app } = gated()
    const response = await app.request(`${APEX}/auth/dropbox`, undefined, {
      HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
      DROPBOX_APP_KEY: 'test-key',
      DROPBOX_APP_SECRET: 'test-secret',
    })
    // Reaches the real route: a redirect to Dropbox, not to the subdomain.
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get('location')!).origin).toBe('https://www.dropbox.com')
  })
})

describe('the sign-in host side of the gate', () => {
  test('/ serves the chooser with the three providers and noindex', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('name="robots" content="noindex"')
    expect(html).toContain('href="/auth/apple"')
    expect(html).toContain('href="/auth/dropbox"')
    expect(html).toContain('href="/auth/google"')
    // Apple leads the row — App Review 4.8 ordering, same as every door.
    expect(html.indexOf('/auth/apple')).toBeLessThan(html.indexOf('/auth/dropbox'))
    expect(html.indexOf('/auth/dropbox')).toBeLessThan(html.indexOf('/auth/google'))
    expect(html).toContain(`src="${APEX}/manorama-merged-logo.png"`)
    expect(html).toContain(`href="${APEX}/"`)
  })

  test('the chooser carries ?error=1 as the retry note and ?next= through the links', async () => {
    const { app, bindings } = gated()
    const failed = await req(app, bindings, `${SIGNIN}/?error=1`)
    expect(await failed.text()).toContain('Sign-in didn&rsquo;t complete. Please try again.')

    const withNext = await req(app, bindings, `${SIGNIN}/?next=%2Fthecontrarian%2Fitaly`)
    const html = await withNext.text()
    expect(html).toContain('href="/auth/apple?next=%2Fthecontrarian%2Fitaly"')
    expect(html).toContain('href="/auth/google?next=%2Fthecontrarian%2Fitaly"')
  })

  test('a foreign ?next= is dropped at the door', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/?next=https%3A%2F%2Fevil.example`)
    const html = await response.text()
    expect(html).not.toContain('evil.example')
    expect(html).toContain('href="/auth/apple"')
  })

  test('a signed-in visitor gets the continue link and a sign-out, not the providers', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('You&rsquo;re signed in')
    expect(html).toContain('Signed in as Test Owner.')
    expect(html).toContain(`href="${APEX}/test-owner"`)
    expect(html).toContain('action="/auth/logout"')
    expect(html).not.toContain('href="/auth/apple"')
  })

  test('a signed-in visitor with ?next= continues to that path on the app host', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/?next=%2Fthecontrarian%2Fitaly`, { headers: { Cookie: cookie } })
    const html = await response.text()
    expect(html).toContain(`href="${APEX}/thecontrarian/italy"`)
    expect(html).toContain('>Continue</a>')
  })

  test('every non-auth path redirects to the app host with query intact', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/thecontrarian/italy?photo=img-1`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${APEX}/thecontrarian/italy?photo=img-1`)
    const post = await req(app, bindings, `${SIGNIN}/api/galleries`, { method: 'POST', body: '{}' })
    expect(post.status).toBe(307)
    expect(post.headers.get('location')).toBe(`${APEX}/api/galleries`)
  })

  test('/auth/* reaches the real routes — Dropbox start builds the subdomain callback', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${SIGNIN}/auth/dropbox`)
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(`${location.origin}${location.pathname}`).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe(`${SIGNIN}/auth/dropbox/callback`)
  })
})

describe('the homepage links out to the sign-in host', () => {
  test('provider links are absolute when SIGNIN_HOST is configured', async () => {
    const { app, bindings } = gated()
    const response = await req(app, bindings, `${APEX}/`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(`href="${SIGNIN}/auth/apple"`)
    expect(html).toContain(`href="${SIGNIN}/auth/dropbox"`)
    expect(html).toContain(`href="${SIGNIN}/auth/google"`)
  })

  test('the return path rides the absolute links too', async () => {
    const { app, bindings } = gated()
    const html = await (await req(app, bindings, `${APEX}/?next=%2Fthecontrarian%2Fitaly`)).text()
    expect(html).toContain(`href="${SIGNIN}/auth/apple?next=%2Fthecontrarian%2Fitaly"`)
    expect(html).toContain(`href="${SIGNIN}/auth/google?next=%2Fthecontrarian%2Fitaly"`)
  })
})
