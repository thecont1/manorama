import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import Privacy from './Privacy'

const plainText = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', "'")
    .replace(/\s+/g, ' ')
    .trim()

const paragraphCount = (markup: string) => [...markup.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].length

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
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => callback(0)) as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
  globals.requestAnimationFrame = previousAnimationFrame
  globals.cancelAnimationFrame = previousCancelAnimationFrame
})

const mount = (props: { onBack: () => void; onOpenExternal?: (url: string) => void; onPrint?: () => void }) => {
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(<Privacy {...props} />, container)
  return container
}

describe('Privacy native view', () => {
  test('always renders a Back control that fires onBack', () => {
    let backed = 0
    const container = mount({ onBack: () => { backed += 1 } })
    const back = container.querySelector('button[aria-label="Back"]')
    expect(back).not.toBeNull()
    expect(back?.textContent).toBe('Back')
    ;(back as HTMLButtonElement).click()
    expect(backed).toBe(1)
  })

  test('mounts the full shared policy document, readable and scrollable', () => {
    const html = String(Privacy({ onBack: () => {} }))
    expect(html).toContain('privacy-view')
    expect(html).toContain('data-screen="privacy"')
    expect(html).toContain('class="privacy-scroll"')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('Privacy Policy')
    expect(html).toContain('Last updated: 1 October 2026')
    expect(plainText(html)).toContain('Manorama is a place to share and look at photographs.')
    expect(paragraphCount(html)).toBe(20)
    expect(html).toContain('href="https://thecontrarian.in/#contact"')
  })

  test('routes external links through onOpenExternal with the destination unchanged', () => {
    const opened: string[] = []
    const container = mount({ onBack: () => {}, onOpenExternal: (url) => opened.push(url) })
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://thecontrarian.in/#contact')
    ;(anchor as HTMLAnchorElement).click()
    expect(opened).toEqual(['https://thecontrarian.in/#contact'])
  })

  test('renders a Print control only when onPrint is provided, and fires it', () => {
    let printed = 0
    const container = mount({ onBack: () => {}, onPrint: () => { printed += 1 } })
    const print = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Print')
    expect(print).toBeDefined()
    ;(print as HTMLButtonElement).click()
    expect(printed).toBe(1)
  })

  test('renders no Print control without onPrint', () => {
    const container = mount({ onBack: () => {} })
    expect(container.querySelectorAll('button').length).toBe(1)
    expect(container.querySelector('button[aria-label="Back"]')).not.toBeNull()
  })
})
