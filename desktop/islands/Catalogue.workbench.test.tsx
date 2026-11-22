import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { unmountTracker } from '../../test/unmount'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import { hashPassword } from '../lib/library-prefs'
import { vaultFilePathIdentity } from '../../native/lib/vault'
import { offlineGalleryId } from '../../native/lib/offline-gallery'
import { coverEntryId } from '../../native/lib/thumbs'
import { desktopOfflineStore } from '../lib/offline-gallery'
import Catalogue from './Catalogue'

/**
 * The catalogue's account pane is a lifecycle feature — open, focus, theme,
 * close — so it is exercised through a mounted island rather than a stringified
 * render. The Tauri IPC the island talks to is stubbed at the one place the
 * official API reads it (`window.__TAURI_INTERNALS__`), so the island runs its
 * real launch path: restore the session, read the catalogue, probe the sources.
 *
 * The integration contract is proved here end-to-end: the card menu opens
 * final Gallery Settings or the shared publish sheet directly; history/Back
 * work; Open, rename, rescan, confirmed remove and publish run through the real
 * handlers; and the shared sheet is non-dismissible during upload while
 * dismissing mid-connect cancels the pending provider connection.
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

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()
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
/** This Mac's row in the account's device list — anonymous, slot 0. */
const selfDevice = {
  id: DEVICE_ID,
  kind: 'mac',
  ordinal: 1,
  colour: 0,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
}
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
let vaultFiles: Map<string, Uint8Array>
let vaultKeys: Map<string, string>

const installTauri = (signedIn: boolean, providerTokens?: Record<string, unknown>, tier: 'free' | 'pro' = 'pro', extraFiles?: Record<string, string>) => {
  files = {
    'catalogue.json': JSON.stringify({ version: 1, deviceId: DEVICE_ID, deviceLabel: 'This Mac', galleries: [record] }),
    ...(extraFiles ?? {}),
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
  vaultFiles = new Map()
  vaultKeys = new Map()
  ;(dom as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => {
      invokeLog.push(command)
      invokeCalls.push({ command, args: args as Record<string, unknown> })
      // The Rust vault seam, replicated in memory: writes carry their path
      // as request metadata and their record as the raw body; reads answer
      // raw bytes and an empty body means absent — the same contract the
      // fill's commit verification relies on.
      if (command === 'vault_write') {
        vaultFiles.set(String(options?.headers?.['x-vault-path'] ?? ''), args as Uint8Array)
        return null
      }
      if (command === 'vault_read') {
        const bytes = vaultFiles.get(String((args as Record<string, unknown>)?.path))
        return bytes ? bytes.slice().buffer as ArrayBuffer : new ArrayBuffer(0)
      }
      if (command === 'vault_move') {
        const record = args as Record<string, unknown>
        const from = String(record?.from); const to = String(record?.to)
        const bytes = vaultFiles.get(from)
        if (bytes) { vaultFiles.set(to, bytes); vaultFiles.delete(from) }
        return null
      }
      if (command === 'vault_remove') {
        vaultFiles.delete(String((args as Record<string, unknown>)?.path))
        return null
      }
      if (command === 'vault_list') {
        return [...vaultFiles.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length }))
      }
      if (command === 'vault_key_get') return vaultKeys.get(String((args as Record<string, unknown>)?.name)) ?? null
      if (command === 'vault_key_set') { vaultKeys.set(String((args as Record<string, unknown>)?.name), String((args as Record<string, unknown>)?.value)); return null }
      if (command === 'vault_key_remove') { vaultKeys.delete(String((args as Record<string, unknown>)?.name)); return null }
      const params = args as Record<string, unknown> | undefined
      if (command === 'read_private_file') return files[String(params?.name)] ?? null
      if (command === 'write_private_file') {
        files[String(params?.name)] = String(params?.contents)
        return null
      }
      if (command === 'delete_private_file') {
        delete files[String(params?.name)]
        return null
      }
      // `pick_gallery_root` — the folder dialog answers whatever the test staged.
      if (command === 'pick_gallery_root') return pickedFolder
      // `plugin:fs|exists` — every saved root is reported mounted.
      if (command === 'plugin:fs|exists') return true
      // `plugin:fs|read_dir` — a virtual directory tree per root.
      if (command === 'plugin:fs|read_dir') return dirs[String(params?.path)] ?? []
      // `plugin:fs|read_file` — bytes; a gate can hold the read open so an
      // upload stays in flight deterministically.
      if (command === 'plugin:fs|read_file') {
        if (readFileGate) {
          await readFileGate.promise
          return new ArrayBuffer(8)
        }
        return new ArrayBuffer(8)
      }
      // The OAuth loopback listener: begin answers a port; finish waits
      // for the browser callback like the native TcpListener — resolving
      // it eagerly would race a bogus redirect through completeProviderConnect.
      if (command === 'oauth_loopback_begin') return 40123
      if (command === 'oauth_loopback_finish') return new Promise(() => {})
      if (command === 'oauth_loopback_cancel') return null
      return null
    },
    convertFileSrc: (path: string) => `asset://localhost${path}`,
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
  // The event plugin's unlisten path reaches past invoke to the plugin
  // internals — a mounted island's cleanups call it on the way down.
  ;(dom as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void } }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  }
}

const mount = async (signedIn: boolean, providerTokens?: Record<string, unknown>, tier: 'free' | 'pro' = 'pro', extraFiles?: Record<string, string>): Promise<HTMLElement> => {
  installTauri(signedIn, providerTokens, tier, extraFiles)
  // happy-dom's element types are not lib.dom's; the repo's render tests cast at
  // this one boundary so every query below is typed by the DOM library.
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  mounts.mount(<Catalogue apiBase="https://manorama.xyz" />, container)
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

/** The publish flow's sheet host — details is a sheet itself now, so a bare
 *  `.m-sheet-host` selector can land on the settings panel instead. */
const shareSheetHost = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.m-sheet-host')]
    .find((host) => host.querySelector('.desktop-share--sheet') !== null)

/** Dispatch a local gallery action from the card's Level0 menu. */
const openCardMenuAction = async (container: HTMLElement, label: string) => {
  container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
  await settle()
  const action = menuItem(container, label)
  expect(action).toBeDefined()
  action!.click()
  await settle()
}

/** Gallery Settings is the final panel, one step from the card menu. */
const openCardDetails = (container: HTMLElement) => openCardMenuAction(container, 'More settings…')

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
  globals.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    // The account's device list: this Mac registered, alone, in slot 0.
    if (path.endsWith('/api/devices')) return json({ devices: [selfDevice] })
    if (init?.method === 'PUT' && /\/api\/devices\/[^/]+$/.test(path)) return json({ device: selfDevice })
    if (init?.method === 'DELETE' && /\/api\/devices\/[^/]+$/.test(path)) return json({ ok: true })
    return json({ galleries: [] })
  }) as unknown as typeof fetch
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
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
  dom.window.history.replaceState(null, '', 'http://localhost/')
})

