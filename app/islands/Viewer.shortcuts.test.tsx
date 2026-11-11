import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * The `?` key and the shortcuts sheet.
 *
 * Keyboard shortcuts left the Settings popover: `?` opens their own sheet
 * (fine pointers only, like the other chrome keys), and the popover's foot
 * row reaches the same sheet. The key must never fire while the owner is
 * typing — a `?` in a caption is punctuation, not a command.
 */

/** Lets hono's async effect re-arm settle between interactions. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const SLUG = 'shortcuts-sheet'
const images: GalleryMediaItem[] = [{
  id: 'frame-1',
  filename: 'frame-1.jpg',
  src: 'https://example.test/frame-1.jpg',
  width: 2267,
  height: 1700,
  alt: 'frame 1',
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
}]

/** Mounts the Viewer with a single image and default settings. */
const mountViewer = (): HTMLElement => {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  render(
    <Viewer
      slug={SLUG}
      galleryTitle="Shortcuts"
      images={images}
      settings={defaultGallerySettings({ slug: SLUG, title: 'Shortcuts', caption: '', date: '', images })}
    />,
    root as unknown as HTMLElement,
  )
  return root as unknown as HTMLElement
}

/** Dispatches a bubbling keydown — the window listener's event shape. */
const press = (target: unknown, key: string) => {
  ;(target as { dispatchEvent: (event: unknown) => void }).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true }),
  )
}

const shortcutsSheet = () =>
  [...dom.document.querySelectorAll('.m-sheet')]
    .find((sheet) => sheet.textContent?.includes('Keyboard shortcuts'))

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document, fetch: globals.fetch,
  }
  dom = new Window({ url: `http://localhost/${SLUG}` })
  globals.window = dom
  globals.document = dom.document
  // SVGElement, the rAF pair, HTMLElement and MutationObserver stay
  // installed after this file — see gallery-settings-order.test.tsx. The
  // sheets the viewer mounts need the DOM globals even while closed.
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  // A fine pointer arms the chrome keys — the magnifier query is the one
  // the viewer asks about; everything else stays coarse.
  ;(dom.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
    (query: string) => ({ matches: query === '(hover: hover) and (pointer: fine)' })
  ;(dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
})

describe('the shortcuts sheet', () => {
  beforeEach(() => {
    dom.document.body.innerHTML = ''
    dom.document.body.classList.add('gallery-entered')
  })

  test('? opens the sheet with the full shortcut list', async () => {
    mountViewer()
    await settle()
    press(dom.window, '?')
    await settle()
    const sheet = shortcutsSheet()
    expect(sheet).toBeTruthy()
    expect(sheet?.textContent).toContain('photograph selector')
    expect(sheet?.textContent).toContain('image info')
    // The sheet documents its own key.
    const kbd = [...sheet!.querySelectorAll('kbd')].find((el) => el.textContent === '?')
    expect(kbd?.parentElement?.textContent).toContain('keyboard shortcuts')
  })

  test('? is punctuation inside a text field, not a command', async () => {
    mountViewer()
    await settle()
    const input = dom.document.createElement('input')
    dom.document.body.appendChild(input)
    press(input, '?')
    await settle()
    expect(shortcutsSheet()).toBeUndefined()
  })
})
