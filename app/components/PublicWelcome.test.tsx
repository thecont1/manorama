import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Window } from 'happy-dom'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { render } from 'hono/jsx/dom'
import PublicWelcome from './PublicWelcome'
import renderer from '../routes/_renderer'
import indexPage from '../routes/index'
import { resetUserStore } from '../lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from '../lib/test-fixtures'

const SENTENCE = 'A quieter place to look at photographs, on your own or with anyone.'
const EXPLANATION = 'Sign in to add public Dropbox, Google Drive, iCloud, or MEGA folders and albums.'

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let dom: Window

beforeAll(() => {
  dom = new Window({ url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  globals.window = dom
  globals.document = dom.document
  // hono's JSX renderer checks `instanceof SVGElement` for the provider
  // glyphs — another global happy-dom keeps on the window.
  globals.SVGElement = dom.SVGElement
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
})

describe('PublicWelcome content', () => {
  test('renders the approved sentence as the h1', () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<PublicWelcome />, container)
    expect(container.querySelector('h1')?.textContent).toBe(SENTENCE)
  })

  test('the h1 carries the shared public heading face as scoped style', () => {
    const html = String(PublicWelcome({}))
    expect(html).toMatch(/<h1[^>]*style="[^"]*Bricolage Grotesque/)
    expect(html).toMatch(/font-weight:\s*700/)
  })

  test('renders the provider explanation under the sentence', () => {
    const html = String(PublicWelcome({}))
    expect(html).toContain(EXPLANATION)
  })

  test('shows the wordmark and the .xyz badge', () => {
    const html = String(PublicWelcome({}))
    expect(html).toContain('src="/manorama-merged-logo.png"')
    expect(html).toContain('alt="manorama"')
    expect(html).toContain('aria-hidden="true">.xyz</span>')
  })
})

describe('PublicWelcome sign-in chooser', () => {
  const providerHrefs = (html: string) => [...html.matchAll(/href="(\/auth\/[a-z]+)"/g)].map((match) => match[1]!)

  test('offers Apple, Dropbox, and Google with Apple first', () => {
    const html = String(PublicWelcome({}))
    expect(providerHrefs(html)).toEqual(['/auth/apple', '/auth/dropbox', '/auth/google'])
    expect(html).toContain('aria-label="Continue with Apple"')
    expect(html).toContain('aria-label="Continue with Dropbox"')
    expect(html).toContain('aria-label="Continue with Google Drive"')
  })

  test('uses the returning-visitor wording when returning is set', () => {
    const html = String(PublicWelcome({ returning: true }))
    expect(html).toContain('Sign in with')
    expect(html).toContain('aria-label="Sign in with Apple"')
    expect(html).toContain('aria-label="Sign in with Dropbox"')
    expect(html).toContain('aria-label="Sign in with Google Drive"')
    expect(html).not.toContain('Continue with')
  })
})

describe('PublicWelcome sign-in error handling', () => {
  test('shows the retry note when failed is set', () => {
    const html = String(PublicWelcome({ failed: true }))
    expect(html).toContain('Sign-in didn’t complete. Please try again.')
  })

  test('hides the note by default', () => {
    expect(String(PublicWelcome({}))).not.toContain('Sign-in didn')
  })
})

describe('PublicWelcome footer links', () => {
  test('renders semantic footer links — privacy to the route, author to the site', () => {
    const html = String(PublicWelcome({}))
    expect(html).toContain('<a class="site-footer-link" href="/privacy">Privacy Policy</a>')
    expect(html).toContain('© 2026 Mahesh Shantaram')
    expect(html).toContain('<a href="https://thecontrarian.in">thecontrarian.in</a>')
  })
})

describe('the index route adopts PublicWelcome', () => {
  const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
  let cookie: string
  let ownerSlug: string

  const mountRoute = (app: Hono, path: string, route: unknown) => {
    const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
    if (Array.isArray(route)) get(path, ...(route as Handler[]))
    else get(path, route as Handler)
  }

  const mountIndexRoute = () => {
    const app = new Hono()
    app.use('*', async (c: Context, next: Next) => {
      await contextStorage.run(c, () => next())
    })
    app.use('*', renderer)
    mountRoute(app, '/', indexPage)
    return app
  }

  beforeAll(async () => {
    resetUserStore()
    const user = await seedTestUser()
    ownerSlug = user.ownerSlug
    cookie = await sessionCookieFor(TEST_OWNER.accountId)
  })

  test('the route source renders the shared component, not inline markup', async () => {
    const source = await readFile(new URL('../routes/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../components/PublicWelcome'")
    expect(source).toContain('<PublicWelcome')
    expect(source).not.toContain('landing-brand-intro')
    expect(source).not.toContain('SignInLinks')
  })

  test('anonymous visitors get the approved welcome content', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/', {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(SENTENCE)
    expect(html).toContain(EXPLANATION)
    expect(html).toContain('href="/privacy"')
    // The landing page must stay its own surface — never the interstitial.
    expect(html).not.toContain('data-quickadd')
  })

  test('a failed sign-in shows the quiet retry note', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/?error=1', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Sign-in didn’t complete. Please try again.')
  })

  test('a returning visitor is greeted with the shorter sign-in label', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/', { headers: { Cookie: 'manorama_returning=1' } }, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('Sign in with')
    expect(html).toContain('aria-label="Sign in with Apple"')
  })

  test('a signed-in editor is redirected straight to their dashboard', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/${ownerSlug}`)
  })
})
