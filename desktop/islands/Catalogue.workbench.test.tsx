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
let invokeCalls: { command: string; args?: Record<string, unknown> }[]
let pickedFolder: string | null

const installTauri = (signedIn: boolean, providerTokens?: Record<string, unknown>, tier: 'free' | 'pro' = 'pro') => {
  files = {
    'catalogue.json': JSON.stringify({ version: 1, deviceId: DEVICE_ID, deviceLabel: 'This Mac', galleries: [record] }),
    ...(signedIn ? { 'session.json': JSON.stringify({ token: 'token', ownerSlug: 'thecontrarian', tier }) } : {}),
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
  invokeCalls = []
  pickedFolder = null
  ;(dom as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      invokeLog.push(command)
      invokeCalls.push({ command, args })
      if (command === 'read_private_file') return files[String(args?.name)] ?? null
      if (command === 'write_private_file') {
        files[String(args?.name)] = String(args?.contents)
        return null
      }
      if (command === 'delete_private_file') {
        delete files[String(args?.name)]
        return null
      }
      // `pick_gallery_root` — the folder dialog answers whatever the test staged.
      if (command === 'pick_gallery_root') return pickedFolder
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

const mount = async (signedIn: boolean, providerTokens?: Record<string, unknown>, tier: 'free' | 'pro' = 'pro'): Promise<HTMLElement> => {
  installTauri(signedIn, providerTokens, tier)
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

/** An item inside the currently open card ··· sheet, by visible text. */
const menuItem = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLElement>('.m-sheet .lib-menu > *')]
    .find((el) => el.textContent?.trim() === text)

/** Details lives one level deep now: the card ··· menu → Gallery details. */
const openCardDetails = async (container: HTMLElement) => {
  container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
  await settle()
  menuItem(container, 'Gallery details')!.click()
  await settle()
}

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

    // The web Library's anatomy: the shared mark heads the left rail, then
    // a Library + actions row, with the cards scrolling beside.
    const galleries = container.querySelector('#galleries-heading')
    expect(galleries?.textContent).toBe('Library')
    expect(container.querySelector('.admin-brand-mark')?.getAttribute('src')).toBe('/manorama-merged-logo.png')
    const addButton = byText(container, '+ Add Gallery')
    expect(addButton).toBeDefined()
    const html = container.innerHTML
    expect(html.indexOf('admin-rail')).toBeLessThan(html.indexOf('galleries-heading'))
    expect(html.indexOf('admin-library-heading')).toBeLessThan(html.indexOf('lib-list'))

    // The gear in the rail's heading opens the shared Settings surface —
    // the old slide-in account drawer is gone, replaced by the web's groups.
    const tab = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    expect(tab?.getAttribute('aria-label')).toBe('Settings')
    expect(container.querySelector('#admin-account-drawer')).toBeNull()
    expect(container.querySelector('.web-settings')).toBeNull()
  })

  test('the theme action flips the shared class and key', async () => {
    const container = await mount(true)
    expect(dom.document.documentElement.classList.contains('light')).toBe(false)

    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click()
    await settle()
    // Theme lives in the Settings surface's Segmented, same as the web.
    const light = [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((el) => el.textContent === 'Light')!
    expect(light).not.toBeUndefined()
    light.click()
    await settle()

    expect(dom.document.documentElement.classList.contains('light')).toBe(true)
    expect(dom.localStorage.getItem('manorama:theme')).toBe('light')
    expect(light.getAttribute('aria-checked')).toBe('true')

    const dark = [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((el) => el.textContent === 'Dark')!
    dark.click()
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
    expect(card.querySelector('.lib-card-title')?.textContent).toBe(TITLE)
    expect(card.querySelector('.lib-card-sub')?.textContent).toBe('2 photographs · Folder on this Mac')

    // The sub-line names the source kind only — the root path never renders as
    // metadata (the thumbnail src is the asset protocol referencing originals
    // in place, which is separate and intended).
    expect(card.querySelector('.lib-card-sub')?.textContent).toContain('Folder on this Mac')
    expect(card.textContent).not.toContain(ROOT_PATH)

    const strip = card.querySelector('.admin-gallery-strip')!
    expect(strip.tagName).toBe('UL')
    const framesInStrip = [...strip.querySelectorAll<HTMLElement>('.admin-gallery-strip-item')]
    expect(framesInStrip).toHaveLength(2)
    expect(framesInStrip[0].tagName).toBe('LI')
    expect(framesInStrip[0].classList.contains('is-active')).toBe(false)
    expect(framesInStrip[1].classList.contains('is-active')).toBe(false)
    expect(framesInStrip[1].querySelector('button')?.getAttribute('aria-label')).toBe(`Open MS201810-Italy0100.jpg — photograph 2 of 2 in ${TITLE}`)
    // Originals are referenced in place through the asset protocol: no copy,
    // no derivative, no thumbnail.
    expect(strip.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost${record.items[0].path}`)

    // The ··· menu replaces the four v1 icon verbs; Details sits behind it.
    expect(card.querySelector(`[aria-label="${TITLE} actions"]`)).not.toBeNull()
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
      // The stored session says 'thecontrarian'; the account row says the
      // owner renamed to 'fresh-name'. Open must use the fresh slug.
      if (path.endsWith('/api/account')) {
        return new Response(JSON.stringify({ ownerSlug: 'fresh-name' }), { status: 200 })
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
      // Section order is Pinned → Local galleries → Your galleries; the
      // account card lands in Your galleries after the local strip.
      const headings = [...container.querySelectorAll<HTMLElement>('.lib-section-title')].map((el) => el.textContent)
      expect(headings.indexOf('Local galleries')).toBeGreaterThanOrEqual(0)
      expect(headings.indexOf('Local galleries')).toBeLessThan(headings.indexOf('Your galleries'))
      const localSection = container.querySelector<HTMLElement>('[aria-labelledby="local-galleries-title"]')!
      const accountSection = container.querySelector<HTMLElement>('[aria-labelledby="lib-compact-title"]')!
      expect(localSection).not.toBeNull()
      expect(accountSection).not.toBeNull()
      expect(localSection.textContent).toContain(TITLE)
      expect(accountSection.querySelector('.lib-compact-card .lib-card-title')?.textContent).toBe('kashmir, in winter')

      const card = container.querySelector<HTMLElement>('.lib-compact-card')!
      expect(card.querySelector('.lib-card-sub')?.textContent).toBe('1 photograph from Dropbox')
      // Server-relative previews arrive rewritten against the API origin.
      expect(card.querySelector('img')?.getAttribute('src')).toBe('https://manorama.xyz/img/a-sm.jpg')
      // The ··· menu carries the web's full range; Details stays local-only.
      card.querySelector<HTMLButtonElement>(`[aria-label="kashmir, in winter actions"]`)!.click()
      await settle()
      for (const item of ['Pin gallery', 'Share link', 'Gallery settings', 'Reorder photographs', 'Open source', 'Refresh gallery contents', 'Remove gallery']) {
        expect(menuItem(container, item)).toBeDefined()
      }
      expect(menuItem(container, 'Gallery details')).toBeUndefined()
      expect(menuItem(container, 'Open')).toBeUndefined()

      // The card itself opens — the manifest fetch fails in this mock, so the
      // fallback hands the renamed owner's URL to the system browser.
      card.querySelector<HTMLElement>('.lib-card-title')!.click()
      await settle()
      const opener = invokeCalls.find((call) => call.command === 'plugin:opener|open_url')
      expect(opener?.args?.url).toBe('https://manorama.xyz/fresh-name/kashmir')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a failed device feed still shows the cloud galleries', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/device-galleries')) return new Response('down', { status: 500 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '',
            imageCount: 1, sourceUrl: 'https://www.dropbox.com/scl/fo/x',
            createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images: [],
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const titles = [...container.querySelectorAll('.lib-card-title')].map((el) => el.textContent)
      // The device feed died; the account read survived it.
      expect(titles).toContain('kashmir, in winter')
      expect(container.querySelector('.desktop-toast-stack .admin-toast')?.textContent).toContain('could not be loaded')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('cloud galleries render while the device feed is still in flight', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      // The device feed hangs forever — the cloud card must not wait on it.
      if (path.endsWith('/api/device-galleries')) return new Promise<Response>(() => {})
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '',
            imageCount: 1, sourceUrl: 'https://www.dropbox.com/scl/fo/x',
            createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images: [],
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const titles = [...container.querySelectorAll('.lib-card-title')].map((el) => el.textContent)
      expect(titles).toContain('kashmir, in winter')
      expect(container.querySelector('.desktop-toast-stack .admin-toast')).toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a failed slug refresh warns and falls back to the saved slug', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/account')) return new Response('down', { status: 500 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '',
            imageCount: 1, sourceUrl: 'https://www.dropbox.com/scl/fo/x',
            createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images: [],
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const notes = [...container.querySelectorAll('.desktop-toast-stack .admin-toast')].map((el) => el.textContent)
      expect(notes.some((text) => text?.includes('older account address'))).toBe(true)

      // The card itself opens — the manifest fetch fails in this mock, so the
      // fallback hands the stored session slug's URL to the system browser.
      const title = [...container.querySelectorAll<HTMLElement>('.lib-card-title')]
        .find((el) => el.textContent === 'kashmir, in winter')!
      title.click()
      await settle()
      const opener = invokeCalls.find((call) => call.command === 'plugin:opener|open_url')
      expect(opener?.args?.url).toBe('https://manorama.xyz/thecontrarian/kashmir')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a failed account fetch leaves the local catalogue untouched', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async () => new Response('down', { status: 500 })) as unknown as typeof fetch
    try {
      const container = await mount(true)
      expect(container.querySelector('.desktop-toast-stack .admin-toast')?.textContent).toContain('could not be loaded')
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
    await openCardDetails(container)
    await settle()

    const details = container.querySelector('[data-screen="local-details"]')
    expect(details).not.toBeNull()
    expect(details?.querySelector('.d-name')?.textContent).toBe(TITLE)
    expect(details?.querySelector('.d-head')?.textContent).toContain('2 photographs · Folder on this Mac')
    for (const label of ['Open', 'Publish', 'Name', 'Refresh gallery contents', 'Remove from Library']) {
      expect(row(container, label)).not.toBeNull()
    }

    // Local paths and filenames never surface in the copy; the rail's own
    // asset URLs and photograph labels are exempt, the same way the Library
    // card rail's are. No invented public/provider/vault surfaces ride along.
    const copy = container.cloneNode(true) as HTMLElement
    copy.querySelector('.d-rail')?.remove()
    const html = copy.innerHTML
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
    await openCardDetails(container)
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Open') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-stage')).not.toBeNull()
  })

  test('a rename persists to the catalogue file, syncs, and updates the card', async () => {
    const container = await mount(true)
    await openCardDetails(container)
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
    expect(container.querySelector('.lib-card-title')?.textContent).toBe('Vernazza')

    const saved = JSON.parse(files['catalogue.json']) as { galleries: { title: string }[] }
    expect(saved.galleries[0]?.title).toBe('Vernazza')
    // The renamed gallery is handed back to the sync lane.
    expect(fetchCount).toBeGreaterThan(before)

    globals.fetch = originalFetch
  })

  test('Refresh gallery contents rescans the source and updates details and card counts', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()

    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    ;(row(container, 'Refresh gallery contents') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('.d-head')?.textContent).toContain('3 photographs')
    expect(container.textContent).toContain('Read just now')

    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    await settle()
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.querySelector('.lib-card-sub')?.textContent).toBe('3 photographs · Folder on this Mac')
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(3)
  })

  test('confirmed remove returns to the library and touches only the catalogue entry', async () => {
    const container = await mount(true)
    await openCardDetails(container)
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    ;(row(container, 'Publish') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('.m-sheet-host .desktop-share--sheet')).not.toBeNull()
    expect(container.textContent).toContain('nothing uploads until you confirm')
  })

  test('dismissing while connecting cancels the pending provider connection', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Publish') as HTMLButtonElement).click()
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
    await openCardDetails(container)
    await settle()

    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'plugin:fs|read_dir' && String(args?.path) === ROOT_PATH) {
        throw new Error('The card is not mounted')
      }
      return originalInvoke(command, args)
    }

    ;(row(container, 'Refresh gallery contents') as HTMLButtonElement).click()
    await settle()

    // The error surfaces; no success note; the prior record/count stays and
    // a genuine source read failure may flag the source unavailable.
    expect(container.textContent).toContain('The card is not mounted')
    expect(container.textContent).not.toContain('Read just now')
    expect(container.querySelector('.d-head')?.textContent).toContain('2 photographs')
    expect(container.querySelector('[data-availability="unavailable"]')).not.toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(2)
  })

  test('a failed private-store write during rescan keeps the old count and availability', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()

    // A new photo appears on disk — the scan would succeed; only the write fails.
    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'write_private_file') throw new Error('The disk is full')
      return originalInvoke(command, args)
    }

    ;(row(container, 'Refresh gallery contents') as HTMLButtonElement).click()
    await settle()

    // The error surfaces; no success note; the prior record/count stays on
    // screen and the still-available source is not flagged unavailable.
    expect(container.textContent).toContain('The disk is full')
    expect(container.textContent).not.toContain('Read just now')
    expect(container.querySelector('.d-head')?.textContent).toContain('2 photographs')
    expect(container.querySelector('[data-availability="available"]')).not.toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(2)
  })

  test('+ Add Gallery opens a chooser between a local folder and a cloud link', async () => {
    const container = await mount(true)
    byText(container, '+ Add Gallery')!.click()
    await settle()
    expect(row(container, 'A folder on this Mac')).toBeDefined()
    expect(row(container, 'A shared cloud link')).toBeDefined()
  })

  test('signed out shows the welcome surface, so the chooser stays out of reach', async () => {
    // Cloud links bind to the account — with no session the Library itself is
    // gated behind sign-in, and the disabled cloud row is belt-and-braces
    // defense for a surface the owner cannot reach.
    const container = await mount(false)
    await settle()
    expect(byText(container, '+ Add Gallery')).toBeUndefined()
    expect(row(container, 'A shared cloud link')).toBeUndefined()
  })

  test('a shared cloud link verifies against the scan endpoint, then creates the gallery', async () => {
    const cloudGallery = {
      id: 'cloud-1',
      slug: 'italy-amore',
      title: 'Italy, amore mio',
      sourceUrl: 'https://www.dropbox.com/scl/fo/abc/def',
      caption: null,
      imageCount: 4,
      itemCount: 4,
      images: [],
      retention: 'permanent',
      expiresAt: null,
      pinnedAt: '2026-11-08T00:00:00.000Z',
      deviceLabel: null,
      layout: 'compact',
    }
    const scanCalls: Record<string, unknown>[] = []
    const createCalls: Record<string, unknown>[] = []
    const seenAuth: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      const path = String(url)
      const method = init?.method ?? 'GET'
      if (init?.headers?.Authorization) seenAuth.push(init.headers.Authorization)
      if (method === 'POST' && path.endsWith('/api/galleries/scan')) {
        scanCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ scan: { title: 'Italy, amore mio' } }), { status: 200 })
      }
      if (method === 'POST' && path.endsWith('/api/galleries')) {
        createCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ gallery: cloudGallery }), { status: 200 })
      }
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({ galleries: [cloudGallery] }), { status: 200 })
      }
      if (path.endsWith('/api/device-galleries')) {
        return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      }
      if (path.endsWith('/api/account')) {
        return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      byText(container, '+ Add Gallery')!.click()
      await settle()
      ;(row(container, 'A shared cloud link') as HTMLButtonElement).click()
      await settle()

      const input = container.querySelector<HTMLInputElement>('.m-sheet input[type="url"]')!
      expect(input).not.toBeNull()
      const url = 'https://www.dropbox.com/scl/fo/abc/def'
      setInput(input, url)
      // A committed paste verifies immediately — no waiting on the debounce.
      input.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event)
      await settle()

      expect(scanCalls).toHaveLength(1)
      expect(scanCalls[0]).toEqual({ url })
      expect(seenAuth).toContain('Bearer token')
      // A clean scan reveals the optional fields, name pre-filled.
      expect(container.querySelector('.m-sheet textarea')).not.toBeNull()
      expect(container.querySelector<HTMLInputElement>('.m-sheet input[type="text"]')?.value).toBe('Italy, amore mio')

      sheetButton(container, 'Create gallery')!.click()
      await settle()
      expect(createCalls).toHaveLength(1)
      expect(createCalls[0]?.url).toBe(url)
      expect(createCalls[0]?.title).toBe('Italy, amore mio')
      // The sheet closed, the list refetched, and the card landed.
      expect(container.querySelector('.m-sheet input[type="url"]')).toBeNull()
      expect(container.textContent).toContain('Italy, amore mio added.')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('an unreadable cloud link reports the provider error, keeping the sheet open', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      const path = String(url)
      if (init?.method === 'POST' && path.endsWith('/api/galleries/scan')) {
        return new Response(JSON.stringify({ error: 'That shared link has expired' }), { status: 422 })
      }
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      byText(container, '+ Add Gallery')!.click()
      await settle()
      ;(row(container, 'A shared cloud link') as HTMLButtonElement).click()
      await settle()
      const input = container.querySelector<HTMLInputElement>('.m-sheet input[type="url"]')!
      setInput(input, 'https://www.dropbox.com/scl/fo/dead/link')
      input.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event)
      await settle()
      expect(container.querySelector('.m-sheet .m-error')?.textContent).toBe('That shared link has expired')
      // No optional fields, sheet stays open — the typo is fixable in place.
      expect(container.querySelector('.m-sheet textarea')).toBeNull()
      expect(container.querySelector('.m-sheet input[type="url"]')).not.toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('the rail keeps only the tier line — device and sync chatter is gone', async () => {
    const container = await mount(true, undefined, 'free')
    await settle()
    const rail = container.querySelector('.admin-rail')!
    expect(rail.textContent).toContain('Free User')
    const upgrade = rail.querySelector<HTMLAnchorElement>('a.admin-upgrade-link')
    expect(upgrade?.textContent).toBe('Upgrade to Visionary?')
    expect(upgrade?.getAttribute('href')).toBe('mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade')
    expect(rail.textContent).not.toContain('This Mac')
    expect(rail.textContent).not.toContain('Catalogue synced')
    expect(rail.querySelector('.desktop-toast-stack .admin-toast')).toBeNull()
  })

  test('a folder add reports in a toast at the surface edge, never in the rail', async () => {
    const container = await mount(true)
    // Staged after mount — installTauri re-arms the folder dialog as empty.
    pickedFolder = '/Photos/empty'
    byText(container, '+ Add Gallery')!.click()
    await settle()
    ;(row(container, 'A folder on this Mac') as HTMLButtonElement).click()
    await settle()
    const toast = container.querySelector<HTMLElement>('.desktop-toast-stack .admin-toast')
    expect(toast?.textContent).toContain('That folder has no photos')
    const rail = container.querySelector('.admin-rail')!
    expect(rail.textContent).not.toContain('That folder has no photos')
    expect(rail.querySelector('.admin-toast')).toBeNull()
  })

  test('the gear opens the shared Settings with the web groups and the Mac device rows', async () => {
    const container = await mount(true)
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click()
    await settle()
    const screen = container.querySelector<HTMLElement>('.web-settings')!
    expect(screen).not.toBeNull()
    expect(screen.getAttribute('data-screen')).toBe('settings')
    const groups = [...screen.querySelectorAll('.m-actiongroup-label')].map((el) => el.textContent)
    for (const label of ['Account', 'Sign-in methods', 'Allowance', 'Appearance', 'This Mac', 'About', 'Sign out and delete']) {
      expect(groups).toContain(label)
    }
    // The device group carries the real catalogue state.
    expect(screen.textContent).toContain('Sync now')
    expect(screen.textContent).toContain('title and photograph count')
    // The plan group names the tiers and all three gallery counts.
    expect(screen.textContent).toContain('Visionary')
    expect(screen.textContent).toContain('Permanent galleries')
    expect(screen.textContent).toContain('Temporary galleries')
    expect(screen.textContent).toContain('Local galleries')
    // The byline is gone — the About group carries a plain copyright notice.
    expect(screen.textContent).toContain('© 2026 Mahesh Shantaram / thecontrarian.in')
    // Sync feedback appears while the sync runs and reports its outcome —
    // the PUT is held open so the syncing state can be observed at rest.
    const defaultFetch = globals.fetch
    let releaseSync = () => {}
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      const path = String(url)
      if (init?.method === 'PUT' && path.includes('/api/device-galleries/')) {
        await new Promise<void>((resolve) => { releaseSync = resolve })
        return new Response('{}', { status: 200 })
      }
      return (defaultFetch as typeof fetch)(url, init)
    }) as unknown as typeof fetch
    expect(screen.querySelector('.desktop-sync-progress')).toBeNull()
    const syncButton = [...screen.querySelectorAll('button')].find((b) => b.textContent === 'Sync now')!
    syncButton.click()
    await settle()
    expect(screen.querySelector('.desktop-sync-progress')).not.toBeNull()
    releaseSync()
    await settle()
    globals.fetch = defaultFetch
    expect(screen.querySelector('.desktop-sync-progress')).toBeNull()
    expect(screen.textContent).toContain('Up to date')
    // Back returns to the Library.
    const back = [...screen.querySelectorAll('button')].find((b) => b.textContent?.includes('Back'))!
    back.click()
    await settle()
    expect(container.querySelector('.web-settings')).toBeNull()
  })

  test('an encrypted cloud gallery opens in-app — never on a locked browser page', async () => {
    const locked = {
      id: 'gallery-0000-0000-0000-000000000001',
      slug: 'locked-album',
      title: 'Vault album',
      sourceUrl: 'https://mega.nz/folder/AbC12345#kEY12345',
      caption: null,
      imageCount: 0,
      itemCount: 0,
      images: [],
      retention: 'permanent',
      expiresAt: null,
      pinnedAt: null,
      deviceLabel: null,
      layout: 'compact',
    }
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [locked] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.includes('/api/gallery/')) {
        return new Response(JSON.stringify({
          manifest: { slug: 'locked-album', title: 'Vault album', caption: '', date: '', images: [] },
          settings: null,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const title = [...container.querySelectorAll<HTMLElement>('.lib-card-title')].find((el) => el.textContent === 'Vault album')!
      expect(title).not.toBeUndefined()
      title.click()
      await settle()
      // The app mounted the shared encrypted surface — the system browser
      // was never asked to open the gallery.
      expect(invokeCalls.some((call) => call.command === 'plugin:opener|open_url')).toBe(false)
      expect(container.querySelector('.encrypted-locked')).not.toBeNull()
      expect(container.textContent).toContain('This gallery is locked on this device')
      expect(container.textContent).toContain('provider link')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  const accountGallery = {
    slug: 'kashmir',
    title: 'kashmir, in winter',
    sourceUrl: 'https://www.dropbox.com/scl/fo/x',
    caption: '',
    imageCount: 0,
    itemCount: 0,
    images: [],
    retention: 'retained' as const,
    expiresAt: null,
    pinnedAt: null,
    id: 'gallery-0000-0000-0000-000000000009',
  }
  const withGallery = (calls: { url: string; method?: string; body?: string }[]) => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const path = String(url)
      calls.push({ url: path, method: init?.method, body: init?.body })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [accountGallery] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/pin') || path.endsWith('/refresh')) return new Response(JSON.stringify({}), { status: 200 })
      if (init?.method === 'DELETE') return new Response(JSON.stringify({}), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    return () => { globals.fetch = defaultFetch }
  }

  test('the account menu pins and removes through the web API calls', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const restore = withGallery(calls)
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'Pin gallery')!.click()
      await settle()
      const pin = calls.find((call) => call.url.endsWith('/api/galleries/kashmir/pin'))
      expect(pin?.method).toBe('PATCH')
      expect(pin?.body).toBe('{"pinned":true}')

      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'Remove gallery')!.click()
      await settle()
      // The removal is a confirm step inside the same sheet — nothing is
      // deleted by the first tap alone.
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
      menuItem(container, 'Remove gallery')!.click()
      await settle()
      const del = calls.find((call) => call.method === 'DELETE' && call.url.endsWith('/api/galleries/kashmir'))
      expect(del).toBeDefined()
    } finally {
      restore()
    }
  })

  test('the account menu opens the shared share sheet and gallery settings', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const restore = withGallery(calls)
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'Share link')!.click()
      await settle()
      expect(container.querySelector('.m-share-address')?.textContent).toContain('manorama.xyz/thecontrarian/kashmir')
      container.querySelector<HTMLButtonElement>('.m-sheet [aria-label="Close"], .m-sheet .m-sheet-close')?.click()
      await settle()

      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'Gallery settings')!.click()
      await settle()
      // The shared owner panel mounts — the same rows the web sheet hosts.
      expect(container.querySelector('.m-owner-panel')).not.toBeNull()
    } finally {
      restore()
    }
  })

  test('the local card menu carries details, rescan, and a guarded remove', async () => {
    const container = await mount(true)
    container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
    await settle()
    for (const item of ['Gallery details', 'Refresh gallery contents', 'Remove gallery']) {
      expect(menuItem(container, item)).toBeDefined()
    }
    // Remove confirms inside the sheet before the catalogue entry goes.
    menuItem(container, 'Remove gallery')!.click()
    await settle()
    expect(container.textContent).toContain('The folder on this Mac is untouched')
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
  })

  test('a Free account sees no Local galleries — the folder choice locks to Visionary', async () => {
    const writes: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      const path = String(url)
      if (path.includes('/api/device-galleries') && init?.method === 'PUT') writes.push(path)
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian', tier: 'free' }), { status: 200 })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true, undefined, 'free')
      await settle()
      // The catalogue still holds the gallery — the rule hides it, it is not deleted.
      expect(container.querySelector('#local-galleries-title')).toBeNull()
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
      expect(container.querySelector('.admin-rail')?.textContent).toContain('Free User')
      // And nothing is synced upstream either — the rows are the device's own.
      expect(writes).toEqual([])

      byText(container, '+ Add Gallery')!.click()
      await settle()
      const folder = row(container, 'A folder on this Mac') as HTMLButtonElement
      expect(folder.disabled).toBe(true)
      expect(folder.textContent).toContain('Visionary')
      expect((row(container, 'A shared cloud link') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a downgrade clears the Local galleries the moment the account read lands', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian', tier: 'free' }), { status: 200 })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      // The stored session still says Visionary — the account row says Free.
      const container = await mount(true, undefined, 'pro')
      await settle()
      expect(container.querySelector('#local-galleries-title')).toBeNull()
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
      // The demotion is persisted, so the next launch stays honest.
      expect(JSON.parse(files['session.json']!).tier).toBe('free')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a deep-linked local gallery does not open for a Free account', async () => {
    dom.window.history.replaceState(null, '', `http://localhost/?details=${GALLERY_ID}`)
    const container = await mount(true, undefined, 'free')
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
  })
})
