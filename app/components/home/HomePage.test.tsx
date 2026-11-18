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

const HEADLINE = 'Your photographic life. One beautiful Library.'
const HEADLINE_HTML =
  '<span class="home-h1-line">Your <em>photographic</em> life.</span>' +
  '<span class="home-h1-line">One beautiful <em>Library</em>.</span>'

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
    expect(html).toContain(`<h1 class="home-h1 home-rise home-rise-1">${HEADLINE_HTML}</h1>`)
  })

  test('leads with what the product does and how to start', () => {
    const html = page()
    expect(html).toContain('Bring your local folders and shared cloud galleries together')
    expect(html).toContain('Start free')
  })
})

describe('the sign-in group', () => {
  const providerHrefs = (html: string) => [...html.matchAll(/href="(\/auth\/[a-z]+)(?:\?[^"]*)?"/g)].map((m) => m[1]!)

  test('offers Apple, Dropbox and Google, with Apple first', () => {
    const html = page()
    expect(providerHrefs(html)).toEqual(['/auth/apple', '/auth/dropbox', '/auth/google'])
    expect(html).toContain('aria-label="Continue with Apple"')
    expect(html).toContain('aria-label="Continue with Dropbox"')
    expect(html).toContain('aria-label="Continue with Google"')
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
    expect(html).not.toContain('aria-label="Continue with')
  })

  test('shows the retry note only after a failed sign-in', () => {
    expect(page({ failed: true })).toContain('Sign-in didn’t complete. Please try again.')
    expect(page()).not.toContain('Sign-in didn')
  })

  test('groups only the three providers without a pitch', () => {
    const html = page()
    const start = html.indexOf('id="home-account-panel"')
    const panel = html.slice(start, html.indexOf('</header>', start))
    expect(panel).toContain('Continue with')
    expect(panel).toContain('home-signin-list')
    expect(panel).not.toContain('Get the app')
    expect(panel).not.toContain('downloads.manorama.xyz')
    expect(panel).not.toContain('The same button creates your account')
    expect(panel).not.toContain('Free includes')
  })
})

