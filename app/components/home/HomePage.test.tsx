import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Window } from 'happy-dom'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import HomePage from './HomePage'
import renderer from '../../routes/_renderer'
import indexPage from '../../routes/index'
import { resetUserStore } from '../../lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from '../../lib/test-fixtures'
import {
  FREE_PIPELINE_LIMIT,
  FREE_RETAINED_LIMIT,
  PAID_RETAINED_LIMIT,
} from '../../lib/gallery-policy'

const HEADLINE = 'Your photographs. Different places. One beautiful view.'

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
  // glyphs: another global happy-dom keeps on the window.
  globals.SVGElement = dom.SVGElement
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
})

const page = (props: Parameters<typeof HomePage>[0] = {}) => String(HomePage(props))

describe('the homepage headline', () => {
  test('renders the approved headline as the one h1', () => {
    const html = page()
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1)
    expect(html).toContain(`<h1 class="home-h1 home-rise home-rise-1">${HEADLINE}</h1>`)
  })

  test('leads with what the product does and how to start', () => {
    const html = page()
    expect(html).toContain('Bring your local folders and supported cloud galleries together')
    expect(html).toContain('Start free or sign in')
  })
})

describe('the sign-in group', () => {
  const providerHrefs = (html: string) => [...html.matchAll(/href="(\/auth\/[a-z]+)(?:\?[^"]*)?"/g)].map((m) => m[1]!)

  test('offers Apple, Dropbox and Google, with Apple first', () => {
    const html = page()
    expect(providerHrefs(html)).toEqual(['/auth/apple', '/auth/dropbox', '/auth/google'])
    expect(html).toContain('aria-label="Continue with Apple"')
    expect(html).toContain('aria-label="Continue with Dropbox"')
    expect(html).toContain('aria-label="Continue with Google Drive"')
  })

  test('keeps the return path through the sign-in links', () => {
    const html = page({ next: '/thecontrarian/italy' })
    expect(html).toContain('href="/auth/apple?next=%2Fthecontrarian%2Fitaly"')
    expect(html).toContain('href="/auth/dropbox?next=%2Fthecontrarian%2Fitaly"')
    expect(html).toContain('href="/auth/google?next=%2Fthecontrarian%2Fitaly"')
  })

  test('uses the returning-visitor wording when the cookie is set', () => {
    const html = page({ returning: true })
    expect(html).toContain('Sign in with')
    expect(html).toContain('aria-label="Sign in with Apple"')
    expect(html).not.toContain('Continue with')
  })

  test('shows the retry note only after a failed sign-in', () => {
    expect(page({ failed: true })).toContain('Sign-in didn’t complete. Please try again.')
    expect(page()).not.toContain('Sign-in didn')
  })

  test('says that the same sign-in creates the account', () => {
    expect(page()).toContain('The same sign-in creates your account or welcomes you back.')
  })
})

describe('the navigation', () => {
  test('every anchor points at an id that exists on the page', () => {
    const html = page()
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!))
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!)
    expect(targets.length).toBeGreaterThan(4)
    for (const target of targets) expect(ids.has(target)).toBe(true)
  })

  test('offers the four sections a visitor looks for', () => {
    const html = page()
    expect(html).toContain('href="#how-it-works"')
    expect(html).toContain('href="#features"')
    expect(html).toContain('href="#pricing"')
    expect(html).toContain('href="#get-manorama"')
  })

  test('has a skip link and one h1', () => {
    const html = page()
    expect(html).toContain('Skip to content')
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1)
  })
})

describe('the pricing section', () => {
  test('states the approved prices', () => {
    const html = page()
    expect(html).toContain('$12')
    expect(html).toContain('$20')
    expect(html).toContain('for your first year')
  })

  test('states the limits the policy actually enforces', () => {
    const html = page()
    expect(html).toContain(`${FREE_RETAINED_LIMIT} permanent cloud galleries`)
    expect(html).toContain(`${PAID_RETAINED_LIMIT} permanent cloud galleries`)
    expect(html).toContain(`${FREE_PIPELINE_LIMIT} temporary galleries at a time`)
    expect(html).toContain('30 days')
  })

  test('compares the two plans in a table with a caption and scopes', () => {
    const html = page()
    expect(html).toContain('<table class="home-table">')
    expect(html).toContain('<caption>')
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="row"')
  })

  test('every comparison cell says something', () => {
    const html = page()
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!)
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1]!)
      for (const cell of cells) {
        const text = cell.replace(/<[^>]*>/g, '').trim()
        expect(text.length).toBeGreaterThan(0)
        expect(text).not.toBe('All features')
      }
    }
  })
})

describe('the surfaces and the sample gallery', () => {
  test('a surface with no published URL renders no link', () => {
    const html = page()
    // The app stores are not published yet: the page must not carry a link
    // that goes nowhere.
    expect(html).not.toContain('href="https://apps.apple.com')
    expect(html).not.toContain('href="https://microsoft.com')
    expect(html).not.toContain('URL missing')
  })

  test('the sample gallery is linked when the manifest holds one', () => {
    expect(page()).toContain('href="/thecontrarian/italy"')
    expect(page()).toContain('View a sample gallery')
  })

  test('the sample gallery link disappears when the manifest path is unset', () => {
    const html = page({ samplePath: null })
    expect(html).not.toContain('View a sample gallery')
    expect(html).not.toContain('/thecontrarian/italy')
  })
})

describe('the copy makes no promise the product does not keep', () => {
  // The one approved sentence that names a forbidden word: it says manorama
  // is not a backup, which is the opposite of a backup claim.
  const APPROVED = 'Manorama is not photo backup or cloud storage.'

  const FORBIDDEN: [RegExp, string][] = [
    [/AI-powered/i, 'AI-powered'],
    [/unlimited storage/i, 'unlimited storage'],
    [/ad-free/i, 'ad-free'],
    [/\bPro\b/, 'Pro'],
    [/private gallery/i, 'private gallery'],
    [/\bmonthly\b/i, 'monthly'],
    [/\blifetime\b/i, 'lifetime'],
    [/\btrial\b/i, 'trial'],
    [/₹/, '₹'],
  ]

  test('the visible copy carries none of the forbidden claims', () => {
    const text = page()
      .replace(APPROVED, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
    for (const [pattern, label] of FORBIDDEN) {
      expect(text.includes(label) && pattern.test(text)).toBe(false)
    }
  })

  test('the page never says it stores the photographs', () => {
    const text = page().replace(/<[^>]*>/g, ' ')
    expect(text).not.toMatch(/\bwe store your (photographs|photos)\b/i)
  })
})

describe('the index route renders the homepage', () => {
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

  test('the route renders the homepage component, not inline markup', async () => {
    const source = await readFile(new URL('../../routes/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../components/home/HomePage'")
    expect(source).toContain('<HomePage')
    expect(source).not.toContain('landing-brand-intro')
    expect(source).not.toContain('SignInLinks')
  })

  test('anonymous visitors get the homepage', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/', {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(HEADLINE)
    expect(html).toContain('class="home"')
    expect(html).toContain('href="/privacy"')
    // The homepage is its own surface: never the quick-add interstitial.
    expect(html).not.toContain('data-quickadd')
  })

  test('the page carries no island and no client script of its own', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/', {}, env)).text()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('has-island')
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

  test('the next parameter is sanitised exactly as before', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/?next=https://evil.example', {}, env)).text()
    expect(html).not.toContain('evil.example')
    const kept = await (await app.request('/?next=%2Fthecontrarian%2Fitaly', {}, env)).text()
    expect(kept).toContain('next=%2Fthecontrarian%2Fitaly')
  })
})
