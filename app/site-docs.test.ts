import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { createRoute } from 'honox/factory'
import { jsx } from 'hono/jsx/jsx-runtime'
import { raw } from 'hono/html'
import { contextStorage } from 'honox/server/context-storage'
import renderer from './routes/_renderer'
import aboutRoute from './routes/about'
import privacyRoute from './routes/privacy'
import techSpecsRoute from './routes/techspecs'
import termsRoute from './routes/terms'
import DocShell from './components/DocShell'
import { docUpdatedLine } from './lib/site-docs'

/**
 * The public document pages. /about and /techspecs render the repository's
 * README.md and TECH-SPEC.md verbatim — the pages can never drift from the
 * docs they publish — and /terms renders docs/terms-of-service.md. All
 * three share the policy-page shell and the markdown-it pipeline in
 * app/lib/site-docs.ts.
 */

const env = { HOST_API_JWT_SECRET: 'manorama-test-session-secret-min32' }

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

const mountDocRoute = (path: string, route: unknown) => {
  const app = new Hono()
  app.use('*', async (c: Context, next: Next) => {
    await contextStorage.run(c, () => next())
  })
  app.use('*', renderer)
  mountRoute(app, path, route)
  return app
}

const get = async (path: string, route: unknown) => {
  const response = await mountDocRoute(path, route).request(path, {}, env)
  expect(response.status).toBe(200)
  return response.text()
}

/** The site chrome shared by all four document pages: the same header and
 *  footer the homepage carries, with section anchors pointing back at the
 *  homepage where those sections live. */
const expectSiteChrome = (html: string) => {
  expect(html).toContain('class="home-header"')
  expect(html).toContain('href="/#unify"')
  expect(html).toContain('href="/#pricing"')
  expect(html).toContain('href="/#faq"')
  expect(html).toContain('id="content"')
  // The sign-in popover and its trigger ride inside the header.
  expect(html).toContain('id="home-account-panel"')
  expect(html).toContain('home-footer-links')
  // The marketing stylesheet is loaded for the document pages too.
  expect(html).toContain('home.css')
}

describe('/about renders README.md', () => {
  test('the page carries the document, rendered as HTML', async () => {
    const html = await get('/about', aboutRoute)
    expect(html).toContain('<title>About — manorama</title>')
    expectSiteChrome(html)
    expect(html).toContain('<h1>manorama</h1>')
    expect(html).toContain('photography-first')
    // Markdown constructs became elements, not literal markers.
    expect(html).toContain('<h2>')
    expect(html).toContain('<table>')
    expect(html).toContain('<code>')
    expect(html).not.toContain('# manorama')
  })

  test('repo-relative links resolve to GitHub and open in a new tab', async () => {
    const html = await get('/about', aboutRoute)
    // README.md links TECH-SPEC.md relatively — on the site that href
    // would 404, so the renderer anchors it to the repo blob and every
    // document link leaves the tab.
    expect(html).toContain('href="https://github.com/thecont1/manorama/blob/main/TECH-SPEC.md"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })
})

describe('/techspecs renders TECH-SPEC.md', () => {
  test('the page carries the engineering reference', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    expect(html).toContain('<title>Tech Specs — manorama</title>')
    expectSiteChrome(html)
    expect(html).toContain('technical specification')
    expect(html).toContain('<table>')
    // Fenced code blocks render as pre/code, not literal backticks.
    expect(html).toContain('<pre><code')
  })

  test('sections render as FAQ-style disclosures in document order', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    // Every spec heading became a <summary> on the homepage FAQ's card
    // chrome — the headers list one after the other, closed by default.
    expect(html).toContain('<details class="home-faq-item doc-section')
    expect(html).toContain('<summary>Provider ingestion</summary>')
    expect(html).toContain('<summary>Dropbox</summary>')
    expect(html).toContain('<summary>Licensing</summary>')
    const first = html.indexOf('<summary>Stack</summary>')
    const last = html.indexOf('<summary>Known limitations</summary>')
    expect(first).toBeGreaterThan(-1)
    expect(last).toBeGreaterThan(first)
    // The document's own headings no longer render as bare h2/h3 elements.
    expect(html).not.toContain('<h2>')
    // Inline markup in a heading still renders — the quick-add title
    // carries a code span.
    expect(html).toContain('<summary>Quick-add: <code>manorama.xyz/&lt;share-url&gt;</code></summary>')
  })

  test('repo-relative links resolve to GitHub and open in a new tab', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    expect(html).toContain('href="https://github.com/thecont1/manorama/blob/main/README.md"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  test('markup mentioned inside code spans stays escaped', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    // TECH-SPEC names the <video> element inside inline code — it must
    // render as text, never as a live element.
    expect(html).toContain('&lt;video')
    expect(html).not.toContain('<video>')
  })
})

describe('/privacy shares the same site chrome', () => {
  test('the policy document rides inside the header and footer', async () => {
    const html = await get('/privacy', privacyRoute)
    expect(html).toContain('<title>Privacy Policy — manorama</title>')
    expect(html).toContain('<article class="policy-document">')
    expectSiteChrome(html)
  })
})

describe('the updated stamp', () => {
  test('docUpdatedLine renders a human-friendly UTC date-time, no seconds', () => {
    expect(docUpdatedLine('2026-11-22T04:08:50+05:30')).toBe('Updated 21 November 2026, 22:38 UTC')
    expect(docUpdatedLine('2026-01-05T00:00:00.123Z')).toBe('Updated 5 January 2026, 00:00 UTC')
    expect(docUpdatedLine('not a date')).toBe('')
  })

  test('DocShell prints the stamp at the top of the page when provided', async () => {
    const stamped = createRoute((c) => c.render(raw(String(jsx(DocShell, { html: '<h1>Doc</h1>', updated: docUpdatedLine('2026-11-22T04:08:50+05:30') })))))
    const html = await get('/doc', stamped)
    expect(html).toContain('<p class="doc-updated">Updated 21 November 2026, 22:38 UTC</p>')
    expect(html.indexOf('doc-updated')).toBeLessThan(html.indexOf('policy-document'))
  })

  test('DocShell omits the stamp element when the build could not stamp the doc', async () => {
    const unstamped = createRoute((c) => c.render(raw(String(jsx(DocShell, { html: '<h1>Doc</h1>' })))))
    const html = await get('/doc', unstamped)
    expect(html).not.toContain('doc-updated')
  })
})

describe('/terms renders the terms document', () => {
  test('the page carries the terms a payment review looks for', async () => {
    const html = await get('/terms', termsRoute)
    expect(html).toContain('<title>Terms — manorama</title>')
    expectSiteChrome(html)
    expect(html).toContain('<h1>Terms of Service</h1>')
    for (const marker of ['Subscriptions, billing and refunds', 'Visionary', 'Stripe', 'Refunds', 'Limitation of liability']) {
      expect(html).toContain(marker)
    }
  })
})
