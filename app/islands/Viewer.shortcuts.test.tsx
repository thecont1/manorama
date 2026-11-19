import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { unmountTracker } from '../../test/unmount'
import Viewer, { type ViewerChromeControl, type ViewerChromeHandle } from './Viewer'
import { releaseAllOverlays } from '../lib/overlay-stack'
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

/** Defaults to one image; native tests supply the same handle as the shell. */
const mountViewer = (props: Partial<Parameters<typeof Viewer>[0]> = {}): HTMLElement => {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  mounts.mount(
    <Viewer
      slug={SLUG}
      galleryTitle="Shortcuts"
      images={images}
      settings={defaultGallerySettings({ slug: SLUG, title: 'Shortcuts', caption: '', date: '', images })}
      {...props}
    />,
    root as unknown as HTMLElement,
  )
  return root as unknown as HTMLElement
}

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

/** Dispatches a bubbling keydown — the window listener's event shape. */
const press = (target: unknown, key: string) => {
  ;(target as { dispatchEvent: (event: unknown) => void }).dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
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
  // Fine-pointer keys stay armed. Reduced motion avoids recursively running
  // a timed strip glide through this fixture's synchronous rAF stub.
  ;(dom.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
    (query: string) => ({ matches: query === '(hover: hover) and (pointer: fine)' || query === '(prefers-reduced-motion: reduce)' })
  ;(dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
})

afterAll(() => {
  mounts.unmountAll()
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
})

beforeEach(() => {
  dom.document.body.innerHTML = ''
  dom.document.body.classList.add('gallery-entered')
  dom.window.location.hash = ''
  dom.window.localStorage.clear()
})

afterEach(async () => {
  mounts.unmountAll()
  releaseAllOverlays()
  await settle()
})

describe('the shortcuts sheet', () => {

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

const controls = ['settings', 'info', 'position'] as const
const selectorFor = (control: typeof controls[number]) => control === 'position'
  ? '[data-chrome-position]'
  : `button[aria-label="${control === 'settings' ? 'Gallery Settings' : 'Info'}"]`
const overlayFor = (control: typeof controls[number]) => control === 'position'
  ? '.viewer-filmstrip'
  : '.m-sheet'

const mountNative = (props: Partial<Parameters<typeof Viewer>[0]> = {}) => {
  const chromeRef: { current: ViewerChromeHandle | null } = { current: null }
  const focusRequests: ViewerChromeControl[] = []
  const libraryReturns: boolean[] = []
  const root = mountViewer({
    chromeRef,
    onChromeFocus: (control) => { focusRequests.push(control) },
    onReturnToGalleries: () => { libraryReturns.push(true) },
    ...props,
  })
  return { root, chromeRef, focusRequests, libraryReturns }
}

// The picker deliberately lets its closing animation finish before
// committing the photograph and restoring focus — wait on the teardown
// itself, not a fixed sleep that suite load can outrun.
const settlePickerClose = async (root: HTMLElement) => {
  const deadline = Date.now() + 5000
  while (root.querySelector('.viewer-filmstrip')) {
    if (Date.now() > deadline) throw new Error('picker did not close within 5s')
    await settle()
  }
  await settle()
}

describe('native viewer chrome', () => {
  for (const control of controls) {
    for (const dismissal of ['Escape', 'close button'] as const) {
      test(`${control} opens without a DOM click and ${dismissal} returns to the native invoker`, async () => {
        const { root, chromeRef, focusRequests } = mountNative()
        await settle()
        const stage = root.querySelector<HTMLElement>('[data-stage]')!
        stage.focus()
        let clicks = 0
        const clicked = () => { clicks += 1 }
        for (const pill of root.querySelectorAll<HTMLElement>('.m-chrome-pill')) {
          pill.style.display = 'none'
          pill.addEventListener('click', clicked)
        }
        chromeRef.current!.activate(control)
        await settle()
        const overlay = root.querySelector<HTMLElement>(overlayFor(control))
        expect(overlay).not.toBeNull()
        expect(overlay!.contains(dom.document.activeElement as unknown as Node)).toBe(true)
        expect(clicks).toBe(0)
        expect(focusRequests).toEqual([])
        if (control === 'settings') expect(overlay!.textContent).toContain('Gallery Settings')
        if (control === 'info') expect(overlay!.textContent).toContain('frame-1.jpg')
        if (control === 'position') expect(overlay!.querySelectorAll('[data-grid-item]')).toHaveLength(1)
        if (dismissal === 'Escape') press(dom.document.activeElement, 'Escape')
        else overlay!.querySelector<HTMLButtonElement>('button[aria-label^="Close"]')!.click()
        if (control === 'position') await settlePickerClose(root)
        else await settle()
        expect(root.querySelector(overlayFor(control))).toBeNull()
        expect(focusRequests).toEqual([control])
        expect(clicks).toBe(0)
      })
    }
  }

  for (const selection of ['click', 'Enter'] as const) {
    test(`picker ${selection} commits the photograph and returns to native position`, async () => {
      const pair = [images[0], { ...images[0], id: 'frame-2', filename: 'frame-2.jpg' }]
      const { root, chromeRef, focusRequests } = mountNative({ images: pair, initialIndex: 1 })
      await settle()
      chromeRef.current!.activate('position')
      await settle()
      await settle()
      expect(root.querySelector('[data-grid-active]')?.getAttribute('data-image-id')).toBe('frame-2')
      if (selection === 'click') root.querySelectorAll<HTMLButtonElement>('[data-grid-item]')[0].click()
      else {
        press(dom.document.activeElement, 'Home')
        await settle()
        expect(root.querySelector('[data-grid-active]')?.getAttribute('data-image-id')).toBe('frame-1')
        press(dom.document.activeElement, 'Enter')
      }
      await settlePickerClose(root)
      expect(root.querySelector('.viewer-filmstrip')).toBeNull()
      expect(root.querySelector('[data-chrome-position]')?.textContent).toBe('1 of 2')
      expect(focusRequests).toEqual(['position'])
      // The live handle must read the new index, not the mount-time image.
      chromeRef.current!.activate('info')
      await settle()
      expect(root.querySelector('.m-sheet')?.textContent).toContain('frame-1.jpg')
    })
  }

  test('rejects sheet activation before entry, but Library remains an exit', async () => {
    dom.document.body.classList.remove('gallery-entered')
    const curtain = dom.document.createElement('section')
    curtain.setAttribute('data-curtain', '')
    dom.document.body.appendChild(curtain)
    const { root, chromeRef, focusRequests, libraryReturns } = mountNative()
    await settle()
    for (const control of controls) chromeRef.current!.activate(control)
    await settle()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(focusRequests).toEqual([])
    chromeRef.current!.activate('library')
    expect(libraryReturns).toEqual([true])
  })

  test('an open modal rejects native actions, including before the next render', async () => {
    const { root, chromeRef, focusRequests, libraryReturns } = mountNative()
    await settle()
    chromeRef.current!.activate('settings')
    for (const control of ['info', 'position', 'library'] as const) chromeRef.current!.activate(control)
    await settle()
    for (const control of ['info', 'position', 'library'] as const) chromeRef.current!.activate(control)
    await settle()
    expect(root.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(root.querySelector('.m-sheet')?.textContent).toContain('Gallery Settings')
    expect(libraryReturns).toEqual([])
    press(dom.document.activeElement, 'Escape')
    await settle()
    expect(focusRequests).toEqual(['settings'])
  })

  test('Tab reveals controls and requests native Settings focus', async () => {
    const { root, focusRequests } = mountNative()
    await settle()
    const stage = root.querySelector<HTMLElement>('[data-stage]')!
    stage.focus()
    press(stage, 'Tab')
    await settle()
    expect(root.querySelector('[data-chrome-bottom]')?.classList.contains('is-visible')).toBe(true)
    expect(focusRequests).toEqual(['settings'])
  })

  test('Show controls requests native focus; focusStage returns it to the DOM', async () => {
    const { root, chromeRef, focusRequests } = mountNative()
    await settle()
    root.querySelector<HTMLButtonElement>('.m-chrome-skip')!.click()
    await settle()
    expect(focusRequests).toEqual(['settings'])
    chromeRef.current!.activate('settings')
    await settle()
    const heading = dom.document.activeElement
    chromeRef.current!.focusStage()
    expect(dom.document.activeElement).toBe(heading)
    press(heading, 'Escape')
    await settle()
    chromeRef.current!.focusStage()
    expect(dom.document.activeElement).toBe(root.querySelector('[data-stage]'))
  })

  test('native activity holds revealed chrome past idle, then release restarts idle', async () => {
    const { root, chromeRef } = mountNative()
    await settle()
    press(dom.window, 'Tab')
    await settle()
    chromeRef.current!.setActive(true)
    // A fresh reveal arms the idle timer even while native chrome owns focus.
    press(dom.window, 'Tab')
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await settle()
    expect(root.querySelector('[data-chrome-bottom]')?.classList.contains('is-visible')).toBe(true)
    chromeRef.current!.setActive(false)
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await settle()
    expect(root.querySelector('[data-chrome-bottom]')?.classList.contains('is-visible')).toBe(false)
  }, 10000)

  test('native activity holds the curtain Library past idle, then release restarts idle', async () => {
    dom.document.body.classList.remove('gallery-entered')
    const curtain = dom.document.createElement('section')
    curtain.setAttribute('data-curtain', '')
    dom.document.body.appendChild(curtain)
    const { root, chromeRef } = mountNative()
    await settle()
    root.querySelector<HTMLElement>('[data-stage]')!.focus()
    dom.window.dispatchEvent(new dom.window.Event('pointermove'))
    await settle()
    chromeRef.current!.setActive(true)
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await settle()
    expect(root.querySelector('[data-veil-chrome]')?.classList.contains('is-visible')).toBe(true)
    chromeRef.current!.setActive(false)
    await new Promise((resolve) => setTimeout(resolve, 3100))
    await settle()
    expect(root.querySelector('[data-veil-chrome]')?.classList.contains('is-visible')).toBe(false)
  }, 10000)

  test('Settings remeasures the dock when the native viewport resizes', async () => {
    const { root, chromeRef } = mountNative()
    await settle()
    const oldWidth = dom.window.innerWidth
    const oldHeight = dom.window.innerHeight
    const nav = root.querySelector<HTMLElement>('[data-chrome-bottom]')!
    let rect = { left: 300, top: 730, width: 400, height: 44 }
    nav.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {} })
    try {
      dom.window.innerWidth = 1000
      dom.window.innerHeight = 800
      chromeRef.current!.activate('settings')
      await settle()
      const panel = root.querySelector<HTMLElement>('.m-sheet--popover')!
      expect(panel.style.left).toBe('220px')
      expect(panel.style.width).toBe('560px')
      expect(panel.style.bottom).toBe('80px')
      dom.window.innerWidth = 480
      dom.window.innerHeight = 600
      rect = { left: 20, top: 520, width: 440, height: 44 }
      dom.window.dispatchEvent(new dom.window.Event('resize'))
      await settle()
      expect(panel.style.left).toBe('14px')
      expect(panel.style.width).toBe('452px')
      expect(panel.style.bottom).toBe('90px')
    } finally {
      dom.window.innerWidth = oldWidth
      dom.window.innerHeight = oldHeight
    }
  })

  test('unmount clears the published handle', async () => {
    const { chromeRef } = mountNative()
    await settle()
    expect(chromeRef.current).not.toBeNull()
    mounts.unmountAll()
    expect(chromeRef.current).toBeNull()
  })
})

describe('ordinary web chrome remains DOM-owned', () => {
  for (const control of controls) {
    test(`${control} Escape restores its DOM invoker without native props`, async () => {
      const root = mountViewer()
      await settle()
      root.querySelector<HTMLButtonElement>('.m-chrome-skip')!.click()
      await settle()
      const button = root.querySelector<HTMLButtonElement>(selectorFor(control))!
      button.focus()
      button.click()
      await settle()
      expect(root.querySelector(overlayFor(control))).not.toBeNull()
      press(dom.document.activeElement, 'Escape')
      if (control === 'position') await settlePickerClose(root)
      else await settle()
      expect(root.querySelector(overlayFor(control))).toBeNull()
      expect(dom.document.activeElement).toBe(button)
    })
  }

  test('Show controls still focuses the web Settings button', async () => {
    const root = mountViewer()
    await settle()
    root.querySelector<HTMLButtonElement>('.m-chrome-skip')!.click()
    await settle()
    expect(dom.document.activeElement).toBe(root.querySelector(selectorFor('settings')))
  })
})
