import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import Catalogue from './Catalogue'

/**
 * The catalogue's account pane is a lifecycle feature — open, focus, theme,
 * close — so it is exercised through a mounted island rather than a stringified
 * render. The Tauri IPC the island talks to is stubbed at the one place the
 * official API reads it (`window.__TAURI_INTERNALS__`), so the island runs its
 * real launch path: restore the session, read the catalogue, probe the sources.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown
let previousLocalStorage: unknown
let previousFetch: unknown

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
/** Drain effects, microtask state flushes and any creative they resolve. */
const settle = async () => {
  for (let round = 0; round < 6; round++) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const DEVICE_ID = '11111111-2222-3333-4444-555555555555'
const GALLERY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TITLE = 'italy, amore mio'

const item = (id: string, name: string, width: number, height: number) => ({
  id,
  name,
  path: `/Users/home/Pictures/${TITLE}/${name}`,
  width,
  height,
})

const record = {
  id: GALLERY_ID,
  title: TITLE,
  rootPath: `/Users/home/Pictures/${TITLE}`,
  sourceKind: 'folder' as const,
  itemCount: 2,
  items: [
    item('image-1', 'MS201810-Italy0005.jpg', 4000, 3000),
    item('image-2', 'MS201810-Italy0100.jpg', 3000, 4000),
  ],
  addedAt: '2026-10-11T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
}

let dom: Window
let files: Record<string, string>

const installTauri = (signedIn: boolean) => {
  files = {
    'catalogue.json': JSON.stringify({ version: 1, deviceId: DEVICE_ID, deviceLabel: 'This Mac', galleries: [record] }),
    ...(signedIn ? { 'session.json': JSON.stringify({ token: 'token', ownerSlug: 'thecontrarian' }) } : {}),
  }
  ;(dom as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'read_private_file') return files[String(args?.name)] ?? null
      if (command === 'write_private_file') {
        files[String(args?.name)] = String(args?.contents)
        return null
      }
      if (command === 'delete_private_file') {
        delete files[String(args?.name)]
        return null
      }
      // `plugin:fs|exists` — every saved root is reported mounted.
      if (command === 'plugin:fs|exists') return true
      return null
    },
    convertFileSrc: (path: string) => `asset://localhost${path}`,
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
}

const mount = async (signedIn: boolean): Promise<HTMLElement> => {
  installTauri(signedIn)
  // happy-dom's element types are not lib.dom's; the repo's render tests cast at
  // this one boundary so every query below is typed by the DOM library.
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(<Catalogue apiBase="https://manorama.xyz" />, container)
  await settle()
  return container
}

const byText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)