afterEach(() => {
  releaseAllOverlays()
  readFileGate?.reject(new Error('test teardown'))
  readFileGate = null
  mounts.unmountAll()
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
    expect(html.indexOf('admin-library-heading')).toBeLessThan(html.indexOf('lib-compact-grid'))

    // The gear in the rail's heading opens the shared Settings surface —
    // the old slide-in account drawer is gone, replaced by the web's groups.
    const tab = container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    expect(tab?.getAttribute('aria-label')).toBe('Settings')
    expect(container.querySelector('#admin-account-drawer')).toBeNull()
    expect(container.querySelector('.web-settings')).toBeNull()
  })

  test('the rail carries a live vault tracker — figures and meter', async () => {
    const container = await mount(true)

    const tracker = container.querySelector('.lib-vault-tracker')
    expect(tracker).not.toBeNull()
    // The IPC stub has no vault files, so the honest figure is an empty
    // vault measured against the default cap it actually enforces.
    const figures = tracker!.querySelector('.lib-vault-tracker-figures')
    expect(figures?.textContent).toBe('0 B of 256.0 MiB')
    const meter = tracker!.querySelector('[role="meter"]')
    expect(meter?.getAttribute('aria-valuenow')).toBe('0')
    expect(meter?.getAttribute('aria-valuemax')).toBe(String(256 * 1024 * 1024))
    expect(meter?.getAttribute('aria-valuetext')).toBe('0 B of 256.0 MiB')
    // It is rail furniture: it must sit inside the rail, not the card column.
    expect(container.querySelector('.admin-rail .lib-vault-tracker')).not.toBeNull()
    const html = container.innerHTML
    expect(html.indexOf('lib-vault-tracker')).toBeLessThan(html.indexOf('admin-copyright'))
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

  test('the sign-in surface always launches dark, even with a stored light choice', async () => {
    dom.localStorage.setItem('manorama:theme', 'light')
    await mount(false)
    expect(dom.document.documentElement.classList.contains('light')).toBe(false)
    expect(dom.localStorage.getItem('manorama:theme')).toBe('light')
  })

  test('a gallery card shows one Details action, thumbnails, and no local paths', async () => {
    const container = await mount(true)
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.getAttribute('data-availability')).toBe('available')
    expect(card.querySelector('.lib-card-title')?.textContent).toBe(TITLE)
    expect(card.querySelector('.lib-card-sub')?.textContent).toBe('2 photographs · Mac')

    // The sub-line names the source kind only — the root path never renders as
    // metadata (the thumbnail src is the asset protocol referencing originals
    // in place, which is separate and intended).
    expect(card.querySelector('.lib-card-sub')?.textContent).toContain('Mac')
    expect(card.textContent).not.toContain(ROOT_PATH)

    // Unpinned, the local card is the compact cover form — the same shape
    // an account gallery collapses to in "Cloud galleries". The cover is the
    // first visible original, referenced in place through the asset
    // protocol: no copy, no derivative, no thumbnail.
    const cover = card.querySelector<HTMLElement>('.lib-compact-cover')!
    expect(cover.tagName).toBe('A')
    expect(cover.getAttribute('aria-label')).toBe(`${TITLE} cover`)
    expect(cover.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost${record.items[0].path}`)

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
      // Section order is Pinned → Local galleries → Cloud galleries; the
      // account card lands in Cloud galleries after the local cards. The
      // collapsible headers lead with a chevron glyph — strip it before
      // matching on the title text.
      const headings = [...container.querySelectorAll<HTMLElement>('.lib-section-title')].map((el) => (el.textContent ?? '').replace(/^[▸▾]/, ''))
      const localHeading = headings.findIndex((text) => text.startsWith('Local galleries'))
      const cloudHeading = headings.findIndex((text) => text.startsWith('Cloud galleries'))
      expect(localHeading).toBeGreaterThanOrEqual(0)
      expect(localHeading).toBeLessThan(cloudHeading)
      const localSection = container.querySelector<HTMLElement>('[aria-labelledby="local-galleries-title"]')!
      const accountSection = container.querySelector<HTMLElement>('[aria-labelledby="lib-compact-title"]')!
      expect(localSection).not.toBeNull()
      expect(accountSection).not.toBeNull()
      expect(localSection.textContent).toContain(TITLE)
      expect(accountSection.querySelector('.lib-compact-card .lib-card-title')?.textContent).toBe('kashmir, in winter')

      const card = accountSection.querySelector<HTMLElement>('.lib-compact-card')!
      expect(card.querySelector('.lib-card-sub')?.textContent).toBe('1 photograph from Dropbox')
      // The preview is painted from the provider once, vaulted under a
      // `cover:` entry, and the cell re-acquires the same bytes locally —
      // the img settles on the vault object URL, not the remote one.
      expect(card.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
      const coverEntries = [...vaultFiles.keys()].filter((path) => vaultFilePathIdentity(path).entryId === 'cover:a')
      expect(coverEntries.length).toBe(1)
      // Common actions live directly in the card menu; source and removal
      // stay in the final Gallery Settings panel.
      card.querySelector<HTMLButtonElement>(`[aria-label="kashmir, in winter actions"]`)!.click()
      await settle()
      expect([...container.querySelectorAll('.lib-menu button')].map((button) => button.textContent?.trim())).toEqual([
        'Pin gallery',
        'Hide this gallery',
        'Copy link',
        'Reorder photos',
        'Refresh gallery',
        'Post to X',
        'More settings…',
      ])
      for (const item of ['Reorder photographs', 'View source', 'Refresh gallery contents', 'Remove gallery', 'Open']) {
        expect(menuItem(container, item)).toBeUndefined()
      }

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

  test('an encrypted cover paints its vaulted cover entry — no materialize, no remote', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            slug: 'nagaland',
            title: 'welcome to naglund',
            caption: '',
            date: '',
            imageCount: 1,
            sourceUrl: 'https://mega.nz/folder/x',
            createdAt: '2026-10-01T00:00:00.000Z',
            retention: 'retained',
            expiresAt: null,
            images: [
              // A MEGA-style manifest item: rendition URLs are dead by
              // design; the media refs are the only route to bytes.
              { id: 'mega-node1', ref: undefined, filename: 'IMG_001.jpg', src: '', width: 4000, height: 3000, alt: '', placeholder: '', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'folder-x', nodeId: 'node-1' }, variants: [{ src: '', width: 400, format: 'image/jpeg', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'folder-x', nodeId: 'node-1', previewId: 'prev-1' } }] },
            ],
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      installTauri(true)
      // A previous session vaulted the rendition it already paid to decrypt
      // — the seed runs the same encrypted write path the cell itself uses.
      const vaultGalleryId = await offlineGalleryId({ owner: 'thecontrarian', slug: 'nagaland' })
      await desktopOfflineStore.ensureCoverBytes?.({
        galleryId: vaultGalleryId,
        entryId: coverEntryId('mega-node1'),
        mimeType: 'image/jpeg',
        itemId: 'mega-node1',
        load: async () => new TextEncoder().encode('jpeg bytes'),
      })
      const container = dom.document.createElement('div') as unknown as HTMLElement
      dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
      mounts.mount(<Catalogue apiBase="https://manorama.xyz" />, container)
      await settle()
      const card = container.querySelector<HTMLElement>('.lib-compact-card[data-gallery-card="nagaland"]')!
      await settle()
      // The probe hits the cover entry and the img paints vault bytes. Before
      // the fix, media-carrying cells skipped the vault probe entirely: the
      // only route was a materialize that needs the gallery key — which this
      // bench deliberately does not hold — so the cover could never appear.
      expect(card.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
      expect(invokeLog.filter((command) => command.startsWith('plugin:http'))).toEqual([])
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('section labels count the whole category — hidden galleries included', async () => {
    const hiddenRecord = { ...record, id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', title: 'secret album', hiddenAt: '2026-11-01T00:00:00.000Z' }
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [
            { slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '', imageCount: 1, sourceUrl: 'https://www.dropbox.com/scl/fo/x', createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, hiddenAt: null, images: [{ id: 'a', ref: undefined, filename: 'a.jpg', src: '/img/a.jpg', width: 4000, height: 3000, alt: '', placeholder: '', variants: [{ src: '/img/a-sm.jpg', width: 400, format: 'image/jpeg' }] }] },
            { slug: 'meadow', title: 'meadow, kept quiet', caption: '', date: '', imageCount: 1, sourceUrl: 'https://www.dropbox.com/scl/fo/y', createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, hiddenAt: '2026-11-05T00:00:00.000Z', images: [{ id: 'b', ref: undefined, filename: 'b.jpg', src: '/img/b.jpg', width: 4000, height: 3000, alt: '', placeholder: '', variants: [{ src: '/img/b-sm.jpg', width: 400, format: 'image/jpeg' }] }] },
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true, undefined, 'pro', {
        'catalogue.json': JSON.stringify({ version: 1, deviceId: DEVICE_ID, deviceLabel: 'This Mac', galleries: [record, hiddenRecord] }),
      })
      // The rail's "hosting N" line counts the category; the section label
      // now reads the same number — the grid alone shows only what is not
      // parked under Hidden galleries.
      const localSection = container.querySelector<HTMLElement>('[aria-labelledby="local-galleries-title"]')!
      expect(localSection.querySelector('.lib-hidden-count')?.textContent).toBe('(2)')
      expect(localSection.querySelectorAll('[data-gallery-card]')).toHaveLength(1)
      const cloudSection = container.querySelector<HTMLElement>('[aria-labelledby="lib-compact-title"]')!
      expect(cloudSection.querySelector('.lib-hidden-count')?.textContent).toBe('(2)')
      expect(cloudSection.querySelectorAll('[data-gallery-card]')).toHaveLength(1)
      expect(container.querySelector('.lib-hidden-section .lib-hidden-count')?.textContent).toBe('(2)')
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

  test('a Proton-backed gallery open failure stays in-app — the web can never open it', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            id: '2b5dee85-7a75-4c48-93ec-ea1869361480', manifestVersion: 2,
            slug: 'guinea', title: 'guinea', caption: '', date: '',
            imageCount: 40, sourceUrl: 'https://drive.proton.me/urls/15C18NM2P0',
            createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images: [],
          }],
        }), { status: 200 })
      }
      // The manifest fetch and every other call fail — the same state that
      // used to bounce the user into a browser tab that could not render.
      return new Response('down', { status: 500 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const title = [...container.querySelectorAll<HTMLElement>('.lib-card-title')]
        .find((el) => el.textContent === 'guinea')!
      title.click()
      await settle()
      expect(invokeCalls.some((call) => call.command === 'plugin:opener|open_url')).toBe(false)
      const notes = [...container.querySelectorAll('.desktop-toast-stack .admin-toast')].map((el) => el.textContent)
      expect(notes.some((text) => text?.includes('not saved on this Mac'))).toBe(true)
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a failed MEGA gallery open hands the browser the key-bearing link', async () => {
    const megaSource = 'https://mega.nz/folder/AbCdEfGh#keymaterial'
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/api/galleries')) {
        return new Response(JSON.stringify({
          galleries: [{
            id: 'mega-gallery-id', manifestVersion: 2,
            slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '',
            imageCount: 1, sourceUrl: 'https://mega.nz/folder/AbCdEfGh',
            createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images: [],
          }],
        }), { status: 200 })
      }
      return new Response('down', { status: 500 })
    }) as unknown as typeof fetch
    try {
      installTauri(true)
      // The device holds the key — the fallback link must carry the
      // custody fragment so the browser opens the gallery, not a lock.
      vaultKeys.set('manorama.gallery-key.v1.mega-gallery-id', megaSource)
      const container = dom.document.createElement('div') as unknown as HTMLElement
      dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
      mounts.mount(<Catalogue apiBase="https://manorama.xyz" />, container)
      await settle()
      const title = [...container.querySelectorAll<HTMLElement>('.lib-card-title')]
        .find((el) => el.textContent === 'kashmir, in winter')!
      title.click()
      await settle()
      const opener = invokeCalls.find((call) => call.command === 'plugin:opener|open_url')
      expect(String(opener?.args?.url)).toContain('https://manorama.xyz/thecontrarian/kashmir#source=')
      expect(String(opener?.args?.url)).toContain(encodeURIComponent(megaSource))
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('signed out, the desktop shows the welcome chooser', async () => {
    document.documentElement.dataset.macosShell = '1'
    try {
      const container = await mount(false)
      expect(container.querySelector('.admin-page')).toBeNull()
      const welcome = container.querySelector('.landing-page.desktop-welcome')!
      expect(welcome.querySelector('.desktop-welcome-header img')).not.toBeNull()
      const chooser = [...welcome.querySelectorAll<HTMLButtonElement>('.desktop-signin-button')]
      expect(chooser.map((button) => button.textContent?.trim())).toEqual([
        'Continue with Apple',
        'Continue with Dropbox',
        'Continue with Google Drive',
      ])
      for (const button of chooser) expect(button.querySelector('svg')).not.toBeNull()
    } finally {
      delete document.documentElement.dataset.macosShell
    }
  })

  test('details mounts from a card with the cloud sheet’s full row set and no banned surfaces', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()

    const details = container.querySelector('[data-screen="local-details"]')
    expect(details).not.toBeNull()
    expect(details?.querySelector('.m-owner-panel-title')?.textContent).toBe(TITLE)
    expect(details?.querySelector('.m-owner-panel-head')?.textContent).toContain('2 photographs · Folder on this Mac')
    expect([...details!.querySelectorAll('.m-actionrow-label')].map((el) => el.textContent)).toEqual([
      'Open gallery', 'View source',
      'Name', 'Caption', 'Address',
      'Reorder photographs', 'Refresh gallery contents',
      'Remove from Library',
    ])
    for (const label of ['Publish', 'Publish this gallery', 'Copy link', 'Reorder photos', 'Refresh gallery', 'Post to X', 'More Settings']) {
      expect(row(container, label)).toBeUndefined()
    }

    // Local paths and filenames never surface in the settings panel's copy.
    // (The library beneath it legitimately carries asset:// originals in its
    // card rails — the assertion scopes to the panel itself.)
    const html = (details as HTMLElement).innerHTML
    expect(html).not.toContain(ROOT_PATH)
    expect(html).not.toContain('/Volumes/')
    expect(html).not.toContain('MS201810-Italy0005.jpg')
    expect(html).not.toContain('manorama.xyz')
    expect(html).not.toContain('Dropbox')
    expect(html).not.toContain('Google Drive')
    expect(html).not.toContain('Vault')
    expect(html).not.toContain('Offline')
  })

  test('the details sheet carries the thumbnail rail like the cloud sheet, and a cell opens the viewer', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()

    const rail = container.querySelector<HTMLElement>('.m-sheet .d-rail')
    expect(rail).not.toBeNull()
    const items = [...rail!.querySelectorAll<HTMLElement>('.admin-gallery-strip-item')]
    expect(items).toHaveLength(2)
    // The preview renders the originals over the asset scheme — the same
    // srcs the viewer will use — and no hidden badges, since hidden items
    // are not in the viewer's manifest.
    for (const img of rail!.querySelectorAll<HTMLImageElement>('img')) {
      expect(img.src).toMatch(/^asset:\/\//)
    }
    expect(rail!.querySelector('.admin-strip-badge')).toBeNull()
    expect(items[0]!.querySelector('a')?.getAttribute('aria-label')).toBe('italy, amore mio, image 1 of 2')

    items[1]!.querySelector('a')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-stage')).not.toBeNull()
  })

  test('the details sheet’s management rows reorder and rescan like the cloud sheet’s', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()

    // Refresh first — it works in place, so the sheet is still open to
    // carry Reorder after it.
    ;(row(container, 'Refresh gallery contents') as HTMLButtonElement).click()
    await settle()
    const rescan = invokeCalls.find((call) => call.command === 'plugin:fs|read_dir' && call.args?.path === ROOT_PATH)
    expect(rescan).not.toBeUndefined()
    expect(container.querySelector('[data-screen="local-details"]')).not.toBeNull()

    ;(row(container, 'Reorder photographs') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-picker-mode')?.textContent).toBe('Reorder Photos')
  })

  test('a deep-linked details id opens details at launch and Back clears the URL', async () => {
    dom.window.history.replaceState(null, '', `http://localhost/?details=${GALLERY_ID}`)
    const container = await mount(true)
    expect(container.querySelector('[data-screen="local-details"]')).not.toBeNull()

    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
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

    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
  })

  test('Open from details launches the shared viewer', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Open gallery') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-stage')).not.toBeNull()
  })

  test('the picker renders the local photographs themselves, not placeholder boxes', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    await settle()
    ;(row(container, 'Open gallery') as HTMLButtonElement).click()
    await settle()

    // The position pill opens the picker in browse mode.
    container.querySelector<HTMLButtonElement>('[data-chrome-position]')!.click()
    await settle()
    expect(container.querySelector('.viewer-picker-mode')?.textContent).toBe('Photo Picker')

    // Local items carry no rendition variants — the cells must fall back
    // to the asset-scheme original, not the SVG placeholder.
    const imgs = [...container.querySelectorAll<HTMLImageElement>('.viewer-filmstrip-item img')]
    expect(imgs.length).toBe(2)
    for (const img of imgs) expect(img.src).toMatch(/^asset:\/\//)
  })

  test('Reorder photos from the card menu opens Edit and saves into the catalogue', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Reorder photos')

    // The card menu left and the picker owns the screen in Edit mode —
    // the items came from the local record, not an API summary.
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-picker-mode')?.textContent).toBe('Reorder Photos')
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.viewer-edit-item')]
    expect(cells.map((cell) => cell.dataset.imageId)).toEqual(['MS201810-Italy0005.jpg', 'MS201810-Italy0100.jpg'])

    // Pick the first photograph up and put it down on the second — a
    // one-position move, then Save.
    cells[0]!.click()
    await settle()
    ;[...container.querySelectorAll<HTMLButtonElement>('.viewer-edit-item')][1]!.click()
    await settle()
    const save = [...container.querySelectorAll<HTMLButtonElement>('.viewer-picker-end')].find((b) => b.textContent?.trim() === 'Save')!
    save.click()
    await settle()

    // The catalogue file holds the new order — no API PATCH was attempted.
    const saved = JSON.parse(files['catalogue.json']!) as { galleries: { items: { id: string }[] }[] }
    expect(saved.galleries[0]!.items.map((i) => i.id)).toEqual(['MS201810-Italy0100.jpg', 'MS201810-Italy0005.jpg'])
    // Entered from the card menu — Save lands back on the Library, not the gallery.
    expect(container.querySelector('.viewer-stage')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
  })

  test('dragging a photograph across the matrix reorders and saves', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Reorder photos')

    // happy-dom does no layout — the drag's hit test reads live rects, so
    // the two cells get synthetic boxes side by side for the pointer's trip.
    const rectById: Record<string, { left: number; top: number; width: number; height: number }> = {
      'MS201810-Italy0005.jpg': { left: 0, top: 0, width: 200, height: 150 },
      'MS201810-Italy0100.jpg': { left: 200, top: 0, width: 150, height: 150 },
    }
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    dom.window.HTMLElement.prototype.getBoundingClientRect = function (this: { dataset?: { imageId?: string } }) {
      const box = this.dataset?.imageId ? rectById[this.dataset.imageId] : undefined
      if (box) {
        return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => ({}) } as DOMRect
      }
      return originalRect.call(this as unknown as HTMLElement)
    } as unknown as typeof dom.window.HTMLElement.prototype.getBoundingClientRect
    const pointer = (type: string, target: Element, x: number, y: number) => {
      const event = new dom.Event(type, { bubbles: true })
      Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y })
      target.dispatchEvent(event as unknown as Event)
    }
    try {
      const frame = container.querySelector<HTMLElement>('.viewer-filmstrip-frame')!
      const cell = (index: number) => [...container.querySelectorAll<HTMLButtonElement>('.viewer-edit-item')][index]!

      // Grab the first photograph, carry it over the second, release.
      pointer('pointerdown', cell(0), 50, 75)
      pointer('pointermove', frame, 150, 75)
      await settle()
      // Activation lifts the cell and floats a ghost under the pointer.
      expect(cell(0).classList.contains('is-held')).toBe(true)
      expect(container.querySelector('.viewer-edit-ghost')).not.toBeNull()

      pointer('pointermove', frame, 280, 75)
      await settle()
      pointer('pointerup', frame, 280, 75)
      await settle()

      // The release is the move: cell order flipped, ghost gone, Save up.
      const cells = [...container.querySelectorAll<HTMLButtonElement>('.viewer-edit-item')]
      expect(cells.map((el) => el.dataset.imageId)).toEqual(['MS201810-Italy0100.jpg', 'MS201810-Italy0005.jpg'])
      expect(container.querySelector('.viewer-edit-ghost')).toBeNull()
      ;[...container.querySelectorAll<HTMLButtonElement>('.viewer-picker-end')].find((b) => b.textContent?.trim() === 'Save')!.click()
      await settle()

      const saved = JSON.parse(files['catalogue.json']!) as { galleries: { items: { id: string }[] }[] }
      expect(saved.galleries[0]!.items.map((i) => i.id)).toEqual(['MS201810-Italy0100.jpg', 'MS201810-Italy0005.jpg'])
    } finally {
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect
    }
  })

  test('hiding a photograph in Edit mode removes it from the manifest and the rail, not the record', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Reorder photos')

    // The per-cell mark hides the photograph — the draft, then Save.
    container.querySelector<HTMLButtonElement>('[aria-label="Hide MS201810-Italy0005.jpg"]')!.click()
    await settle()
    ;[...container.querySelectorAll<HTMLButtonElement>('.viewer-picker-end')].find((b) => b.textContent?.trim() === 'Save')!.click()
    await settle()

    const saved = JSON.parse(files['catalogue.json']!) as { galleries: { items: { id: string }[]; hidden?: string[] }[] }
    // The record keeps both files — concealment is a view, not a deletion.
    expect(saved.galleries[0]!.items).toHaveLength(2)
    expect(saved.galleries[0]!.hidden).toEqual(['MS201810-Italy0005.jpg'])
    // The card's cover shows only what a viewer would see.
    const card = container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.querySelector('.lib-compact-cover img')?.getAttribute('src')).toContain('MS201810-Italy0100.jpg')
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

    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.lib-card-title')?.textContent).toBe('Vernazza')

    const saved = JSON.parse(files['catalogue.json']) as { galleries: { title: string }[] }
    expect(saved.galleries[0]?.title).toBe('Vernazza')
    // The renamed gallery is handed back to the sync lane.
    expect(fetchCount).toBeGreaterThan(before)

    globals.fetch = originalFetch
  })

  test('Refresh gallery from the card menu rescans the source and updates details and card counts', async () => {
    const container = await mount(true)
    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    await openCardMenuAction(container, 'Refresh gallery')

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.lib-menu')).toBeNull()
    expect(container.querySelector('.desktop-toast-stack .admin-toast')?.textContent).toBe(`“${TITLE}” refreshed`)
    const card = container.querySelector<HTMLElement>(`[data-gallery-card="${GALLERY_ID}"]`)!
    expect(card.querySelector('.lib-card-sub')?.textContent).toBe('3 photographs · Mac')
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(3)

    await openCardDetails(container)
    expect(container.querySelector('.m-owner-panel-head')?.textContent).toContain('3 photographs')
    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
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

  test('publish opens directly over the Library and a plain close resets it', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Publish this gallery')

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.lib-menu')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
    const host = shareSheetHost(container)
    expect(host).not.toBeNull()
    expect(host?.querySelector('.desktop-share--sheet')).not.toBeNull()
    expect(host?.querySelector('.desktop-share-header')).toBeNull()
    expect(host?.textContent).toContain('Dropbox')
    expect(host?.textContent).toContain('Google Drive')
    // Not uploading — the shared sheet is dismissible.
    expect(host?.querySelector('button[aria-label="Close"]')).not.toBeNull()

    host?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    // Closing returns straight to Library, with no latent settings route.
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()

    // Reopening starts from a clean choose step.
    await openCardMenuAction(container, 'Publish this gallery')
    expect(container.querySelector('.desktop-share--sheet')).not.toBeNull()
    expect(container.textContent).toContain('nothing uploads until you confirm')
  })

  test('dismissing while connecting cancels the pending provider connection', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Publish this gallery')

    const connectButton = byText(container, 'Connect')
    expect(connectButton).not.toBeUndefined()
    connectButton!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')

    shareSheetHost(container)!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()

    // The cancelled connect is settled, so a fresh attempt starts clean instead
    // of reporting a stale pending flow.
    await openCardMenuAction(container, 'Publish this gallery')
    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')
    expect(container.querySelector('[role="alert"]')).toBeNull()

    // Leave no pending connect behind for later tests: dismissal settles it.
    shareSheetHost(container)!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()
  })

  test('the hosted sheet cannot be dismissed during an upload', async () => {
    const container = await mount(true, {
      dropbox: { accessToken: 'token', expiresAt: Date.now() + 1e12 },
    })
    // The read gate is consulted only when the upload starts, so it can be
    // armed after mount (installTauri resets it).
    readFileGate = deferred()
    await openCardMenuAction(container, 'Publish this gallery')

    byText(container, 'Use Dropbox')!.click()
    await settle()
    expect(container.textContent).toContain('Upload 2 originals to Dropbox')
    byText(container, 'Upload and publish')!.click()
    await settle()

    // In flight: the upload is gated on the hung read, so the step is live.
    expect(container.textContent).toContain('Preparing the upload…')
    expect(shareSheetHost(container)).not.toBeNull()
    expect(shareSheetHost(container)?.querySelector('button[aria-label="Close"]')).toBeNull()

    // Escape and the scrim are both inert while uploading.
    const esc = new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Parameters<typeof dom.document.dispatchEvent>[0]
    dom.document.dispatchEvent(esc)
    await settle()
    expect(shareSheetHost(container)).not.toBeNull()
    shareSheetHost(container)!.querySelector<HTMLElement>('.m-scrim')!.click()
    await settle()
    expect(shareSheetHost(container)).not.toBeNull()

    // Releasing the read lands the flow in error — and only then is the sheet
    // dismissible again.
    readFileGate!.reject(new Error('halt'))
    readFileGate = null
    await settle()
    expect(shareSheetHost(container)?.querySelector('[role="alert"]')).not.toBeNull()
    expect(shareSheetHost(container)?.querySelector('button[aria-label="Close"]')).not.toBeNull()
  })

  test('navigating history while connecting settles the pending provider connection', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Publish this gallery')

    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')

    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
    const authorizationUrls = () => invokeCalls
      .filter((call) => call.command === 'plugin:opener|open_url')
      .map((call) => new URL(String(call.args?.url)))
    expect(authorizationUrls()).toHaveLength(1)
    expect(authorizationUrls()[0].searchParams.get('redirect_uri')).toBe('in.thecontrarian.manorama.desktop://oauth/dropbox')
    dom.window.history.replaceState(null, '', 'http://localhost/')
    dom.window.dispatchEvent(new dom.Event('popstate'))
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
    expect(authorizationUrls()).toHaveLength(1)

    await openCardMenuAction(container, 'Publish this gallery')
    byText(container, 'Connect')!.click()
    await settle()
    expect(container.textContent).toContain('Finish connecting Dropbox')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(authorizationUrls()).toHaveLength(2)
    expect(authorizationUrls()[1].searchParams.get('state')).not.toBe(authorizationUrls()[0].searchParams.get('state'))

    // Leave no pending connect behind for later tests: dismissal settles it.
    shareSheetHost(container)!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()
  })

  test('navigating Library history during a direct-menu upload leaves the sheet mounted', async () => {
    const container = await mount(true, {
      dropbox: { accessToken: 'token', expiresAt: Date.now() + 1e12 },
    })
    // The read gate is consulted only when the upload starts, so it can be
    // armed after mount (installTauri resets it).
    readFileGate = deferred()
    await openCardMenuAction(container, 'Publish this gallery')
    byText(container, 'Use Dropbox')!.click()
    await settle()
    byText(container, 'Upload and publish')!.click()
    await settle()
    expect(container.textContent).toContain('Preparing the upload…')

    // The same Library popstate that cancels a pending connection must be
    // inert during upload. No details route is created by this menu flow.
    const host = shareSheetHost(container)
    expect(host).toBeDefined()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
    const reads = invokeLog.filter((command) => command === 'plugin:fs|read_file').length
    expect(reads).toBeGreaterThan(0)
    dom.window.history.replaceState(null, '', 'http://localhost/')
    dom.window.dispatchEvent(new dom.Event('popstate'))
    await settle()

    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(shareSheetHost(container)).toBe(host)
    expect(shareSheetHost(container)?.querySelector('button[aria-label="Close"]')).toBeNull()
    expect(container.textContent).toContain('Preparing the upload…')
    expect(invokeLog.filter((command) => command === 'plugin:fs|read_file')).toHaveLength(reads)
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()

    // Releasing the read lands the flow in error exactly once — no restart,
    // no duplicate upload phase.
    readFileGate!.reject(new Error('halt'))
    readFileGate = null
    await settle()
    expect(shareSheetHost(container)?.querySelector('[role="alert"]')).not.toBeNull()
    expect(shareSheetHost(container)?.querySelector('button[aria-label="Close"]')).not.toBeNull()
    expect(container.textContent).not.toContain('nothing uploads until you confirm')
    expect(invokeLog.filter((command) => command === 'plugin:fs|read_file')).toHaveLength(reads)

    // With the upload settled, Close returns directly to the Library.
    shareSheetHost(container)!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).toBeNull()
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.admin-page')).not.toBeNull()
    expect(new URL(dom.window.location.href).searchParams.get('details')).toBeNull()
  })

  test('a failed source scan reports the error and marks the source unavailable', async () => {
    const container = await mount(true)

    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'plugin:fs|read_dir' && String(args?.path) === ROOT_PATH) {
        throw new Error('The card is not mounted')
      }
      return originalInvoke(command, args)
    }

    await openCardMenuAction(container, 'Refresh gallery')

    // The error surfaces; no success note; the prior record/count stays and
    // a genuine source read failure may flag the source unavailable.
    expect(container.textContent).toContain('The card is not mounted')
    expect(container.textContent).not.toContain(`“${TITLE}” refreshed`)
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"] .lib-card-sub`)?.textContent).toBe('2 photographs · Mac')
    await openCardDetails(container)
    expect(container.querySelector('.m-owner-panel-head')?.textContent).toContain('2 photographs')
    expect(container.querySelector('[data-availability="unavailable"]')).not.toBeNull()
    const saved = JSON.parse(files['catalogue.json']) as { galleries: { itemCount: number }[] }
    expect(saved.galleries[0]?.itemCount).toBe(2)
  })

  test('a failed private-store write during rescan keeps the old count and availability', async () => {
    const container = await mount(true)

    // A new photo appears on disk — the scan would succeed; only the write fails.
    dirs[ROOT_PATH]!.push({ name: 'MS201810-Italy0200.jpg', isDirectory: false, isFile: true })
    const internals = (dom as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
    const originalInvoke = internals.invoke
    internals.invoke = async (command, args) => {
      if (command === 'write_private_file') throw new Error('The disk is full')
      return originalInvoke(command, args)
    }

    await openCardMenuAction(container, 'Refresh gallery')

    // The error surfaces; no success note; the prior record/count stays on
    // screen and the still-available source is not flagged unavailable.
    expect(container.textContent).toContain('The disk is full')
    expect(container.textContent).not.toContain(`“${TITLE}” refreshed`)
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"] .lib-card-sub`)?.textContent).toBe('2 photographs · Mac')
    await openCardDetails(container)
    expect(container.querySelector('.m-owner-panel-head')?.textContent).toContain('2 photographs')
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

  test('an iCloud shared album link keeps its fragment token through verify and create', async () => {
    // The album token lives in the URL fragment — stripping it is what made
    // every iCloud link fail in the app while the web dashboard worked.
    const cloudGallery = {
      id: 'cloud-icloud',
      slug: 'kashmir',
      title: 'Kashmir',
      sourceUrl: 'https://www.icloud.com/sharedalbum/#D2Qv34SXb0e_MTc9s7Ac4ywYBxwCAEQARog4ioTMH9D3EKdjNaFc8Hczs_oF0FGLrTusE-rI6QvJiU',
      caption: null,
      imageCount: 4,
      itemCount: 4,
      images: [],
      retention: 'permanent',
      expiresAt: null,
      pinnedAt: null,
      deviceLabel: null,
      layout: 'compact',
    }
    const scanCalls: Record<string, unknown>[] = []
    const createCalls: Record<string, unknown>[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
      const path = String(url)
      const method = init?.method ?? 'GET'
      if (method === 'POST' && path.endsWith('/api/galleries/scan')) {
        scanCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({ scan: { title: 'Kashmir' } }), { status: 200 })
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
      const url = cloudGallery.sourceUrl
      setInput(input, url)
      input.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event)
      await settle()

      expect(scanCalls).toHaveLength(1)
      expect(scanCalls[0]?.url).toBe(url)
      expect(String(scanCalls[0]?.url)).toContain('#D2Qv34SXb0e')

      sheetButton(container, 'Create gallery')!.click()
      await settle()
      expect(createCalls).toHaveLength(1)
      expect(createCalls[0]?.url).toBe(url)
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
    // The plan group names the tier and the three gallery counts; Temporary
    // galleries are a Free-tier concept and stay off a Visionary sheet.
    expect(screen.textContent).toContain('Visionary')
    expect(screen.textContent).toContain('Cloud galleries')
    expect(screen.textContent).toContain('Hidden galleries')
    expect(screen.textContent).toContain('Local galleries')
    expect(screen.textContent).not.toContain('Temporary galleries')
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
    // Settings takes over the galleries column: the rail stays mounted and
    // the list is hidden, not replaced by a page or a floating sheet.
    expect(screen.classList.contains('web-settings--pane')).toBe(true)
    expect(screen.closest('.m-sheet')).toBeNull()
    const rail = container.querySelector<HTMLElement>('.admin-rail')!
    expect(rail).not.toBeNull()
    expect(rail.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('.gallery-list')!.hasAttribute('hidden')).toBe(true)
    // The pane's own back affordance returns to the Library — and the rail's
    // gear is a toggle now, expanded while Settings is up.
    expect(rail.querySelector('[aria-label="Settings"]')!.getAttribute('aria-expanded')).toBe('true')
    ;(screen.querySelector('[aria-label="Back to the library"]') as HTMLButtonElement).click()
    await settle()
    // The pane fades out before it leaves — still mounted, mid-exit, while
    // the list is already back beneath it so the handoff is a dissolve.
    expect(container.querySelector('.web-settings--pane.is-closing')).not.toBeNull()
    expect(container.querySelector('.gallery-list')!.hasAttribute('hidden')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await settle()
    expect(container.querySelector('.web-settings')).toBeNull()
    expect(container.querySelector('.gallery-list')!.hasAttribute('hidden')).toBe(false)
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
  const withGallery = (calls: { url: string; method?: string; body?: string }[], gallery: unknown = accountGallery) => {
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const path = String(url)
      calls.push({ url: path, method: init?.method, body: init?.body })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [gallery] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      if (path.endsWith('/pin') || path.endsWith('/refresh')) return new Response(JSON.stringify({}), { status: 200 })
      if (init?.method === 'DELETE') return new Response(JSON.stringify({}), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    return () => { globals.fetch = defaultFetch }
  }

  test('the account menu pins, and removal runs inside Gallery settings', async () => {
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

      // Remove left the quick menu — it is the account card's Gallery
      // Settings panel's last row, behind its own inline confirm.
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'More settings…')!.click()
      await settle()
      // Gallery Settings is final: the rest layer is mounted immediately.
      // It carries Reorder and Refresh in the shared row vocabulary; what it
      // never repeats are the card menu's own quick labels.
      for (const label of ['More Settings', 'Copy link', 'Reorder photos', 'Refresh gallery', 'Post to X']) {
        expect(row(container, label)).toBeUndefined()
      }
      const removeRow = [...container.querySelectorAll<HTMLElement>('.m-actionrow')]
        .find((el) => el.textContent?.includes('Remove from Library')) as HTMLElement
      expect(removeRow).toBeTruthy()
      removeRow.click()
      await settle()
      // The removal is a confirm step inside the panel — nothing is
      // deleted by the first tap alone.
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
      const confirm = container.querySelector('.m-owner-confirm')
      expect(confirm).not.toBeNull()
      ;[...confirm!.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Remove')!.click()
      await settle()
      const del = calls.find((call) => call.method === 'DELETE' && call.url.endsWith('/api/galleries/kashmir'))
      expect(del).toBeDefined()
    } finally {
      restore()
    }
  })

  test('the account menu copies the gallery link, then opens gallery settings', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const restore = withGallery(calls)
    const written: string[] = []
    const previousNavigator = globals.navigator
    Object.defineProperty(globals, 'navigator', {
      configurable: true,
      writable: true,
      value: { clipboard: { writeText: (text: string) => { written.push(text); return Promise.resolve() } } },
    })
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      // Copy link is a clipboard copy, nothing more — no sheet, no share UI.
      menuItem(container, 'Copy link')!.click()
      await settle()
      expect(written).toEqual(['https://manorama.xyz/thecontrarian/kashmir'])
      expect(container.querySelector('.desktop-toast-stack .admin-toast')?.textContent).toBe('Link copied — paste it anywhere')
      expect(container.querySelector('.m-share-address')).toBeNull()

      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'More settings…')!.click()
      await settle()
      // The final rest layer mounts directly, not a second quick-action menu.
      const panel = container.querySelector('.m-owner-panel')
      expect(panel).not.toBeNull()
      expect([...panel!.querySelectorAll('.m-actionrow-label')].map((el) => el.textContent)).toEqual([
        'Open gallery', 'View source', 'Name', 'Caption', 'Address', 'Reorder photographs',
        'Refresh gallery contents', 'Keep a copy on this Mac', 'Remove from Library',
      ])
      for (const label of ['More Settings', 'Copy link', 'Reorder photos', 'Refresh gallery', 'Post to X']) {
        expect(row(container, label)).toBeUndefined()
      }
    } finally {
      restore()
      Object.defineProperty(globals, 'navigator', { configurable: true, writable: true, value: previousNavigator })
    }
  })

  test('turning Keep a copy on starts the vault fill immediately', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const restore = withGallery(calls)
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'More settings…')!.click()
      await settle()
      const keep = container.querySelector<HTMLButtonElement>('.m-owner-panel [role="switch"]')!
      expect(keep.getAttribute('aria-checked')).toBe('false')
      keep.click()
      await settle()
      expect(keep.getAttribute('aria-checked')).toBe('true')
      // Keep is a save choice on the Mac too — the fill's manifest fetch
      // leaves the moment the switch lands, not the next time it opens.
      expect(calls.some((call) => call.url.endsWith('/api/gallery/thecontrarian/kashmir'))).toBe(true)
    } finally {
      restore()
    }
  })

  test('Gallery Settings shows a fill-only preview strip, never a scroller', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const gallery = {
      ...accountGallery,
      imageCount: 12,
      images: Array.from({ length: 12 }, (_, index) => ({
        id: `img-${index}`,
        filename: `photo-${index}.jpg`,
        src: `https://media.example/photo-${index}.jpg`,
        width: index % 3 === 0 ? 3000 : 4000,
        height: 3000,
        alt: '',
        hidden: false,
      })),
    }
    const restore = withGallery(calls, gallery)
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'More settings…')!.click()
      await settle()
      const rail = container.querySelector('.m-sheet .d-rail')!
      expect(rail).not.toBeNull()
      const frame = rail.querySelector<HTMLElement>('.admin-gallery-strip-frame')!
      expect(frame).not.toBeNull()
      const items = [...rail.querySelectorAll('.admin-gallery-strip-item')]
      // The frame cannot be measured under happy-dom, so the fallback mounts
      // its bounded window — the point is that it is never the whole gallery.
      expect(items.length).toBe(8)
      expect(items.length).toBeLessThan(gallery.images.length)
      // Each thumbnail still opens the gallery at its own index.
      expect(items[3]!.querySelector('a')!.getAttribute('aria-label')).toBe('kashmir, in winter, image 4 of 12')
      expect(items[3]!.querySelector('a')!.getAttribute('href')).toBe('https://manorama.xyz/thecontrarian/kashmir')
    } finally {
      restore()
    }
  })

  test('the account menu’s Post to X opens the photograph picker', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    const restore = withGallery(calls)
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('[aria-label="kashmir, in winter actions"]')!.click()
      await settle()
      menuItem(container, 'Post to X')!.click()
      await settle()
      // The picker mounts over the Library and asks for the gallery's
      // manifest — the photographs it offers come from there.
      expect(container.querySelector('[data-post-to-x]')).not.toBeNull()
      expect(calls.some((call) => call.url.includes('/api/gallery/thecontrarian/kashmir'))).toBe(true)
    } finally {
      restore()
    }
  })

  test('the local card menu’s Post to X opens the picker straight off the disk', async () => {
    const container = await mount(true)
    container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
    await settle()
    menuItem(container, 'Post to X')!.click()
    await settle()
    const picker = container.querySelector<HTMLElement>('[data-post-to-x]')
    expect(picker).not.toBeNull()
    // No manifest fetch — the catalogue record is the photo list.
    expect(picker!.getAttribute('aria-label')).toBe(`Post to X — ${TITLE}`)
    expect(picker!.querySelectorAll('.native-global-cell')).toHaveLength(2)
  })

  for (const state of ['unpublished', 'published'] as const) test(`the ${state} local card menu carries exactly the relevant verbs`, async () => {
    const defaultFetch = globals.fetch as typeof fetch
    globals.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/device-galleries') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ galleries: state === 'published' ? [{
          id: GALLERY_ID, title: TITLE, sourceKind: 'folder', itemCount: 2,
          deviceId: DEVICE_ID, updatedAt: record.lastSeenAt, publicGallerySlug: 'italy-amore',
        }] : [] }), { status: 200 })
      }
      return defaultFetch(url, init)
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
      await settle()
      // Common actions are all at Level0; publishing is offered only before
      // this Mac's synced row carries a public gallery address.
      const items = [...container.querySelectorAll<HTMLButtonElement>('.lib-menu button')].map((b) => b.textContent?.trim())
      expect(items).toEqual([
        'Pin gallery',
        'Hide this gallery',
        state === 'published' ? 'Copy link' : 'Publish this gallery',
        'Reorder photos',
        'Refresh gallery',
        'Post to X',
        'More settings…',
      ])
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a local gallery’s guarded remove lives inside Gallery settings', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    const removeRow = [...container.querySelectorAll<HTMLElement>('.m-actionrow')]
      .find((el) => el.textContent?.includes('Remove from Library')) as HTMLElement
    expect(removeRow).toBeTruthy()
    removeRow.click()
    await settle()
    expect(container.textContent).toContain('catalogue entry')
    expect(container.textContent).toContain('untouched')
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
  })

  test('View source inside local settings asks the bridge to reveal the granted root', async () => {
    const container = await mount(true)
    await openCardDetails(container)
    const folderRow = [...container.querySelectorAll<HTMLElement>('.m-actionrow')]
      .find((el) => el.textContent?.includes('View source')) as HTMLElement
    expect(folderRow).toBeTruthy()
    folderRow.click()
    await settle()
    const call = invokeCalls.find((c) => c.command === 'reveal_gallery_root')
    expect(call?.args?.path).toBe(ROOT_PATH)
    expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
  })

  test('Publish this gallery on a local card opens the shared publish sheet', async () => {
    const container = await mount(true)
    container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
    await settle()
    menuItem(container, 'Publish this gallery')!.click()
    await settle()
    expect(container.querySelector('.desktop-share--sheet')).not.toBeNull()
  })

  test('Reorder photos on the local card menu opens the picker straight into Edit', async () => {
    const container = await mount(true)
    await openCardMenuAction(container, 'Reorder photos')
    expect(container.querySelector('[data-screen="local-details"]')).toBeNull()
    expect(container.querySelector('.viewer-picker-mode')?.textContent).toBe('Reorder Photos')
  })

  test('a local gallery pins a strip into Pinned galleries, keeps its Local card, and back', async () => {
    const calls: { url: string; method?: string }[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      calls.push({ url: String(url), method: init?.method })
      return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      // Unpinned, the local is a compact cover card in its own section.
      expect(container.querySelector('#local-galleries-title')).not.toBeNull()
      const compact = container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)!
      expect(compact.classList.contains('lib-compact-card')).toBe(true)

      container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
      await settle()
      menuItem(container, 'Pin gallery')!.click()
      await settle()

      // The pin lands in catalogue.json — the API is never asked; a local
      // record has no server row to PATCH.
      const saved = JSON.parse(files['catalogue.json']!) as { galleries: { pinnedAt?: string }[] }
      expect(saved.galleries[0]!.pinnedAt).toBeTruthy()
      expect(calls.some((call) => call.url.includes('/pin'))).toBe(false)

      // The pin adds a full strip in Pinned galleries — the card keeps its
      // compact cover back in Local. The section already says pinned, so
      // the title carries no redundant pin glyph.
      const pinnedSection = container.querySelector<HTMLElement>('[aria-labelledby="pinned-galleries-title"]')!
      const strip = pinnedSection.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)!
      expect(strip.querySelector('.admin-gallery-strip')).not.toBeNull()
      expect(strip.querySelector('.lib-pin')).toBeNull()
      // The Local section stays — the same gallery still lists there as a
      // compact card alongside its new strip.
      const localSection = container.querySelector<HTMLElement>('[aria-labelledby="local-galleries-title"]')!
      const homeCard = localSection.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)!
      expect(homeCard.classList.contains('lib-compact-card')).toBe(true)
      expect(homeCard.querySelector('.admin-gallery-strip')).toBeNull()

      strip.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
      await settle()
      menuItem(container, 'Unpin gallery')!.click()
      await settle()
      const unpinned = JSON.parse(files['catalogue.json']!) as { galleries: { pinnedAt?: string | null }[] }
      expect(unpinned.galleries[0]!.pinnedAt).toBeFalsy()
      const back = container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)!
      expect(back.classList.contains('lib-compact-card')).toBe(true)
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a local gallery hides into the collapsed Hidden galleries section and back', async () => {
    const puts: { url: string; body: { hidden?: boolean } }[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      if (String(url).includes('/api/device-galleries') && init?.method === 'PUT') {
        puts.push({ url: String(url), body: JSON.parse(init.body ?? '{}') })
      }
      return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const card = () => container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)
      const hiddenSection = () => container.querySelector<HTMLElement>('.lib-hidden-section')

      // Visible in the Local section; the Hidden section only exists once
      // something is hidden.
      expect(card()).not.toBeNull()
      expect(hiddenSection()).toBeNull()

      container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
      await settle()
      menuItem(container, 'Hide this gallery')!.click()
      await settle()

      // Gone from the Local section, parked in collapsed "Hidden galleries",
      // and the flag lands on the record so the sync carries it to the
      // account's other devices.
      expect(container.querySelector('#local-galleries-title')).toBeNull()
      expect(hiddenSection()).not.toBeNull()
      expect(hiddenSection()!.querySelector('.lib-hidden-count')?.textContent).toBe('(1)')
      expect(hiddenSection()!.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
      const saved = JSON.parse(files['catalogue.json']!) as { galleries: { hiddenAt?: string }[] }
      expect(saved.galleries[0]!.hiddenAt).toBeTruthy()
      expect(puts.some((put) => put.body.hidden === true)).toBe(true)

      // Expanding the section shows the card; its menu swaps to Unhide.
      hiddenSection()!.querySelector<HTMLButtonElement>('.lib-hidden-toggle')!.click()
      await settle()
      expect(hiddenSection()!.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
      container.querySelector<HTMLButtonElement>(`[aria-label="${TITLE} actions"]`)!.click()
      await settle()
      menuItem(container, 'Unhide gallery')!.click()
      await settle()

      expect(hiddenSection()).toBeNull()
      expect(container.querySelector('#local-galleries-title')).not.toBeNull()
      expect(JSON.parse(files['catalogue.json']!).galleries[0].hiddenAt).toBeFalsy()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('an account gallery hide PATCHes the server flag and the card drops out of Cloud galleries', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    let kashmirHidden = false
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body })
      if (String(url).includes('/api/galleries/kashmir/hide')) {
        kashmirHidden = JSON.parse(init?.body ?? '{}').hidden === true
      }
      if (String(url).endsWith('/api/galleries')) {
        return new Response(JSON.stringify({ galleries: [{
          id: 'g1', manifestVersion: 1, slug: 'kashmir', title: 'kashmir, in winter', caption: '', date: '',
          imageCount: 1, mediaCount: { stills: 1, videos: 0, hidden: 0 },
          sourceUrl: 'https://www.dropbox.com/scl/fo/x', createdAt: '2026-10-01T00:00:00.000Z',
          retention: 'retained', expiresAt: null, pinnedAt: null, hiddenAt: kashmirHidden ? '2026-11-09T00:00:00.000Z' : null,
          images: [{ id: 'a', ref: undefined, filename: 'a.jpg', src: '/img/a.jpg', width: 4000, height: 3000, alt: '', placeholder: '', variants: [{ src: '/img/a-sm.jpg', width: 400, format: 'image/jpeg' }] }],
        }] }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const accountSection = container.querySelector<HTMLElement>('[aria-labelledby="lib-compact-title"]')!
      expect(accountSection.querySelector(`[data-gallery-card="kashmir"]`)).not.toBeNull()

      accountSection.querySelector<HTMLButtonElement>(`[aria-label="kashmir, in winter actions"]`)!.click()
      await settle()
      menuItem(container, 'Hide this gallery')!.click()
      await settle()

      // The PATCH went to the server; the refetch landed the flag and the
      // card moved to Hidden galleries.
      const hide = calls.find((call) => call.url.includes('/api/galleries/kashmir/hide'))
      expect(hide?.method).toBe('PATCH')
      expect(JSON.parse(hide?.body ?? '{}').hidden).toBe(true)
      const hiddenSection = container.querySelector<HTMLElement>('.lib-hidden-section')!
      expect(hiddenSection).not.toBeNull()
      hiddenSection.querySelector<HTMLButtonElement>('.lib-hidden-toggle')!.click()
      await settle()
      expect(hiddenSection.querySelector(`[data-gallery-card="kashmir"]`)).not.toBeNull()
      expect(container.querySelector('[aria-labelledby="lib-compact-title"] [data-gallery-card="kashmir"]')).toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a password gate on Hidden galleries asks before the section opens', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = (async () => new Response(JSON.stringify({ galleries: [] }), { status: 200 })) as unknown as typeof fetch
    try {
      const container = await mount(true, undefined, 'pro', {
        'library-prefs.json': JSON.stringify({
          version: 1,
          hidden: [`local:${GALLERY_ID}`],
          hiddenPassword: { salt: 'aa11', hash: await hashPassword('word', 'aa11') },
        }),
      })
      const toggle = () => container.querySelector<HTMLButtonElement>('.lib-hidden-toggle')!
      toggle().click()
      await settle()
      // The section stays shut until the password clears.
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
      const passwordField = () => container.querySelector<HTMLInputElement>('.m-sheet input[type="password"]')!
      expect(passwordField()).not.toBeNull()
      setInput(passwordField(), 'nope')
      await settle()
      sheetButton(container, 'Open')!.click()
      await settle()
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).toBeNull()
      // The sheet re-renders on the failed attempt — re-query the field.
      setInput(passwordField(), 'word')
      await settle()
      sheetButton(container, 'Open')!.click()
      await settle()
      expect(container.querySelector(`[data-gallery-card="${GALLERY_ID}"]`)).not.toBeNull()
      // Collapsing re-locks — the next open asks again.
      toggle().click()
      await settle()
      toggle().click()
      await settle()
      expect(container.querySelector('.m-sheet input[type="password"]')).not.toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
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

  test('a saved gallery opens from the vault — zero bytes over the wire', async () => {
    // Seed a complete saved copy through the real EncryptedVault: two image
    // entries plus the metadata entry that `open` verifies against. mount()
    // cannot be used — it reinstalls the seam and would wipe the seed — so
    // installTauri runs here and the render below repeats mount's tail.
    installTauri(true)
    const { desktopVault } = await import('../lib/vault')
    const { offlineGalleryId } = await import('../../native/lib/offline-gallery')
    const owner = 'thecontrarian'
    const slug = 'saved-album'
    const vaultGalleryId = await offlineGalleryId({ owner, slug })
    const still = (id: string) => ({
      id, filename: `${id}.jpg`, src: `https://media.example/${id}.jpg`,
      width: 4000, height: 3000, alt: id, c2pa: false,
      placeholder: 'data:image/svg+xml,%3Csvg/%3E',
    })
    const manifest = { slug, title: 'Saved Album', caption: '', date: '', images: [still('img-1'), still('img-2')] }
    const settings = {
      title: 'Saved Album', caption: '', date: '', curtainKicker: '', curtainPrompt: '',
      defaultMode: 'strip', defaultShowCaptions: false, defaultShowArrows: true,
      imageCaptions: {}, imageAlts: {},
    }
    await desktopVault.write(vaultGalleryId, 'thumb:img-1', new Uint8Array(64).fill(7))
    await desktopVault.write(vaultGalleryId, 'thumb:img-2', new Uint8Array(64).fill(9))
    await desktopVault.write(vaultGalleryId, 'offline-gallery:metadata:v1', new TextEncoder().encode(JSON.stringify({
      version: 1, owner, slug, manifest, settings,
      images: [
        { id: 'img-1', entryId: 'thumb:img-1', mimeType: 'image/jpeg' },
        { id: 'img-2', entryId: 'thumb:img-2', mimeType: 'image/jpeg' },
      ],
    })))
    // The lease materializes object URLs — happy-dom may not implement
    // createObjectURL, and the count is the proof bytes came out of the
    // vault, so a counting stand-in wraps whatever exists.
    let blobUrls = 0
    const priorCreateObjectURL = URL.createObjectURL
    URL.createObjectURL = ((...args: Parameters<typeof URL.createObjectURL>) => {
      blobUrls += 1
      return priorCreateObjectURL ? priorCreateObjectURL(...args) : `blob:vault-${blobUrls}`
    }) as typeof URL.createObjectURL
    if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {}

    const savedSummary = {
      id: 'gallery-0000-0000-0000-0000000000aa',
      slug, title: 'Saved Album', sourceUrl: null, caption: '',
      imageCount: 2, itemCount: 2,
      images: [{ id: 'img-1', src: 'https://media.example/img-1.jpg', width: 4000, height: 3000, hidden: false }],
      retention: 'permanent', expiresAt: null, pinnedAt: null, deviceLabel: null, layout: 'compact',
    }
    const calls: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      calls.push(String(url))
      const path = String(url)
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [savedSummary] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = dom.document.createElement('div') as unknown as HTMLElement
      dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
      mounts.mount(<Catalogue apiBase="https://manorama.xyz" />, container)
      await settle()

      // The badge is the saved-copy record surfacing on the card.
      const card = container.querySelector('[data-gallery-card="saved-album"]')
      expect(card?.querySelector('.desktop-badge-saved')).not.toBeNull()

      calls.length = 0
      card!.querySelector<HTMLAnchorElement>('a.lib-compact-cover')!.click()
      await settle()

      // The viewer mounted, vault bytes were materialized as object URLs,
      // and not one API call — manifest or media — left the device.
      expect(container.querySelector('.viewer-stage')).not.toBeNull()
      expect(calls.filter((url) => url.includes('/api/'))).toEqual([])
      expect(blobUrls).toBeGreaterThan(0)
    } finally {
      globals.fetch = defaultFetch
      URL.createObjectURL = priorCreateObjectURL
    }
  })

  test('a pinned account gallery renders its strip in Pinned galleries', async () => {
    const pinned = {
      id: 'gallery-0000-0000-0000-0000000000bb',
      slug: 'tcnwm', title: 'tech . city . night . work . m',
      sourceUrl: 'https://www.dropbox.com/scl/fo/o1sc4cp1sgfe4pnj7nf', caption: '',
      imageCount: 3, itemCount: 3,
      images: [
        { id: 'a1', filename: 'a1.jpg', src: '/api/dropbox/t/1', width: 4000, height: 3000, hidden: false },
        { id: 'a2', filename: 'a2.jpg', src: '/api/dropbox/t/2', width: 3000, height: 4000, hidden: false },
        { id: 'a3', filename: 'a3.jpg', src: '/api/dropbox/t/3', width: 4000, height: 3000, hidden: false },
      ],
      retention: 'retained', expiresAt: null, pinnedAt: '2026-11-09T10:38:58.024Z', deviceLabel: null, layout: 'compact',
    }
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string) => {
      const path = String(url)
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [pinned] }), { status: 200 })
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian' }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const section = container.querySelector('#pinned-galleries-title')?.closest('section')
      expect(section).not.toBeNull()
      const strip = section!.querySelector('.admin-gallery-strip')
      expect(strip?.querySelectorAll('.admin-gallery-strip-item').length).toBe(3)
      // …and the same gallery keeps its compact cover back in Cloud galleries.
      const cloud = container.querySelector('[aria-labelledby="lib-compact-title"]')
      const homeCard = cloud?.querySelector('[data-gallery-card="tcnwm"]')
      expect(homeCard?.classList.contains('lib-compact-card')).toBe(true)
      expect(homeCard?.querySelector('.admin-gallery-strip')).toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a synced remote-device Local gallery row exposes ··· → Remove gallery and DELETEs /api/device-galleries/:id', async () => {
    const remoteRow = {
      id: 'dddddddd-1111-4222-8333-444444444444',
      title: 'manorama-boundary-disposable',
      sourceKind: 'folder',
      itemCount: 12,
      deviceId: '99999999-1111-4222-8333-444444444444',
      deviceLabel: 'Test Runner Mac',
      updatedAt: '2026-11-09T18:00:00.000Z',
    }
    const deleted: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      const path = String(url)
      if (init?.method === 'DELETE' && path.includes('/api/device-galleries/')) {
        deleted.push(path)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [remoteRow] }), { status: 200 })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian', tier: 'pro' }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const card = container.querySelector<HTMLElement>(`[data-gallery-card="device:${remoteRow.id}"]`)
      expect(card).not.toBeNull()
      card!.querySelector<HTMLButtonElement>(`[aria-label="${remoteRow.title} actions"]`)!.click()
      await settle()
      menuItem(container, 'Remove gallery')!.click()
      await settle()
      menuItem(container, 'Remove gallery')!.click()
      await settle()
      expect(deleted).toEqual([`https://manorama.xyz/api/device-galleries/${remoteRow.id}`])
      expect(container.querySelector(`[data-gallery-card="device:${remoteRow.id}"]`)).toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a synced row naming this Mac is a ghost — it says so, offers Link folder, and linking reuses the row id', async () => {
    // The row an earlier install synced before its catalogue was rebuilt:
    // this device's own deviceId, with no local record left to stand for it.
    const ghost = {
      id: 'eeeeeeee-1111-4222-8333-555555555555',
      title: 'UGANDA',
      sourceKind: 'folder',
      itemCount: 28,
      deviceId: DEVICE_ID,
      deviceLabel: 'This Mac',
      updatedAt: '2026-11-14T13:50:00.000Z',
    }
    const puts: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = (async (url: string, init?: { method?: string }) => {
      const path = String(url)
      if (init?.method === 'PUT' && path.includes('/api/device-galleries/')) {
        puts.push(path)
        return new Response(JSON.stringify({ gallery: ghost }), { status: 200 })
      }
      if (path.endsWith('/api/device-galleries')) return new Response(JSON.stringify({ galleries: [ghost] }), { status: 200 })
      if (path.endsWith('/api/galleries')) return new Response(JSON.stringify({ galleries: [] }), { status: 200 })
      if (path.endsWith('/api/account')) return new Response(JSON.stringify({ ownerSlug: 'thecontrarian', tier: 'pro' }), { status: 200 })
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const container = await mount(true)
      const card = container.querySelector<HTMLElement>(`[data-gallery-card="device:${ghost.id}"]`)
      expect(card).not.toBeNull()
      // "Open it on that device" would send the owner looking for a machine
      // that does not exist — the ghost copy says what actually happened.
      expect(card!.textContent).toContain('on this Mac')
      expect(card!.textContent).not.toContain('open it on that device')
      const link = card!.querySelector<HTMLButtonElement>('.lib-card-action')
      expect(link).not.toBeNull()
      pickedFolder = '/Users/home/Pictures/uganda'
      dirs['/Users/home/Pictures/uganda'] = [
        { name: 'MS202201-uganda01.jpg', isDirectory: false, isFile: true },
        { name: 'MS202201-uganda02.jpg', isDirectory: false, isFile: true },
      ]
      link!.click()
      await settle()
      // The record reuses the row's id, so the routine sync PUTs over the
      // ghost rather than leaving a second stale mirror behind.
      const saved = JSON.parse(files['catalogue.json']!) as { galleries: { id: string; title: string; rootPath: string }[] }
      const linked = saved.galleries.find((gallery) => gallery.id === ghost.id)
      expect(linked?.rootPath).toBe('/Users/home/Pictures/uganda')
      expect(linked?.title).toBe('UGANDA')
      expect(puts).toContain(`https://manorama.xyz/api/device-galleries/${ghost.id}`)
      // And the ghost card is a real local card now.
      expect(container.querySelector(`[data-gallery-card="device:${ghost.id}"]`)).toBeNull()
      expect(container.querySelector(`.lib-compact-card[data-gallery-card="${ghost.id}"]`)).not.toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })
})