describe('the account popover', () => {
  test('one native panel holds the provider links', () => {
    const html = page()
    expect(html.match(/id="home-account-panel"/g)?.length).toBe(1)
    expect(html).toContain('class="home-account-panel" popover')
    expect(html).toContain('popovertarget="home-account-panel"')
    expect(html).not.toContain('<summary>Downloads</summary>')
    expect(html).not.toContain('Start free or sign in')
  })

  test('every Start free button opens the same panel', () => {
    expect(page().match(/>Start free<\/button>/g)?.length).toBe(3)
    expect(page().match(/popovertarget="home-account-panel"/g)?.length).toBe(6)
  })

  test('Go Visionary opens the panel instead of reloading the homepage', () => {
    const html = page()
    expect(html).toContain('popovertargetaction="show">Go Visionary</button>')
    expect(html).not.toContain('href="/?next=/"')
  })

  test('the theme control keeps its icon and gains an accessible label from script', () => {
    const html = page()
    expect(html).toContain('data-theme-toggle')
    expect(html).toContain('home-theme-sun')
    expect(html).toContain('home-theme-moon')
    expect(html).not.toContain('>Light mode</button>')
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

  test('offers the sections and a Downloads hover menu', () => {
    const html = page()
    expect(html).toContain('href="#unify"')
    expect(html).toContain('href="#pricing"')
    expect(html).toContain('href="#faq"')
    expect(html).toContain('class="home-downloads"')
    expect(html).toContain('class="home-downloads-trigger" href="https://downloads.manorama.xyz/"')
    expect(html).toContain('>Downloads</a>')
    // Downloads leads the desktop nav, ahead of the section anchors.
    const nav = html.slice(html.indexOf('<nav class="home-nav"'), html.indexOf('</nav>'))
    expect(nav.indexOf('home-downloads"')).toBeLessThan(nav.indexOf('href="#unify"'))
  })

  test('has a skip link and one h1', () => {
    const html = page()
    expect(html).toContain('Skip to content')
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1)
  })
})

describe('the homepage story', () => {
  test('uses the approved Library, steps and feature copy', () => {
    const html = page()
    expect(html).toContain('A friend&#39;s shared Google Drive album.')
    expect(html).toContain('Supported cloud drives')
    expect(html).toContain('Every gallery, hanging together.')
    expect(html).toContain('Paste a share link, or choose a folder on your computer.')
    expect(html).toContain('Name it, arrange it, keep it in your Library.')
    expect(html).toContain('Send anyone a clean link. They can look without signing in.')
    expect(html).toContain('Made for looking.')
    expect(html).toContain('The originals stay where they are.')
    expect(html).toContain('Take it with you.')
  })
})

describe('the Library loop', () => {
  test('carries the four appearances in the order the loop walks them', () => {
    const html = page()
    const layers = [...html.matchAll(/data-library-layer="(\d)"/g)].map((m) => m[1]!)
    const captions = [...html.matchAll(/data-library-caption="(\d)"/g)].map((m) => m[1]!)
    expect(layers).toEqual(['0', '1', '2', '3'])
    expect(captions).toEqual(['0', '1', '2', '3'])
    for (const src of ['lib-dark', 'lib-quiet-dark', 'lib-quiet-light', 'lib-light']) {
      expect(html).toContain(`/home/${src}.jpg`)
      expect(html).toContain(`/home/${src}.avif`)
      expect(html).toContain(`/home/${src}-sm.webp`)
    }
  })

  test('holds its first state on the server, so the band is whole without scripting', () => {
    const html = page()
    expect(html).toContain('data-library-loop')
    expect(html).toContain('data-state="0"')
    // Only the first layer and the first caption are exposed; the rest are
    // marked hidden, so a reader is given one state at a time.
    expect(html).toContain('data-library-layer="0" aria-hidden="false"')
    expect(html).toContain('data-library-caption="0" aria-hidden="false"')
    expect(html).toContain('data-library-layer="1" aria-hidden="true"')
    expect(html).toContain('data-library-caption="3" aria-hidden="true"')
  })

  test('names each state and says what it is for', () => {
    const html = page()
    expect(html).toContain('Dark mode')
    expect(html).toContain('Quiet and Dark mode')
    expect(html).toContain('Quiet and Light mode')
    expect(html).toContain('Light mode')
    expect(html).toContain('Every control, lit.')
    expect(html).toContain('The interface steps back.')
    expect(html).toContain('Quiet, in daylight too.')
    expect(html).toContain('The same Library. Different light.')
  })

  test('keeps the pause control out of the way until the script takes over', () => {
    const html = page()
    expect(html).toContain('data-library-pause')
    expect(html).toMatch(/data-library-pause[^>]*hidden/)
  })

  test('never stretches the capture: the frame holds its own ratio', () => {
    const html = page()
    expect(html).toContain('width="2688"')
    expect(html).toContain('height="1687"')
    expect(html).toContain('class="home-library-stage"')
  })
})

describe('the pricing section', () => {
  test('states the approved prices', () => {
    const html = page()
    expect(html).toContain('$12')
    expect(html).toContain('$20')
    expect(html).toContain('for your first year')
    expect(html).toContain('free forever.')
    expect(html).toContain('home-plan-name">Free<')
  })

  test('states the limits the policy actually enforces', () => {
    const html = page()
    expect(html).toContain(`${FREE_RETAINED_LIMIT} permanent cloud galleries`)
    expect(html).toContain(`${PAID_RETAINED_LIMIT} permanent cloud galleries`)
    expect(html).toContain(`${FREE_PIPELINE_LIMIT} temporary cloud galleries`)
    expect(html).toContain('30 days')
  })

  test('compares the two plans in a table with scopes', () => {
    const html = page()
    expect(html).toContain('<table class="home-table">')
    expect(html).toContain('scope="col"')
    expect(html).toContain('scope="row"')
  })

  test('states the approved comparison and shared features', () => {
    const html = page()
    expect(html).toContain('Offline copies on iPhone and iPad')
    expect(html).toContain('Choose a larger allowance')
    expect(html).toContain('Browse everything you&#39;ve saved on iPhone and iPad')
    expect(html).toContain('This gallery')
    expect(html).toContain('All saved galleries')
    expect(html).toContain('Included with both')
    expect(html).toContain('The same viewing')
    expect(html).toContain('Editing your permanent galleries')
  })

  test('carries the approved qualification and renewal notes', () => {
    const html = page()
    expect(html).toContain('Good to know')
    expect(html).toContain('Permanent galleries stay as long as their source link works.')
    expect(html).toContain('Manorama is not a backup service.')
    expect(html).toContain('Deleting a gallery from Manorama never deletes the photographs at the source.')
    expect(html).toContain('Visionary renews yearly. Subscribe on the web or in the iPhone and iPad app.')
  })

  test('every comparison cell says something', () => {
    const html = page()
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!)
    expect(rows.length).toBeGreaterThan(4)
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

describe('the footer', () => {
  test('carries the logo-led copyright, ownership notice and document links', () => {
    const html = page()
    expect(html).toContain('© 2026 Mahesh Shantaram / <a href="https://thecontrarian.in"')
    expect(html).toContain('>thecontrarian.in</a>')
    expect(html).toContain('home-footer-ownership">Photographs in galleries belong to their respective owners.</span>')
    expect(html).toContain('home-footer-brand')
    expect(html).toContain('alt="manorama"')
    // The document links sit in order on the footer's first line.
    const linksStart = html.indexOf('home-footer-links')
    const footerLinks = html.slice(linksStart, html.indexOf('</nav>', linksStart))
    const order = ['/privacy', '/about', '/techspecs', '/terms'].map((href) => footerLinks.indexOf(`href="${href}"`))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html.match(/home-footer[\s\S]*downloads\.manorama\.xyz/)).toBeNull()
  })

  test('carries no separate credit line', () => {
    const html = page()
    const footer = html.slice(html.indexOf('<footer'))
    expect(footer).not.toContain('Created by documentary photographer')
    expect(footer).not.toContain('All platform rights reserved')
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

  test('the Downloads menu lists the web app, every shipped shortcut, and itself', () => {
    const html = page()
    const start = html.indexOf('home-downloads-panel')
    const panel = html.slice(start, html.indexOf('</ul>', start))
    expect(panel).toContain('href="https://manorama.xyz/"')
    expect(panel).toContain('>Web app</span>')
    for (const path of ['/mac', '/windows', '/linux', '/android']) {
      expect(panel).toContain(`href="https://downloads.manorama.xyz${path}"`)
    }
    expect(panel).toContain('href="https://downloads.manorama.xyz/"')
    expect(panel).toContain('>Downloads page</span>')
    // iOS has no published URL — listed quiet, never a dead link.
    expect(panel).toContain('home-downloads-soon')
    expect(panel).toContain('iPhone &amp; iPad')
    expect(panel).not.toContain('href="https://downloads.manorama.xyz/ios"')
  })

  test('the sample gallery is linked when the manifest holds one', () => {
    expect(page()).toContain('href="/thecontrarian/italy"')
    expect(page()).toContain('View a sample gallery')
    // The gallery opens in its own tab so the landing page stays put.
    expect(page()).toContain('href="/thecontrarian/italy" target="_blank" rel="noopener"')
  })

  test('the sample gallery link disappears when the manifest path is unset', () => {
    const html = page({ samplePath: null })
    expect(html).not.toContain('View a sample gallery')
    expect(html).not.toContain('/thecontrarian/italy')
  })

  test('the static hero centres its sample link and carries no reassurance note', () => {
    const html = page()
    expect(html).toContain('<p class="home-hero-cta home-rise home-rise-3">')
    expect(html).not.toContain('No account needed to look.')
    expect(html).not.toContain('home-hero-cta-note')
    expect(html).not.toContain('home-hero-after')
  })
})

describe('the copy makes no promise the product does not keep', () => {
  // The one approved sentence that names a forbidden word: it says manorama
  // is not a backup, which is the opposite of a backup claim.
  const APPROVED = 'Manorama is not a backup service.'

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
      expect(pattern.test(text)).toBe(false)
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
    await seedTestUser()
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
    expect(
      html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1'),
    ).toContain(HEADLINE)
    expect(html).toContain('class="home"')
    expect(html).toContain('href="/privacy"')
    // The homepage is its own surface: never the quick-add interstitial.
    expect(html).not.toContain('data-quickadd')
  })

  test('the demo SSR renders its static first state with the chrome scripts', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/', {}, env)).text()
    expect(html).toContain('src="/theme-init.js"')
    expect(html).toContain('src="/home-theme.js"')
    expect(html).toContain('src="/home-menu.js"')
    expect(html).toContain('src="/home-hero.js"')
    expect(html).toContain('src="/home-library.js"')
    expect(html.match(/<script/g)).toHaveLength(5)
    expect(html).toContain('data-demo-stage')
    expect(html).toContain('data-demo-ready="false"')
    expect(html).toContain('/home-demo/')
  })

  test('the demo carries the sample link in its control bar, not below the hero', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/', {}, env)).text()
    const bar = html.indexOf('home-demo-bar')
    const controls = html.indexOf('data-demo-controls')
    const sample = html.indexOf('class="home-demo-sample" href="/thecontrarian/italy" target="_blank" rel="noopener"')
    expect(bar).toBeGreaterThan(-1)
    expect(controls).toBeGreaterThan(bar)
    expect(sample).toBeGreaterThan(controls)
    expect(html).not.toContain('home-hero-cta')
    expect(html).not.toContain('No account needed to look.')
  })

  test('the Worker off switch restores the static hero without the island', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/', {}, { ...env, MANORAMA_HOME_DEMO: 'off' })).text()
    expect(html.match(/<script/g)).toHaveLength(5)
    expect(html).not.toContain('has-island')
    expect(html).not.toContain('data-demo-stage')
    expect(html).not.toContain('/home-demo/')
    expect(html).toContain('home-hero-cta')
    expect(html).toContain('href="/thecontrarian/italy"')
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

  test('a signed-in editor still gets the homepage — sign-in lives on its own host', async () => {
    const app = mountIndexRoute()
    const response = await app.request('/', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('class="home"')
    expect(html).toContain(HEADLINE_HTML)
  })

  test('the next parameter is sanitised exactly as before', async () => {
    const app = mountIndexRoute()
    const html = await (await app.request('/?next=https://evil.example', {}, env)).text()
    expect(html).not.toContain('evil.example')
    const kept = await (await app.request('/?next=%2Fthecontrarian%2Fitaly', {}, env)).text()
    expect(kept).toContain('next=%2Fthecontrarian%2Fitaly')
  })
})