beforeAll(() => {
  dom = new Window({ width: 1280, height: 840, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  previousLocalStorage = globals.localStorage
  previousFetch = globals.fetch
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  // The island reads the shared theme key from bare `localStorage`.
  globals.localStorage = dom.localStorage
  // Sync is fire-and-forget at launch: answer it locally instead of reaching
  // the real API.
  globals.fetch = (async () =>
    new Response(JSON.stringify({ galleries: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    nextFrameId += 1
    frames.push({ id: nextFrameId, callback })
    return nextFrameId
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id)
  }) as unknown as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
  globals.getComputedStyle = previousGetComputedStyle
  globals.localStorage = previousLocalStorage
  globals.fetch = previousFetch
  // SVGElement and the rAF pair stay installed: hono keeps its namespace
  // context once an <svg> has rendered, and clearing the DOM does not run
  // effect cleanup, so a later post-effect pass would call the bare globals.
})

beforeEach(() => {
  frames = []
  dom.localStorage.clear()
  dom.document.documentElement.className = ''
  dom.document.body.innerHTML = ''
})

afterEach(() => {
  dom.document.body.innerHTML = ''
})

describe('desktop catalogue workbench', () => {
  test('renders the shared admin layout, account pane closed', async () => {
    const container = await mount(true)

    expect(container.querySelector('.admin-page.admin-page--selector')).not.toBeNull()
    expect(container.querySelector('.desktop-catalogue')).not.toBeNull()
    expect(container.querySelector('.desktop-shell')).toBeNull()

    // Header quadrants: welcome copy left of the source picker, galleries below
    // both — the same order the web dashboard and iOS admin use.
    const welcome = container.querySelector('.admin-welcome')
    const importer = container.querySelector('.gallery-import')
    const galleries = container.querySelector('#galleries-heading')
    expect(welcome?.getAttribute('aria-label')).toBe('Welcome to manorama')
    expect(container.querySelector('#import-heading')?.textContent).toBe('Add a gallery')
    expect(galleries?.textContent).toBe('Your galleries')
    const html = container.innerHTML
    expect(html.indexOf('admin-welcome')).toBeLessThan(html.indexOf('import-heading'))
    expect(html.indexOf('import-heading')).toBeLessThan(html.indexOf('galleries-heading'))

    // The account controls live behind one labelled edge tab.
    const tab = container.querySelector<HTMLButtonElement>('.admin-edge-tab')
    expect(tab?.getAttribute('aria-label')).toBe('Account menu')
    expect(tab?.getAttribute('aria-expanded')).toBe('false')
    expect(tab?.getAttribute('aria-controls')).toBe('admin-account-drawer')
    const drawer = container.querySelector<HTMLElement>('#admin-account-drawer')
    expect(drawer?.hidden).toBe(true)
    const panel = container.querySelector('.admin-drawer-panel')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    expect(panel?.getAttribute('aria-label')).toBe('Account')

    // One control for the theme, one to leave, both at the pane's foot.
    expect(byText(container, 'Switch to light mode')).toBeDefined()
    expect(byText(container, 'Sign out')).toBeDefined()
  })

  test('opens the pane, keeps Tab inside it, and hands the caret back', async () => {
    const container = await mount(true)
    const tab = container.querySelector<HTMLButtonElement>('.admin-edge-tab')!
    const drawer = container.querySelector<HTMLElement>('#admin-account-drawer')!

    tab.click()
    await settle()
    expect(tab.getAttribute('aria-expanded')).toBe('true')
    expect(drawer.hidden).toBe(false)
    const panel = container.querySelector('.admin-drawer-panel')!
    expect(panel.contains(dom.document.activeElement as unknown as Node)).toBe(true)

    // Tab from the last control wraps to the first, so the pane is a loop.
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')]
    expect(focusable.length).toBeGreaterThan(2)
    focusable[focusable.length - 1].focus()
    // Dispatched from the mounted container: the pane's handler listens on
    // `document`, and this keeps the event typed by the DOM library.
    container.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }) as unknown as KeyboardEvent)
    expect(dom.document.activeElement).toBe(focusable[0])

    container.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent)
    await settle()
    expect(drawer.hidden).toBe(true)
    expect(tab.getAttribute('aria-expanded')).toBe('false')
    expect(dom.document.activeElement).toBe(tab)

    // A backdrop click closes it too.
    tab.click()
    await settle()
    expect(drawer.hidden).toBe(false)
    container.querySelector<HTMLElement>('.admin-drawer-scrim')!.click()
    await settle()
    expect(drawer.hidden).toBe(true)
  })

  test('the theme action flips the shared class and key', async () => {
    const container = await mount(true)
    expect(dom.document.documentElement.classList.contains('light')).toBe(false)

    container.querySelector<HTMLButtonElement>('.admin-edge-tab')!.click()
    await settle()
    byText(container, 'Switch to light mode')!.click()
    await settle()

    expect(dom.document.documentElement.classList.contains('light')).toBe(true)
    expect(dom.localStorage.getItem('manorama:theme')).toBe('light')
    expect(byText(container, 'Switch to dark mode')).toBeDefined()

    byText(container, 'Switch to dark mode')!.click()
    await settle()
    expect(dom.document.documentElement.classList.contains('light')).toBe(false)
    expect(dom.localStorage.getItem('manorama:theme')).toBe('dark')
  })

  test('a stored light choice is applied at launch', async () => {
    dom.localStorage.setItem('manorama:theme', 'light')
    await mount(true)
    expect(dom.document.documentElement.classList.contains('light')).toBe(true)
  })

  test('a gallery card is one row of clickable originals, first frame pink', async () => {
    const container = await mount(true)
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.getAttribute('data-availability')).toBe('available')
    expect(card.querySelector('.admin-gallery-title')?.textContent).toBe(TITLE)
    expect(card.querySelector('.admin-gallery-count')?.textContent).toBe('(2 photos)')
    expect(card.querySelector('.admin-gallery-caption')?.textContent).toContain('Folder on this device')
    expect(card.querySelector('.admin-gallery-caption')?.textContent).toContain(record.rootPath)

    const strip = card.querySelector('.admin-gallery-strip')!
    expect(strip.getAttribute('role')).toBe('list')
    const framesInStrip = [...strip.querySelectorAll<HTMLButtonElement>('.admin-gallery-strip-item')]
    expect(framesInStrip).toHaveLength(2)
    expect(framesInStrip[0].tagName).toBe('BUTTON')
    expect(framesInStrip[0].classList.contains('is-active')).toBe(true)
    expect(framesInStrip[1].classList.contains('is-active')).toBe(false)
    expect(framesInStrip[1].getAttribute('aria-label')).toBe(`Open MS201810-Italy0100.jpg — photograph 2 of 2 in ${TITLE}`)
    // Originals are referenced in place through the asset protocol: no copy,
    // no derivative, no thumbnail.
    expect(strip.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost${record.items[0].path}`)

    // The four actions are the v1 verbs, each reachable by name.
    for (const name of [`View ${TITLE}`, `Rescan ${TITLE}`, `Share ${TITLE}`, `Remove ${TITLE}`]) {
      expect(card.querySelector(`[aria-label="${name}"]`)).not.toBeNull()
    }
  })

  test('signed out, the desktop shows the welcome chooser', async () => {
    const container = await mount(false)
    expect(container.querySelector('.admin-page')).toBeNull()
    const welcome = container.querySelector('.landing-page.desktop-welcome')!
    expect(welcome.querySelector('.desktop-welcome-header img')).not.toBeNull()
    const chooser = [...welcome.querySelectorAll<HTMLButtonElement>('.desktop-signin-icon')]
    expect(chooser.length).toBeGreaterThan(1)
    expect(chooser[0].getAttribute('aria-label')).toBe('Continue with Apple')
    for (const button of chooser) expect(button.textContent?.trim().length).toBeGreaterThan(0)
  })
})
