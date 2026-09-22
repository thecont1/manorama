import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

/**
 * The layer has to come out of hono/jsx as real, inert SVG. The island
 * sizes itself from `window.innerWidth/innerHeight`, so these render it
 * against a happy-dom viewport — the same approach magnifier.test.ts
 * uses — and assert on the markup a visitor's DOM would receive.
 *
 * The import is deferred until after the DOM is installed because the
 * module reads the viewport during its initial state.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let SeededDoodleBackground: (props: Record<string, unknown>) => unknown

beforeAll(async () => {
  const window = new Window({ width: 1440, height: 900, url: 'http://localhost/' })
  previousWindow = globals.window
  globals.window = window
  globals.document = window.document
  SeededDoodleBackground = (await import('./islands/SeededDoodleBackground')).default as typeof SeededDoodleBackground
})

afterAll(() => {
  globals.window = previousWindow
})

const render = (props: Record<string, unknown>) => String(SeededDoodleBackground(props))

describe('SeededDoodleBackground markup', () => {
  test('uses a zero viewport before mount so SSR and hydration start from the same empty layer', () => {
    const win = globals.window as Window
    win.history.replaceState(null, '', '/mahesh/live?mode=single')

    // The server cannot know the viewport. The browser hydration render must
    // therefore also start empty; the mount effect fills the layer afterwards.
    expect(SeededDoodleBackground({ enabled: true })).toBeNull()
    expect(win.location.pathname + win.location.search).toBe('/mahesh/live?mode=single')
  })

  test('emits an inert, aria-hidden svg layer when given an explicit render URL', () => {
    const html = render({ url: '/mahesh/kashi' })
    expect(html).toContain('<svg')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('role="presentation"')
    expect(html).toContain('doodle-bg')
    expect(html).toContain('focusable="false"')
  })

  test('renders symbols once and references them with <use>', () => {
    const html = render({ url: '/mahesh/kashi' })
    const symbols = html.match(/<symbol/g) ?? []
    const uses = html.match(/<use/g) ?? []
    expect(symbols.length).toBeGreaterThanOrEqual(8)
    // The whole point of the sprite: far more instances than definitions.
    expect(uses.length).toBeGreaterThan(symbols.length)
  })

  test('strokes thin sharp hairlines so the field reads as technical pen work', () => {
    const html = render({ url: '/a' })
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('fill="none"')
    expect(html).toContain('stroke-width="0.9"')
    expect(html).toContain('stroke-linejoin="miter"')
    expect(html).toContain('vector-effect="non-scaling-stroke"')
    expect(html).not.toContain('stroke-linejoin="round"')
  })

  test('renders nothing at all when disabled', () => {
    expect(SeededDoodleBackground({ url: '/a', enabled: false })).toBeNull()
  })

  test('the same url renders byte-identical markup', () => {
    expect(render({ url: '/mahesh/kashi' })).toBe(render({ url: '/mahesh/kashi' }))
  })

  test('the root svg uses slice scaling so a tall virtual canvas has no side gutters', () => {
    expect(render({ url: '/a' })).toContain('preserveAspectRatio="xMidYMin slice"')
  })

  test('a different url renders different markup', () => {
    expect(render({ url: '/mahesh/kashi' })).not.toBe(render({ url: '/mahesh/goa' }))
  })

  test('the seed is exposed for screenshot-diff verification', () => {
    const html = render({ url: '/mahesh/kashi' })
    expect(html).toContain('data-doodle-seed=')
    expect(html).toContain('data-doodle-count=')
  })

  test('honours an explicit icon budget', () => {
    const uses = render({ url: '/a', maxIcons: 12 }).match(/<use/g) ?? []
    expect(uses.length).toBeLessThanOrEqual(12)
  })

  test('carries no pointer-grabbing attributes', () => {
    const html = render({ url: '/a' })
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('tabindex')
  })
})