/** The account's second Mac — same kind, its own number and colour. */
const otherDevice = {
  id: '99999999-1111-4222-8333-444444444444',
  kind: 'mac',
  ordinal: 2,
  colour: 1,
  firstSeenAt: '2026-10-02T00:00:00.000Z',
  lastSeenAt: '2026-11-09T18:00:00.000Z',
}

const remoteRow = {
  id: 'dddddddd-1111-4222-8333-444444444444',
  title: 'manorama-boundary-disposable',
  sourceKind: 'folder' as const,
  itemCount: 12,
  deviceId: otherDevice.id,
  updatedAt: '2026-11-09T18:00:00.000Z',
}

/** A fetch stub that answers the device list, the mirrors, the account and
 *  the gallery feed — the four reads the Library makes. */
const accountFetch = (options: {
  devices?: unknown[]
  mirrors?: unknown[]
  onPut?: (url: string, body: string) => void
  onDelete?: (url: string) => void
} = {}) => (async (url: string, init?: RequestInit) => {
  const path = String(url)
  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (init?.method === 'PUT' && /\/api\/devices\/[^/]+$/.test(path)) {
    options.onPut?.(path, String(init.body ?? ''))
    return json({ device: selfDevice })
  }
  if (init?.method === 'DELETE' && /\/api\/devices\/[^/]+$/.test(path)) {
    options.onDelete?.(path)
    return json({ ok: true })
  }
  if (path.endsWith('/api/devices')) return json({ devices: options.devices ?? [selfDevice] })
  if (path.endsWith('/api/device-galleries')) return json({ galleries: options.mirrors ?? [] })
  if (path.endsWith('/api/account')) return json({ ownerSlug: 'thecontrarian', tier: 'pro' })
  if (path.endsWith('/api/galleries')) return json({ galleries: [] })
  return json({})
}) as unknown as typeof fetch

