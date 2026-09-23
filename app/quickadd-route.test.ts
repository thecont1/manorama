import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import renderer from './routes/_renderer'
import quickAddRoute from './routes/[...src]'
import ownerPage from './routes/[owner]'
import viewerPage from './routes/[owner]/[slug]'
import indexPage from './routes/index'
import { resetUserStore } from './lib/user-repository'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

/**
 * The quick-add catch-all is the single most dangerous route in the app:
 * it matches every path. These tests pin the contract that keeps it safe
 * — it renders ONLY for provider-shaped paths and delegates everything
 * else, in the same registration order honox uses (catch-all first).
 */

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
let cookie: string
let ownerSlug: string

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

/** Registers the catch-all ahead of the concrete routes — the worst case
 *  for ordering, and the one honox actually produces. */
const buildApp = () => {
  const app = new Hono()
  app.use('*', honoxContext)
  app.use('*', renderer)
  mountRoute(app, '/:src{.+}', quickAddRoute)
  mountRoute(app, '/', indexPage)
  mountRoute(app, '/:owner', ownerPage)
  mountRoute(app, '/:owner/:slug', viewerPage)
  return app
}

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  const user = await seedTestUser()
  ownerSlug = user.ownerSlug
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'kashmir',
    title: 'Kashmir',
    caption: '',
    date: '',
    images: [{ id: 'k-1', filename: 'k-1.jpg', src: '/images/k-1.jpg', width: 1200, height: 800, alt: 'a photograph', c2pa: false, placeholder: '' }],
  })
})

describe('the quick-add catch-all delegates every non-provider path', () => {
  test('a gallery page still renders through the catch-all', async () => {
    const app = buildApp()
    const response = await app.request(`/${ownerSlug}/kashmir`, {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Kashmir')
    // The interstitial must not have hijacked it.
    expect(html).not.toContain('data-quickadd')
  })

  test('the dashboard route is reached, not swallowed', async () => {
    const app = buildApp()
    const response = await app.request(`/${ownerSlug}`, { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('data-quickadd')
  })

  test('an anonymous dashboard request still redirects rather than showing quick-add', async () => {
    const app = buildApp()
    const response = await app.request(`/${ownerSlug}`, {}, env)
    expect(response.status).toBe(302)
  })

  test('the landing page is untouched', async () => {
    const app = buildApp()
    const response = await app.request('/', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('data-quickadd')
  })

  test('an unknown slug still 404s instead of rendering the interstitial', async () => {
    const app = buildApp()
    const response = await app.request('/no-such-owner', {}, env)
    expect(response.status).toBe(404)
  })
})

describe('the quick-add catch-all renders for provider links', () => {
  const providerPaths = [
    ['dropbox', '/https://www.dropbox.com/scl/fo/abc/xyz'],
    ['gdrive', '/https://drive.google.com/drive/folders/1AbCdEf'],
    ['icloud', '/https://www.icloud.com/sharedalbum/'],
    ['mega', '/https://mega.nz/folder/AbCdEf12'],
  ] as const

  for (const [provider, path] of providerPaths) {
    test(`${provider} links render the interstitial with a 200`, async () => {
      const app = buildApp()
      const response = await app.request(path, {}, env)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('data-quickadd')
      expect(html).toContain(`data-provider="${provider}"`)
    })
  }

  test('a query-carrying Drive folder link renders — the ID lives in the query', async () => {
    // `drive.google.com/open?id=…` puts the entire share in the query
    // string. Detection that reads only c.req.path would drop the ID, fail
    // the share-resource check and 404 a perfectly valid folder link.
    const app = buildApp()
    for (const path of [
      '/https://drive.google.com/open?id=1AbCdEf',
      '/https://drive.google.com/open?id=1AbCdEf&usp=sharing',
      '/https://drive.google.com/drive/u/2/folders/1AbCdEf?usp=sharing',
      '/https://www.dropbox.com/scl/fo/abc/xyz?rlkey=k&dl=0',
    ]) {
      const response = await app.request(path, {}, env)
      const html = await response.text()
      // No message arg — this suite's expect typing takes only one.
      expect(response.status).toBe(200)
      expect(`${path} → ${html.includes('data-quickadd')}`).toBe(`${path} → true`)
    }
  })

  test('a logged-out visitor gets the sign-in panel', async () => {
    const app = buildApp()
    const response = await app.request('/https://mega.nz/folder/AbCdEf12', {}, env)
    const html = await response.text()
    expect(html).toContain('data-mode="signin"')
    expect(html).toContain('Sign Up or Sign In with Dropbox')
  })

  test('a signed-in visitor gets the working panel — zero clicks', async () => {
    const app = buildApp()
    const response = await app.request('/https://mega.nz/folder/AbCdEf12', { headers: { Cookie: cookie } }, env)
    const html = await response.text()
    expect(html).toContain('data-mode="create"')
    expect(html).toContain('data-panel="working"')
  })

  test('the interstitial is never indexed or cached', async () => {
    const app = buildApp()
    const response = await app.request('/https://mega.nz/folder/AbCdEf12', {}, env)
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })

  test('the collapsed-scheme spelling a browser produces also renders', async () => {
    const app = buildApp()
    const response = await app.request('/https:/mega.nz/folder/AbCdEf12', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data-quickadd')
  })

  test('the page always ships its client script — no island gate', async () => {
    // Regression: honox's <Script> wraps the tag in <HasIslands> in prod,
    // which emits nothing on a page with no islands — the interstitial sat
    // on "Manorama-fying…" forever because the client never loaded. The tag
    // must be unconditional.
    const app = buildApp()
    for (const init of [{}, { headers: { Cookie: cookie } }]) {
      const response = await app.request('/https://mega.nz/folder/AbCdEf12', init, env)
      const html = await response.text()
      expect(html.includes('<script') && html.includes('quickadd')).toBe(true)
    }
  })
})
