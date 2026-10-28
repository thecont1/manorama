import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Window } from 'happy-dom'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { render } from 'hono/jsx/dom'
import PrivacyPolicy from './PrivacyPolicy'
import { PRIVACY_POLICY } from '../../packages/core/privacy-policy'
import type { PrivacyDocument, PrivacyInline } from '../../packages/core/privacy-policy'
import renderer from '../routes/_renderer'
import privacyRoute from '../routes/privacy'

/** Extract the readable text and destinations of a rendered or JSX policy
 *  document: paragraphs in order, headings in order, and every href. Tags are
 *  stripped before entities are decoded so `<provider-url>` inside a code
 *  span cannot be mistaken for markup. */
const plainText = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\s+/g, ' ')
    .trim()

const extractDocument = (markup: string) => {
  const paragraphs = [...markup.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((match) => plainText(match[1]!))
  const headings = [...markup.matchAll(/<h([123])[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => plainText(match[2]!))
  const hrefs = [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!)
  return { paragraphs, headings, hrefs }
}

/** The model is the source of truth: derive the exact document the shared
 *  renderer must output — the updated line, the lede, then every section
 *  heading and paragraph in order, and every external destination. */
const expectedFromModel = (doc: PrivacyDocument) => {
  const paragraphs: string[] = [`Last updated: ${doc.updated}`, doc.lede]
  const headings: string[] = [doc.title]
  const hrefs: string[] = []
  const pushParts = (parts: PrivacyInline[]) => {
    let text = ''
    for (const part of parts) {
      if (part.kind === 'link') {
        hrefs.push(part.href)
        text += part.label
      } else {
        text += part.text
      }
    }
    return text
  }
  for (const section of doc.sections) {
    headings.push(section.heading)
    if (section.personas && section.cards) {
      for (const card of section.cards) {
        headings.push(card.heading)
        paragraphs.push(pushParts(card.paragraph.parts))
      }
    } else {
      for (const paragraph of section.paragraphs ?? []) paragraphs.push(pushParts(paragraph.parts))
    }
  }
  return { paragraphs, headings, hrefs }
}

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousAnimationFrame: unknown
let previousCancelAnimationFrame: unknown
let dom: Window

beforeAll(() => {
  dom = new Window({ url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousAnimationFrame = globals.requestAnimationFrame
  previousCancelAnimationFrame = globals.cancelAnimationFrame
  globals.window = dom
  globals.document = dom.document
  // hono's JSX renderer checks `instanceof SVGElement` for the provider
  // glyphs — another global happy-dom keeps on the window.
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => callback(0)) as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
  globals.requestAnimationFrame = previousAnimationFrame
  globals.cancelAnimationFrame = previousCancelAnimationFrame
})

describe('PrivacyPolicy renders the shared model verbatim', () => {
  test('renders every paragraph, heading, and destination from PRIVACY_POLICY', () => {
    const expected = expectedFromModel(PRIVACY_POLICY)
    const rendered = extractDocument(String(PrivacyPolicy({})))

    // The model is the single source of the wording: same paragraphs in the
    // same order, same headings, same external destinations — nothing
    // invented, nothing lost.
    expect(rendered.paragraphs).toEqual(expected.paragraphs)
    expect(rendered.headings).toEqual(expected.headings)
    expect(rendered.hrefs).toEqual(expected.hrefs)
    expect(rendered.paragraphs.length).toBe(20)
  })

  test('keeps the effective date and the on-your-device anchor id from the model', () => {
    const html = String(PrivacyPolicy({}))
    expect(html).toContain('Last updated: 1 October 2026')
    expect(html).toContain('id="on-your-device"')
    expect(html).toContain('id="policy-just-looking"')
  })
})

describe('the privacy route adopts the shared renderer', () => {
  const env = { HOST_API_JWT_SECRET: 'manorama-test-session-secret-min32' }

  const mountRoute = (app: Hono, path: string, route: unknown) => {
    const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
    if (Array.isArray(route)) get(path, ...(route as Handler[]))
    else get(path, route as Handler)
  }

  const mountPrivacyRoute = () => {
    const app = new Hono()
    app.use('*', async (c: Context, next: Next) => {
      await contextStorage.run(c, () => next())
    })
    app.use('*', renderer)
    mountRoute(app, '/privacy', privacyRoute)
    return app
  }

  test('the route source no longer duplicates the policy document', async () => {
    const source = await readFile(new URL('../routes/privacy.tsx', import.meta.url), 'utf8')
    expect(source).toContain("from '../components/PrivacyPolicy'")
    expect(source).toContain('<PrivacyPolicy')
    // The old in-route document is gone: no personas grid, no lede, no
    // inline headings or paragraphs.
    expect(source).not.toContain('policy-personas')
    expect(source).not.toContain('policy-lede')
    expect(source).not.toContain('<h2>')
    expect(source).not.toContain('<p class="policy-updated">')
  })

  test('the rendered route matches the shared renderer output exactly', async () => {
    const app = mountPrivacyRoute()
    const response = await app.request('/privacy', {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    // The page shell adds its own links (favicons, stylesheet) — extract the
    // policy document body only, so hrefs compare against the model exactly.
    const articleStart = html.indexOf('<article class="policy-document">')
    const articleEnd = html.indexOf('</article>')
    expect(articleStart).toBeGreaterThan(-1)
    expect(articleEnd).toBeGreaterThan(articleStart)
    const article = html.slice(articleStart, articleEnd + '</article>'.length)
    const rendered = extractDocument(article)
    const expected = expectedFromModel(PRIVACY_POLICY)
    expect(rendered.paragraphs).toEqual(expected.paragraphs)
    expect(rendered.headings).toEqual(expected.headings)
    expect(rendered.hrefs).toEqual(expected.hrefs)
    expect(html).toContain('<title>Privacy Policy — manorama</title>')
  })
})

describe('PrivacyPolicy external links', () => {
  test('renders semantic anchors with unchanged destinations by default', () => {
    const html = String(PrivacyPolicy({}))
    expect(html).toContain('href="https://thecontrarian.in/#contact"')
    expect(html).toContain('>Mahesh Shantaram</a>')
  })

  test('routes anchor clicks through onOpenExternal while keeping the href', () => {
    const opened: string[] = []
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<PrivacyPolicy onOpenExternal={(url) => opened.push(url)} />, container)

    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe('https://thecontrarian.in/#contact')
    ;(anchor as HTMLAnchorElement).click()
    expect(opened).toEqual(['https://thecontrarian.in/#contact'])
  })

  test('prevents the default navigation when routing through onOpenExternal', () => {
    const opened: string[] = []
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<PrivacyPolicy onOpenExternal={(url) => opened.push(url)} />, container)

    const before = dom.location.href
    ;(container.querySelector('a') as HTMLAnchorElement).click()
    expect(dom.location.href).toBe(before)
    expect(opened).toEqual(['https://thecontrarian.in/#contact'])
  })
})

describe('PrivacyPolicy print behavior', () => {
  test('renders a Print control only when onPrint is provided, and fires it', () => {
    let printed = 0
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<PrivacyPolicy onPrint={() => { printed += 1 }} />, container)

    const print = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Print')
    expect(print).toBeDefined()
    ;(print as HTMLButtonElement).click()
    expect(printed).toBe(1)
  })

  test('renders no print control without onPrint', () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<PrivacyPolicy />, container)
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})
