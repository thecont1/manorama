import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import Catalogue from './Catalogue'

/**
 * The catalogue's account pane is a lifecycle feature — open, focus, theme,
 * close — so it is exercised through a mounted island rather than a stringified
 * render. The Tauri IPC the island talks to is stubbed at the one place the
 * official API reads it (`window.__TAURI_INTERNALS__`), so the island runs its
 * real launch path: restore the session, read the catalogue, probe the sources.
 *
 * The P11 integration contract is proved here end-to-end: details mounts from a
 * card and hosts the shared Sheet+ShareFlow; history/Back work; Open, rename,
 * rescan, confirmed remove and share run through the real handlers; and the
 * shared sheet is non-dismissible during upload while dismissing mid-connect
 * cancels the pending provider connection.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown
let previousLocalStorage: unknown
let previousFetch: unknown
let previousHTMLElement: unknown
let previousMutationObserver: unknown
let previousDropboxClientId: string | undefined
let previousGoogleClientId: string | undefined

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
  for (let round = 0; round < 8; round++) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const DEVICE_ID = '11111111-2222-3333-4444-555555555555'
const GALLERY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TITLE = 'italy, amore mio'
const ROOT_PATH = `/Users/home/Pictures/${TITLE}`

const item = (id: string, width: number, height: number) => ({
  id,
  name: id,
  path: `${ROOT_PATH}/${id}`,
  width,
  height,
})

const record = {
  id: GALLERY_ID,
  title: TITLE,
  rootPath: ROOT_PATH,
  sourceKind: 'folder' as const,
  itemCount: 2,
  items: [
    item('MS201810-Italy0005.jpg', 4000, 3000),
    item('MS201810-Italy0100.jpg', 3000, 4000),
  ],
  addedAt: '2026-10-11T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
}

type DirEntry = { name: string; isDirectory: boolean; isFile: boolean }
type Gate = { promise: Promise<unknown>; resolve: (value?: unknown) => void; reject: (reason?: unknown) => void }

const deferred = (): Gate => {
  let resolve!: (value?: unknown) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let dom: Window
let files: Record<string, string>
let dirs: Record<string, DirEntry[]>
let readFileGate: Gate | null
let invokeLog: string[]

const installTauri = (signedIn: boolean, providerTokens?: Record<string, unknown>) => {
  files = {
    'catalogue.json': JSON.stringify({ version: 1, deviceId: DEVICE_ID, deviceLabel: 'This Mac', galleries: [record] }),
    ...(signedIn ? { 'session.json': JSON.stringify({ token: 'token', ownerSlug: 'thecontrarian' }) } : {}),
    ...(providerTokens ? { 'providers.json': JSON.stringify(providerTokens) } : {}),
  }
  dirs = {
    [ROOT_PATH]: [
      { name: 'MS201810-Italy0005.jpg', isDirectory: false, isFile: true },
      { name: 'MS201810-Italy0100.jpg', isDirectory: false, isFile: true },
    ],
  }
  readFileGate = null
  invokeLog = []
  ;(dom as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      invokeLog.push(command)
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
      // `plugin:fs|read_dir` — a virtual directory tree per root.
      if (command === 'plugin:fs|read_dir') return dirs[String(args?.path)] ?? []
      // `plugin:fs|read_file` — bytes; a gate can hold the read open so an
      // upload stays in flight deterministically.
      if (command === 'plugin:fs|read_file') {
        if (readFileGate) {
          await readFileGate.promise
          return new ArrayBuffer(8)
        }
        return new ArrayBuffer(8)
      }
      return null
    },
    convertFileSrc: (path: string) => `asset://localhost${path}`,
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
}

const mount = async (signedIn: boolean, providerTokens?: Record<string, unknown>): Promise<HTMLElement> => {
  installTauri(signedIn, providerTokens)
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

/** An action row's clickable element, found by its visible label. */
const row = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('.m-actionrow-label')]
    .find((el) => el.textContent === label)
    ?.closest<HTMLElement>('.m-actionrow')

const setInput = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/** The shared edit sheet submits on Enter — the real user path. */
const pressEnter = (input: HTMLInputElement) => {
  input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as KeyboardEvent)
}

/** A button inside the currently open sheet, by visible text. */
const sheetButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.m-sheet button')].find((button) => button.textContent?.trim() === text)

const detailsButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="Details ${TITLE}"]`)

beforeAll(() => {
  dom = new Window({ width: 1280, height: 840, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  previousLocalStorage = globals.localStorage
  previousFetch = globals.fetch
  previousHTMLElement = globals.HTMLElement
  previousMutationObserver = globals.MutationObserver
  previousDropboxClientId = process.env.MANORAMA_DESKTOP_DROPBOX_CLIENT_ID
  previousGoogleClientId = process.env.MANORAMA_DESKTOP_GOOGLE_CLIENT_ID
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  // The island reads the shared theme key from bare `localStorage`.
  globals.localStorage = dom.localStorage
  // Provider OAuth client ids make the share sheet's providers "configured",
  // so the flow can be driven to connect/confirm/upload in the harness.
  process.env.MANORAMA_DESKTOP_DROPBOX_CLIENT_ID = 'dropbox-client-id'
  process.env.MANORAMA_DESKTOP_GOOGLE_CLIENT_ID = 'google-client-id'
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
  globals.HTMLElement = previousHTMLElement
  globals.MutationObserver = previousMutationObserver
  if (previousDropboxClientId === undefined) delete process.env.MANORAMA_DESKTOP_DROPBOX_CLIENT_ID
  else process.env.MANORAMA_DESKTOP_DROPBOX_CLIENT_ID = previousDropboxClientId
  if (previousGoogleClientId === undefined) delete process.env.MANORAMA_DESKTOP_GOOGLE_CLIENT_ID
  else process.env.MANORAMA_DESKTOP_GOOGLE_CLIENT_ID = previousGoogleClientId
  // SVGElement and the rAF pair stay installed: hono keeps its namespace
  // context once an <svg> has rendered, and clearing the DOM does not run
  // effect cleanup, so a later post-effect pass would call the bare globals.
})

beforeEach(() => {
  frames = []
  readFileGate?.reject(new Error('test teardown'))
  readFileGate = null
  dom.localStorage.clear()
  dom.document.documentElement.className = ''
  dom.document.body.innerHTML = ''
  dom.window.history.replaceState(null, '', 'http://localhost/')
})

afterEach(() => {
  releaseAllOverlays()
  readFileGate?.reject(new Error('test teardown'))
  readFileGate = null
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

  test('a gallery card shows one Details action, thumbnails, and no local paths', async () => {
    const container = await mount(true)
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.getAttribute('data-availability')).toBe('available')
    expect(card.querySelector('.admin-gallery-title')?.textContent).toBe(TITLE)
    expect(card.querySelector('.admin-gallery-count')?.textContent).toBe('(2 photos)')

    // The caption is the source kind only — the root path never renders as
    // metadata (the thumbnail src is the asset protocol referencing originals
    // in place, which is separate and intended).
    expect(card.querySelector('.admin-gallery-caption')?.textContent).toBe('Folder on this Mac')
    expect(card.textContent).not.toContain(ROOT_PATH)

    const strip = card.querySelector('.admin-gallery-strip')!
    expect(strip.getAttribute('role')).toBe('list')
    const framesInStrip = [...strip.querySelectorAll<HTMLButtonElement>('.admin-gallery-strip-item')]
    expect(framesInStrip).toHaveLength(2)
    expect(framesInStrip[0].tagName).toBe('BUTTON')
    expect(framesInStrip[0].classList.contains('is-active')).toBe(false)
    expect(framesInStrip[1].classList.contains('is-active')).toBe(false)
    expect(framesInStrip[1].getAttribute('aria-label')).toBe(`Open MS201810-Italy0100.jpg — photograph 2 of 2 in ${TITLE}`)
    // Originals are referenced in place through the asset protocol: no copy,
    // no derivative, no thumbnail.
    expect(strip.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost${record.items[0].path}`)

    // A single Details action replaces the four v1 icon verbs.
    expect(detailsButton(container)).not.toBeNull()
    for (const name of [`View ${TITLE}`, `Rescan ${TITLE}`, `Share ${TITLE}`, `Remove ${TITLE}`]) {
      expect(card.querySelector(`[aria-label="${name}"]`)).toBeNull()
    }
    expect(card.querySelector('.desktop-share-host')).toBeNull()
  })

  test('lists account cloud galleries ahead of the local folders', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/device-galleries')) {
        return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      }
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            slug: 'kashmir',
            title: 'kashmir, in winter',
            caption: '',
            date: '',
            imageCount: 1,
            sourceUrl: 'https://www.dropbox.com/scl/fo/x',
            createdAt: '2026-10-01T00:00:00.000Z',
            retention: 'retained',
            expiresAt: null,
            images: [
              { id: 'a', ref: undefined, filename: 'a.jpg', src: '/img/a.jpg', width: 4000, height: 3000, alt: '', placeholder: '', variants: [{ src: '/img/a-sm.jpg', width: 400, format: 'image/jpeg' }] },
            ],
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const titles = [...container.querySelectorAll('.admin-gallery-title')].map((el) => el.textContent)
      // The cloud gallery leads the list — it is the thing the owner came to see.
      expect(titles.indexOf('kashmir, in winter')).toBeGreaterThanOrEqual(0)
      expect(titles.indexOf('kashmir, in winter')).toBeLessThan(titles.indexOf(TITLE))

      const card = container.querySelector<HTMLElement>('.admin-gallery-card')!
      expect(card.querySelector('.admin-gallery-count')?.textContent).toBe('(1 photo)')
      expect(card.querySelector('.admin-gallery-caption')?.textContent).toBe('Dropbox · cloud gallery')
      // Server-relative previews arrive rewritten against the API origin.
      expect(card.querySelector('img')?.getAttribute('src')).toBe('https://manorama.xyz/img/a-sm.jpg')
      // A cloud card opens the public gallery; Details stays local-only.
      expect(byText(card, 'Open')).toBeDefined()
      expect(card.querySelector(`[aria-label="Details kashmir, in winter"]`)).toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a failed account fetch leaves the local catalogue untouched', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
    try {
      const container = await mount(true)
      expect(container.querySelector('.desktop-source-note')?.textContent).toContain('could not be loaded')
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
    } finally {
      globals.fetch = defaultFetch
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

  test('details mounts from a card with exactly the local actions and no banned surfaces', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()

    const details = container.querySelector('[data-screen="local-details"]')
    expect(details).not.toBeNull()
    expect(details?.querySelector('.m-owner-heading h1')?.textContent).toBe(TITLE)
    expect(details?.querySelector('.m-owner-heading')?.textContent).toContain('2 photographs · Folder on this Mac')
    for (const label of ['Open', 'Publish/Share', 'Name', 'Read folder again', 'Remove from Library']) {
      expect(row(container, label)).not.toBeNull()
    }

    const html = container.innerHTML
    // Local paths and filenames never surface; no invented public/provider/vault
    // surfaces ride along with the details view.
    expect(html).not.toContain(ROOT_PATH)
    expect(html).not.toContain('/Volumes/')
    expect(html).not.toContain('MS201810-Italy0005.jpg')
    expect(html).not.toContain('manorama.xyz')
    expect(html).not.toContain('Dropbox')
    expect(html).not.toContain('Google Drive')
    expect(html).not.toContain('Vault')
    expect(html).not.toContain('Offline')
    expect(html).not.toContain('Reorder')
  })

  test('a deep-linked details id opens details at launch and Back clears the URL', async () => {
    dom.window.history.replaceState(null, '', `http://localhost/?details=${GALLERY_ID}`)
    const container = await mount(true)
    expect(container.querySelector('[data-screen="local-details"]')).not.toBeNull()

    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
  })

  test('Back from a pushed details state returns to the library', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBe(GALLERY_ID)

    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
  })

  test('Open from details launches the shared viewer', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Open') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-stage')).not.toBeNull()
  })

  test('a rename persists to the catalogue file, syncs, and updates the card', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()

    let fetchCount = 0
    const originalFetch = globals.fetch as typeof fetch
    globals.fetch = ((...args: unknown[]) => {
      fetchCount += 1
      return originalFetch(...(args as Parameters<typeof fetch>))
    }) as unknown as typeof fetch
    const before = fetchCount

    ;(row(container, 'Name') as HTMLButtonElement).click()
    await settle()
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
    setInput(input, 'Vernazza')
    await settle()
    pressEnter(input)
    await settle()
    expect(container.textContent).toContain('Name saved')

    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    expect(container.querySelector('.admin-gallery-title')?.textContent).toBe('Vernazza')

    const saved = JSON.parse(files['catalogue.json']) as { galleries: { title: string }[] }
    expect(saved.galleries[0]?.title).toBe('Vernazza')
    // The renamed gallery is handed back to the sync lane.
    expect(fetchCount).toBeGreaterThan(before)

    globals.fetch = originalFetch
  })

  test('Read folder again rescans the source and updates details and card counts', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()

    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    ;(row(container, 'Read folder again') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('.m-owner-heading')?.textContent).toContain('3 photographs')
    expect(container.textContent).toContain('Read just now')

    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.querySelector('.admin-gallery-count')?.textContent).toBe('(3 photos)')
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(3)
  })

  test('confirmed remove returns to the library and touches only the catalogue entry', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Remove from Library') as HTMLButtonElement).click()
    await settle()

    expect(container.textContent).toContain(`Remove “${TITLE}”?`)
    expect(container.textContent).toContain('untouched')
    sheetButton(container, 'Remove from Library')!.click()
    await settle()

    // Back on the library; the card and the catalogue entry are gone.
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: unknown[] }
    expect(saved.galleries).toHaveLength(0)

    // No fs mutation of the source was ever requested.
    const fsMutations = invokeLog.filter((command) =>
      /plugin:fs\|(remove|remove_dir|remove_file|rename|trash|delete|unlink)/.test(command),
    )
    expect(fsMutations).toHaveLength(0)
  })

  test('share opens in the shared sheet from Details and a plain close resets it', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()

    const host = container.querySelector('.m-sheet-host')
    expect(host).not.toBeNull()
    expect(host?.querySelector('.desktop-share--sheet')).not.toBeNull()
    expect(host?.querySelector('.desktop-share-header')).toBeNull()
    expect(host?.textContent).toContain('Dropbox')
    expect(host?.textContent).toContain('Google Drive')
    // Not uploading — the shared sheet is dismissible.
    expect(host?.querySelector('button[aria-label="Close"]')).not.toBeNull()

    host?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.m-sheet-host')).toBeNull()
    expect(container.querySelector('[data-screen="local-details"]')).not.toBeNull()

    // Reopening starts from a clean choose step.
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('.m-sheet-host .desktop-share--sheet')).not.toBeNull()
    expect(container.textContent).toContain('nothing uploads until you confirm')
  })

  test('dismissing while connecting cancels the pending provider connection', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()

    const connectButton = byText(container, 'Connect')
    expect(connectButton).not.toBeUndefined()
    connectButton!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')

    container.querySelector<HTMLButtonElement>('.m-sheet-host button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.m-sheet-host')).toBeNull()

    // The cancelled connect is settled, so a fresh attempt starts clean instead
    // of reporting a stale pending flow.
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()
    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    // Leave no pending connect behind for later tests: dismissal settles it.
    container.querySelector<HTMLButtonElement>('.m-sheet-host button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.m-sheet-host')).toBeNull()
  })

  test('the hosted sheet cannot be dismissed during an upload', async () => {
    const container = await mount(true, {
      dropbox: { accessToken: 'token', expiresAt: Date.now() + 1e12 },
    })
    // The read gate is consulted only when the upload starts, so it can be
    // armed after mount (installTauri resets it).
    readFileGate = deferred()
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()

    byText(container, 'Use Dropbox')!.click()
    await settle()
    expect(container.textContent).toContain('Upload 2 originals to Dropbox')
    byText(container, 'Upload and publish')!.click()
    await settle()

    // In flight: the upload is gated on the hung read, so the step is live.
    expect(container.textContent).toContain('Preparing the upload…')
    expect(container.querySelector('.m-sheet-host button[aria-label="Close"]')).toBeNull()

    // Escape and the scrim are both inert while uploading.
    const esc = new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Parameters<typeof dom.document.dispatchEvent>[0]
    dom.document.dispatchEvent(esc)
    await settle()
    expect(container.querySelector('.m-sheet-host')).not.toBeNull()
    container.querySelector<HTMLElement>('.m-sheet-host .m-scrim')!.click()
    await settle()
    expect(container.querySelector('.m-sheet-host')).not.toBeNull()

    // Releasing the read lands the flow in error — and only then is the sheet
    // dismissible again.
    readFileGate!.reject(new Error('halt'))
    readFileGate = null
    await settle()
    expect(container.querySelector('.m-sheet-host [role="alert"]')).not.toBeNull()
    expect(container.querySelector('.m-sheet-host button[aria-label="Close"]')).not.toBeNull()
  })

  test('navigating history while connecting settles the pending provider connection', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()

    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')

    // Back (popstate) while the connect is pending: the sheet and details go,
    // and the pending flow is settled exactly like the sheet's own Close.
    dom.window.history.replaceState(null, '', 'http://localhost/')
    dom.window.dispatchEvent(new dom.Event('popstate'))
    await settle()
    expect(container.querySelector('.m-sheet-host')).toBeNull()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()

    // The cancelled connect is settled, so a fresh attempt starts clean instead
    // of reporting a stale pending flow.
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()
    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    // Leave no pending connect behind for later tests: dismissal settles it.
    container.querySelector<HTMLButtonElement>('.m-sheet-host button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.m-sheet-host')).toBeNull()
  })

  test('navigating history during an upload leaves details and the sheet mounted', async () => {
    const container = await mount(true, {
      dropbox: { accessToken: 'token', expiresAt: Date.now() + 1e12 },
    })
    // The read gate is consulted only when the upload starts, so it can be
    // armed after mount (installTauri resets it).
    readFileGate = deferred()
    detailsButton(container)!.click()
    await settle()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()
    byText(container, 'Use Dropbox')!.click()
    await settle()
    byText(container, 'Upload and publish')!.click()
    await settle()
    expect(container.textContent).toContain('Preparing the upload…')

    // History navigation while the upload is gated must not dismiss the
    // surface: details and the sheet stay, Close stays unavailable, and the
    // details URL is restored so Back can still leave once the upload settles.
    dom.window.history.replaceState(null, '', 'http://localhost/')
    dom.window.dispatchEvent(new dom.Event('popstate'))
    await settle()

    expect(container.querySelector('[data-screen="local-details"]')).not.toBeNull()
    expect(container.querySelector('.m-sheet-host')).not.toBeNull()
    expect(container.querySelector('.m-sheet-host button[aria-label="Close"]')).toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBe(GALLERY_ID)

    // Releasing the read lands the flow in error exactly once — no restart,
    // no duplicate upload phase.
    readFileGate!.reject(new Error('halt'))
    readFileGate = null
    await settle()
    expect(container.querySelector('.m-sheet-host [role="alert"]')).not.toBeNull()
    expect(container.querySelector('.m-sheet-host button[aria-label="Close"]')).not.toBeNull()
    expect(container.textContent).not.toContain('nothing uploads until you confirm')

    // With the upload settled, Back closes details normally.
    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
  })

  test('a failed source scan reports the error and marks the source unavailable', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()

    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'plugin:fs|read_dir' && String(args?.path) === ROOT_PATH) {
        throw new Error('The card is not mounted')
      }
      return originalInvoke(command, args)
    }

    ;(row(container, 'Read folder again') as HTMLButtonElement).click()
    await settle()

    // The error surfaces; no success note; the prior record/count stays and
    // a genuine source read failure may flag the source unavailable.
    expect(container.textContent).toContain('The card is not mounted')
    expect(container.textContent).not.toContain('Read just now')
    expect(container.querySelector('.m-owner-heading')?.textContent).toContain('2 photographs')
    expect(container.querySelector('[data-availability="unavailable"]')).not.toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(2)
  })

  test('a failed private-store write during rescan keeps the old count and availability', async () => {
    const container = await mount(true)
    detailsButton(container)!.click()
    await settle()

    // A new photo appears on disk — the scan would succeed; only the write fails.
    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'write_private_file') throw new Error('The disk is full')
      return originalInvoke(command, args)
    }

    ;(row(container, 'Read folder again') as HTMLButtonElement).click()
    await settle()

    // The error surfaces; no success note; the prior record/count stays on
    // screen and the still-available source is not flagged unavailable.
    expect(container.textContent).toContain('The disk is full')
    expect(container.textContent).not.toContain('Read just now')
    expect(container.querySelector('.m-owner-heading')?.textContent).toContain('2 photographs')
    expect(container.querySelector('[data-availability="available"]')).not.toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(2)
  })
})
