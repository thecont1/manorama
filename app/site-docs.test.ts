import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import renderer from './routes/_renderer'
import aboutRoute from './routes/about'
import techSpecsRoute from './routes/techspecs'
import termsRoute from './routes/terms'

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

describe('/about renders README.md', () => {
  test('the page carries the document, rendered as HTML', async () => {
    const html = await get('/about', aboutRoute)
    expect(html).toContain('<title>About — manorama</title>')
    expect(html).toContain('<h1>manorama</h1>')
    expect(html).toContain('photography-first')
    // Markdown constructs became elements, not literal markers.
    expect(html).toContain('<h2>')
    expect(html).toContain('<table>')
    expect(html).toContain('<code>')
    expect(html).not.toContain('# manorama')
  })
})

describe('/techspecs renders TECH-SPEC.md', () => {
  test('the page carries the engineering reference', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    expect(html).toContain('<title>Tech Specs — manorama</title>')
    expect(html).toContain('technical specification')
    expect(html).toContain('<h2>')
    expect(html).toContain('<table>')
    // Fenced code blocks render as pre/code, not literal backticks.
    expect(html).toContain('<pre><code')
  })

  test('markup mentioned inside code spans stays escaped', async () => {
    const html = await get('/techspecs', techSpecsRoute)
    // TECH-SPEC names the <video> element inside inline code — it must
    // render as text, never as a live element.
    expect(html).toContain('&lt;video')
    expect(html).not.toContain('<video>')
  })
})

describe('/terms renders the terms document', () => {
  test('the page carries the terms a payment review looks for', async () => {
    const html = await get('/terms', termsRoute)
    expect(html).toContain('<title>Terms — manorama</title>')
    expect(html).toContain('<h1>Terms of Service</h1>')
    for (const marker of ['Subscriptions, billing and refunds', 'Visionary', 'Stripe', 'Refunds', 'Limitation of liability']) {
      expect(html).toContain(marker)
    }
  })
})