describe('desktop device legend', () => {
  test('the rail lists the account’s devices under the vault meter, one colour each', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = accountFetch({ devices: [selfDevice, otherDevice] })
    try {
      const container = await mount(true)
      const rail = container.querySelector<HTMLElement>('.admin-rail')!
      const legend = rail.querySelector<HTMLElement>('.lib-devices-legend')!
      expect(legend).not.toBeNull()
      const html = container.innerHTML
      expect(html.indexOf('lib-vault-tracker')).toBeLessThan(html.indexOf('lib-devices-legend'))
      expect(html.indexOf('lib-devices-legend')).toBeLessThan(html.indexOf('admin-copyright'))
      // Two Macs, two colours — never the same pill twice.
      const colours = [...legend.querySelectorAll('.device-pill')].map((pill) => pill.getAttribute('data-colour'))
      expect(colours).toEqual(['0', '1'])
      expect(legend.textContent).toContain('Mac 1')
      expect(legend.textContent).toContain('Mac 2')
      expect(legend.textContent).toContain('this Mac')
      // Forget is offered for the other Mac only.
      expect(legend.querySelectorAll('.lib-devices-legend-forget')).toHaveLength(1)
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('Forget DELETEs the device and drops it from the legend', async () => {
    const deleted: string[] = []
    const defaultFetch = globals.fetch
    globals.fetch = accountFetch({ devices: [selfDevice, otherDevice], onDelete: (url) => deleted.push(url) })
    try {
      const container = await mount(true)
      container.querySelector<HTMLButtonElement>('.lib-devices-legend-forget')!.click()
      await settle()
      expect(deleted).toEqual([`https://manorama.xyz/api/devices/${otherDevice.id}`])
      const legend = container.querySelector<HTMLElement>('.lib-devices-legend')!
      expect(legend.textContent).not.toContain('Mac 2')
      expect(legend.textContent).toContain('this Mac')
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('launch registers this Mac with its kind and nothing else', async () => {
    const puts: { url: string; body: string }[] = []
    const defaultFetch = globals.fetch
    globals.fetch = accountFetch({ onPut: (url, body) => puts.push({ url, body }) })
    try {
      await mount(true)
      expect(puts).toHaveLength(1)
      expect(puts[0]!.url).toBe(`https://manorama.xyz/api/devices/${DEVICE_ID}`)
      expect(JSON.parse(puts[0]!.body)).toEqual({ kind: 'mac' })
    } finally {
      globals.fetch = defaultFetch
    }
  })

  test('a Local gallery on another device is a super-compact tile with its pill and no cover', async () => {
    const defaultFetch = globals.fetch
    globals.fetch = accountFetch({ devices: [selfDevice, otherDevice], mirrors: [remoteRow] })
    try {
      const container = await mount(true)
      const tile = container.querySelector<HTMLElement>(`[data-gallery-card="device:${remoteRow.id}"]`)!
      expect(tile.classList.contains('lib-device-card')).toBe(true)
      expect(tile.classList.contains('lib-card')).toBe(false)
      expect(tile.querySelector('img')).toBeNull()
      expect(tile.textContent).toContain('12 photographs')
      expect(tile.querySelector('.device-pill')?.getAttribute('data-colour')).toBe('1')
      expect(tile.textContent).toContain('Mac 2')
      // The tile keeps the ··· menu so a remote row stays removable here.
      expect(tile.querySelector(`[aria-label="${remoteRow.title} actions"]`)).not.toBeNull()
    } finally {
      globals.fetch = defaultFetch
    }
  })
})

describe('the Library quiet view', () => {
  test('the rail toggle fades the gallery list and sinks the rail with it', async () => {
    const container = await mount(true)
    const toggle = container.querySelector<HTMLButtonElement>('.lib-quiet-toggle')!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    const list = container.querySelector<HTMLElement>('.gallery-list')!
    const rail = container.querySelector<HTMLElement>('.admin-rail')!
    expect(list.classList.contains('lib-quiet')).toBe(false)

    toggle.click()
    await settle()
    expect(list.classList.contains('lib-quiet')).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    // The rail sinks as one piece — it is not quieted, and the way back
    // lifts back to half-dim on hover so it stays findable.
    expect(rail.classList.contains('lib-quiet-rail')).toBe(true)
    expect(rail.classList.contains('lib-quiet')).toBe(false)
    expect(rail.querySelector('.lib-quiet')).toBeNull()
    expect(rail.textContent).toContain('Library')

    toggle.click()
    await settle()
    expect(list.classList.contains('lib-quiet')).toBe(false)
    expect(rail.classList.contains('lib-quiet-rail')).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  test('the stylesheet fades text and chrome to a whisper, sinks the rail to a whisper, but never a photograph', () => {
    const css = readFileSync(new URL('../../app/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('.lib-quiet, .lib-quiet *')
    expect(css).toContain('-webkit-text-fill-color: currentColor')
    expect(css).toContain('-webkit-text-fill-color: rgba(var(--ink), .05) !important')
    expect(css).not.toMatch(/\n\s+color: rgba\(var\(--ink\), \.05\) !important/)
    expect(css).toContain('.lib-quiet :where(svg, .device-pill')
    // The fade animates as a curtain — the transition lives on the
    // un-quieted elements so it eases in both directions — and the
    // photographs step a touch brighter while the words sink.
    expect(css).toContain('transition: -webkit-text-fill-color .7s cubic-bezier(.4, 0, .2, 1)')
    expect(css).toContain('.lib-quiet img { filter: brightness(1.12); }')
    // No image dims; the rail recedes as one dimmed piece on the same
    // clock rather than quieting element by element.
    expect(css).not.toMatch(/\.lib-quiet[^{}]*img[^{}]*opacity/)
    expect(css).toContain('.admin-rail { min-width: 0; transition: opacity .7s cubic-bezier(.4, 0, .2, 1); }')
    expect(css).toContain('.lib-quiet-rail { opacity: .05; }')
    // Hover and keyboard focus both restore the rail — a tabbed-in user
    // must never aim at a nearly invisible surface.
    expect(css).toContain('.lib-quiet-rail:hover, .lib-quiet-rail:focus-within { opacity: .5; }')
    expect(css).toContain('.lib-quiet-toggle')
  })
})
