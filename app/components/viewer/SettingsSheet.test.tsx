import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import SettingsSheet from './SettingsSheet'
import { releaseAllOverlays } from '../../lib/overlay-stack'
import type { SettingsSheetProps } from './SettingsSheet'

/**
 * The Settings popover's two pages: the View page every role sees, and
 * the Gallery settings drill-in an owner gets through `galleryPanel`.
 * Escape and Back share one rule — inside the gallery page they step back
 * to the view page first, and only the view page closes the sheet.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const base: SettingsSheetProps = {
  open: true,
  onClose: () => {},
  mode: 'strip',
  onMode: () => {},
  background: 'dark',
  onBackground: () => {},
  arrowsOn: true,
  onArrows: () => {},
  fullscreenAvailable: false,
  fullscreenActive: false,
  onFullscreen: () => {},
  showShortcuts: false,
  onOpenShortcuts: () => {},
}

const mounted = (overrides: Partial<SettingsSheetProps> = {}) => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const renderSheet = (props: Partial<SettingsSheetProps>) => {
    flushSync(() => {
      render(<SettingsSheet {...base} {...overrides} {...props} />, container as unknown as HTMLElement)
    })
  }
  renderSheet({})
  return { root: container as unknown as HTMLElement, renderSheet }
}

const sheet = (root: HTMLElement) => root.querySelector<HTMLElement>('.m-sheet')
const row = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLElement>('.m-actionrow')].find((node) => node.textContent?.includes(label))
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(() => {}) }
const escape = () => dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document, fetch: globals.fetch,
  }
  dom = new Window({ url: 'http://localhost/thecontrarian/mixed' })
  globals.window = dom
  globals.document = dom.document
  // SVGElement, the rAF pair, HTMLElement and MutationObserver stay
  // installed after this file — see gallery-settings-order.test.tsx.
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
})

afterEach(() => {
  releaseAllOverlays()
  dom.document.body.innerHTML = ''
})

describe('the Settings popover pages', () => {
  test('a visitor sees the role actions and no Gallery settings row', () => {
    const { root } = mounted({
      actions: <button type="button" class="m-actionrow">Sign in</button>,
    })
    expect(sheet(root)?.textContent).toContain('Settings')
    expect(sheet(root)?.textContent).toContain('View')
    expect(sheet(root)?.textContent).toContain('Sign in')
    expect(row(root, 'Gallery settings')).toBeUndefined()
  })

  test('an owner drills into Gallery settings and Back returns to the view page', async () => {
    const { root } = mounted({
      galleryPanel: <div class="m-owner-panel" data-testid="owner-panel">panel body</div>,
      galleryIntro: <div class="m-owner-panel-head">Mixed album</div>,
    })
    // The role slot is the single Gallery settings row — `actions` would be
    // ignored even if a caller passed both.
    expect(row(root, 'Gallery settings')).toBeTruthy()

    flushSync(() => row(root, 'Gallery settings')?.click())
    await settle()
    expect(sheet(root)?.textContent).toContain('Gallery settings')
    expect(root.querySelector('[data-testid="owner-panel"]')).not.toBeNull()
    expect(root.querySelector('.m-owner-panel-head')?.textContent).toBe('Mixed album')
    // The view controls are gone while the gallery page is up.
    expect(sheet(root)?.textContent).not.toContain('Layout')
    // Focus moved to the gallery page heading.
    expect(dom.document.activeElement?.textContent).toBe('Gallery settings')

    // Back returns to the view page and focus returns to the row.
    const back = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Settings')!
    flushSync(() => back.click())
    await settle()
    expect(sheet(root)?.textContent).toContain('Layout')
    expect(root.querySelector('[data-testid="owner-panel"]')).toBeNull()
    expect(dom.document.activeElement?.closest('.m-actionrow')?.textContent).toContain('Gallery settings')
  })

  test('Escape inside the gallery page steps back before it closes the sheet', async () => {
    let closed = 0
    const { root } = mounted({
      onClose: () => { closed += 1 },
      galleryPanel: <div class="m-owner-panel">panel body</div>,
    })
    flushSync(() => row(root, 'Gallery settings')?.click())
    await settle()
    escape()
    await settle()
    // Still open — the gallery page consumed the Escape as a Back.
    expect(closed).toBe(0)
    expect(sheet(root)?.textContent).toContain('Layout')
    escape()
    await settle()
    expect(closed).toBe(1)
  })

  test('reopening always lands on the view page', async () => {
    const { root, renderSheet } = mounted({ galleryPanel: <div class="m-owner-panel">panel</div> })
    flushSync(() => row(root, 'Gallery settings')?.click())
    await settle()
    expect(root.querySelector('.m-owner-panel')).not.toBeNull()
    // Close and reopen the same mounted sheet — the drill-in is per-open.
    renderSheet({ open: false })
    await settle()
    renderSheet({ open: true })
    await settle()
    expect(root.querySelector('.m-owner-panel')).toBeNull()
    expect(sheet(root)?.textContent).toContain('Layout')
  })

  test('the Keyboard shortcuts row appears only for a fine pointer and calls back', () => {
    let opened = 0
    const { root } = mounted({ showShortcuts: true, onOpenShortcuts: () => { opened += 1 } })
    const shortcuts = row(root, 'Keyboard shortcuts')
    expect(shortcuts).toBeTruthy()
    flushSync(() => shortcuts?.click())
    expect(opened).toBe(1)

    const { root: touch } = mounted({ showShortcuts: false, onOpenShortcuts: () => { opened += 1 } })
    expect(row(touch, 'Keyboard shortcuts')).toBeUndefined()
  })
})
