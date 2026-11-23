/**
 * The fixture the desktop acceptance specs share.
 *
 * The desktop bundle is a client-only SPA: outside the Tauri webview its IPC
 * bridge is absent, so the shell would stop at the welcome screen. These specs
 * install the bridge before any page script runs and answer the handful of
 * commands the catalogue actually calls. Everything asserted on top of it is
 * then the real bundle's own behaviour, not a fixture's.
 *
 * Two catalogues live here. The synthetic one is enough for the shell, the pane
 * and the theme vocabulary. The rail's geometry is measured against the owner's
 * own photographs on disk (`buildCatalogue` + `servePhotos`), because heights
 * and aspect-true widths are only meaningful against real files.
 *
 * Deliberately not named `*.playwright.ts` — Playwright's testMatch would try
 * to collect it as a spec.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

/** A 1x1 transparent GIF — the asset protocol's stand-in, so a thumbnail
 *  paints without reaching for a file the browser cannot read. */
export const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

export const GALLERY_ID = '11111111-2222-4333-8444-555555555555'
export const GALLERY_ID_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa'

export const catalogue = {
  version: 1,
  deviceId: 'f8e9e5ce-b31a-41a1-b4cd-5261fb3d48f2',
  deviceLabel: 'This Mac',
  galleries: [
    {
      id: GALLERY_ID,
      title: 'Bangkok Rain',
      rootPath: '/Users/photographer/Pictures/Bangkok Rain',
      sourceKind: 'folder',
      itemCount: 25,
      items: [
        { id: `${GALLERY_ID}-1`, name: 'IMG_0001.jpg', path: '/Users/photographer/Pictures/Bangkok Rain/IMG_0001.jpg', width: 4000, height: 2667 },
        { id: `${GALLERY_ID}-2`, name: 'IMG_0002.jpg', path: '/Users/photographer/Pictures/Bangkok Rain/IMG_0002.jpg', width: 2667, height: 4000 },
      ],
      addedAt: '2026-10-11T05:00:00.000Z',
      lastSeenAt: '2026-10-11T05:00:00.000Z',
      // A pin so both card forms render: this gallery rides the strip in
      // "Pinned galleries" and keeps its compact card under "Local
      // galleries", where the other sits compact alone.
      pinnedAt: '2026-10-11T06:00:00.000Z',
    },
    {
      id: GALLERY_ID_TWO,
      title: 'Monsoon Card',
      rootPath: '/Volumes/NO NAME/DCIM',
      sourceKind: 'card',
      mountPoint: '/Volumes/NO NAME',
      itemCount: 1,
      items: [
        { id: `${GALLERY_ID_TWO}-1`, name: 'DSC_0001.jpg', path: '/Volumes/NO NAME/DCIM/DSC_0001.jpg', width: 6000, height: 4000 },
      ],
      addedAt: '2026-10-10T05:00:00.000Z',
      lastSeenAt: '2026-10-10T05:00:00.000Z',
    },
  ],
}

/** A signed-in session, plan included — the shape the exchange writes. */
export const session = { token: 'test-session-token', ownerSlug: 'thecontrarian', tier: 'pro' }

/** One `plugin:fs|read_dir` answer — the fields `scanLocalDirectory` reads. */
export type FixtureDirEntry = {
  name: string
  isDirectory: boolean
  isFile: boolean
  width?: number
  height?: number
}

type BridgePayload = {
  catalogue: string
  session: string
  pixel: string
  photos?: boolean
  /** Drop-scan fixtures: absolute folder path → the directory listing the
   *  bridge answers for it. Absent paths still answer empty. */
  dirs?: Record<string, FixtureDirEntry[]>
  /** Per-path read_dir delay in ms — holds a scan mid-flight so a spec can
   *  photograph the sheet's skeleton state deterministically. */
  dirDelay?: Record<string, number>
}

/** Injected into the page before any script runs. Its payload arrives as an
 *  argument because an init script is serialized, not called: anything it
 *  closes over would be missing in the browser. */
export const installBridge = (payload: BridgePayload) => {
  const vaultFiles = new Map<string, Uint8Array>()
  const vaultKeys = new Map<string, string>()
  ;(window as unknown as Record<string, unknown>).__vaultWrites = []
  // The event plugin's listener table, replicated: `plugin:event|listen`
  // records which transformCallback id each event name routes to, and
  // `__manoramaEmitEvent` delivers `{event, id, payload}` to them exactly
  // like the shell's own emitter does for `manorama://` events.
  const eventHandlers = new Map<string, Set<number>>()
  const eventListeners = new Map<number, { event: string; handler: number }>()
  const eventCallbacks = new Map<number, (payload: unknown) => void>()
  const dropCalls: { command: string; args?: Record<string, unknown> }[] = []
  ;(window as unknown as Record<string, unknown>).__dropCalls = dropCalls
  let nextEventCallback = 1
  let nextEventId = 1
  ;(window as unknown as Record<string, unknown>).__manoramaEmitEvent = (event: string, eventPayload: unknown) => {
    for (const id of eventHandlers.get(event) ?? []) {
      eventCallbacks.get(id)?.({ event, id, payload: eventPayload })
    }
  }
  const internals = {
    transformCallback: (callback: unknown, once?: boolean) => {
      const id = nextEventCallback++
      ;(window as unknown as Record<string, unknown>)[`_${id}`] = callback
      if (typeof callback === 'function') {
        eventCallbacks.set(id, callback as (payload: unknown) => void)
      }
      return id
    },
    // The synthetic catalogue paints the stand-in pixel; the real-photograph
    // catalogue points at `/photos/<name>`, which the spec answers from disk.
    convertFileSrc: (path: string) => (payload.photos
      ? `/photos/${encodeURIComponent(String(path).split('/').pop() ?? '')}`
      : payload.pixel),
    invoke: async (cmd: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
      // The Rust vault seam, replicated in memory: writes carry their path
      // in a header and their ciphertext as the raw body; reads return the
      // stored bytes or null when absent.
      if (cmd === 'vault_write') {
        const path = String(options?.headers?.['x-vault-path'] ?? '')
        vaultFiles.set(path, args instanceof Uint8Array ? args : new Uint8Array(args as ArrayBuffer))
        ;((window as unknown as Record<string, unknown>).__vaultWrites as string[]).push(path)
        return null
      }
      if (cmd === 'vault_read') {
        const bytes = vaultFiles.get(String((args as Record<string, unknown>)?.path))
        return bytes ?? null
      }
      if (cmd === 'vault_move') {
        const { from, to } = (args ?? {}) as { from?: string; to?: string }
        const bytes = vaultFiles.get(String(from))
        if (bytes) { vaultFiles.set(String(to), bytes); vaultFiles.delete(String(from)) }
        return null
      }
      if (cmd === 'vault_remove') {
        vaultFiles.delete(String((args as Record<string, unknown>)?.path))
        return null
      }
      if (cmd === 'vault_list') {
        return [...vaultFiles.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length }))
      }
      if (cmd === 'vault_key_get') return vaultKeys.get(String((args as Record<string, unknown>)?.name)) ?? null
      if (cmd === 'vault_key_set') { vaultKeys.set(String((args as Record<string, unknown>)?.name), String((args as Record<string, unknown>)?.value)); return null }
      if (cmd === 'vault_key_remove') { vaultKeys.delete(String((args as Record<string, unknown>)?.name)); return null }
      if (cmd === 'vault_log') return null
      if (cmd === 'read_private_file') {
        const name = String(args?.name ?? '')
        if (name === 'catalogue.json') return payload.catalogue
        if (name === 'session.json') return payload.session
        return null
      }
      if (cmd === 'write_private_file' || cmd === 'delete_private_file') return null
      if (cmd === 'register_saved_gallery_roots') return null
      if (cmd === 'pick_gallery_root') return null
      if (cmd === 'plugin:event|listen') {
        const record = args as Record<string, unknown> | undefined
        const event = String(record?.event ?? '')
        const handler = Number(record?.handler)
        const eventId = nextEventId++
        if (event && handler) {
          let set = eventHandlers.get(event)
          if (!set) { set = new Set(); eventHandlers.set(event, set) }
          set.add(handler)
          eventListeners.set(eventId, { event, handler })
        }
        return eventId
      }
      if (cmd === 'plugin:event|unlisten') {
        const record = args as Record<string, unknown> | undefined
        const listener = eventListeners.get(Number(record?.eventId))
        if (listener) {
          eventListeners.delete(Number(record?.eventId))
          eventHandlers.get(listener.event)?.delete(listener.handler)
        }
        return null
      }
      // The drop grant seam: commit answers every path it was handed (the
      // shell books each still-pending path), discard is bookkeeping the
      // spec reads back through `__dropCalls`.
      if (cmd === 'commit_dropped_roots' || cmd === 'discard_dropped_roots') {
        dropCalls.push({ command: cmd, args })
        return cmd === 'commit_dropped_roots' ? ((args as Record<string, unknown> | undefined)?.paths ?? []) : null
      }
      if (cmd === 'plugin:fs|exists') return true
      if (cmd === 'plugin:fs|read_dir') {
        const path = String((args as Record<string, unknown> | undefined)?.path ?? '')
        const delay = payload.dirDelay?.[path] ?? 0
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        return payload.dirs?.[path] ?? []
      }
      return null
    },
  }
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals
  // The event plugin's unregister hook — only reached when a listener is
  // removed; the fixture's own table does the real bookkeeping.
  ;(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  }
}

export const bridgePayload: BridgePayload = {
  catalogue: JSON.stringify(catalogue),
  session: JSON.stringify(session),
  pixel: PIXEL,
}

/** The bundle's default API base is production; no spec may reach it. The
 *  catalogue's sync seam is answered locally instead. */
export const blockProductionApi = async (page: Pick<Page, 'route'>): Promise<{ calls: () => number }> => {
  let calls = 0
  await page.route('https://manorama.xyz/**', (route) => {
    calls += 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  // The app-freshness check would otherwise hit the live release feed and
  // insert the update banner mid-test — a real release once published
  // every Library fixture mid-flow.
  await page.route('https://downloads.manorama.xyz/latest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  return { calls: () => calls }
}

// --- the rail's real-photograph catalogue -----------------------------------

export type FixturePhoto = { id: string; name: string; path: string; width: number; height: number }

/** Formats the browsers in this suite decode. HEIC is deliberately absent:
 *  Chromium cannot read it, and a fixture the browser refuses to paint would
 *  look like a layout failure. */
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']

const readDims = (path: string): { width: number; height: number } | null => {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' })
  const width = /pixelWidth:\s*(\d+)/.exec(out)?.[1]
  const height = /pixelHeight:\s*(\d+)/.exec(out)?.[1]
  if (!width || !height) return null
  return { width: Number(width), height: Number(height) }
}

/**
 * The owner's own photographs, read-only, straight off disk. The albums under
 * Dropbox `CloudStorage` are dataless placeholders on this machine (0 bytes on
 * disk, `sips` reports `<nil>`), so a folder whose pixels are actually present
 * is required — resizing or re-encoding here would invalidate every geometry
 * assertion the rail makes.
 */
export const photosFrom = (source: string, count: number): FixturePhoto[] =>
  readdirSync(source)
    .filter((name) => PHOTO_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension)))
    .sort()
    .map((name) => ({ name, path: join(source, name), dims: readDims(join(source, name)) }))
    .filter((photo): photo is { name: string; path: string; dims: { width: number; height: number } } => photo.dims !== null)
    .slice(0, count)
    .map((photo, index) => ({ id: `photo-${index + 1}`, name: photo.name, path: photo.path, ...photo.dims }))

/** A catalogue whose first gallery is the real photographs and whose second is
 *  a memory card, so one fixture covers a folder source and a card source. */
export const buildCatalogue = (photos: FixturePhoto[], source: string) => ({
  version: 1,
  deviceId: 'f8e9e5ce-b31a-41a1-b4cd-5261fb3d48f2',
  deviceLabel: 'This Mac',
  galleries: [
    {
      id: GALLERY_ID,
      // The title `galleryTitleForRoot` derives from the folder, so the card,
      // the caption's path and the app's own naming all agree.
      title: 'Pictures',
      rootPath: source,
      sourceKind: 'folder',
      itemCount: photos.length,
      items: photos,
      addedAt: '2026-10-11T05:00:00.000Z',
      lastSeenAt: '2026-10-11T05:00:00.000Z',
      // A pin so both card forms render: this gallery rides the strip in
      // "Pinned galleries" and keeps its compact card under "Local
      // galleries", where the other sits compact alone.
      pinnedAt: '2026-10-11T06:00:00.000Z',
    },
    {
      id: GALLERY_ID_TWO,
      title: 'Monsoon Card',
      rootPath: '/Volumes/NO NAME/DCIM',
      sourceKind: 'card',
      mountPoint: '/Volumes/NO NAME',
      itemCount: 1,
      items: [{ id: `${GALLERY_ID_TWO}-1`, name: 'DSC_0001.jpg', path: '/Volumes/NO NAME/DCIM/DSC_0001.jpg', width: 6000, height: 4000 }],
      addedAt: '2026-10-10T05:00:00.000Z',
      lastSeenAt: '2026-10-10T05:00:00.000Z',
    },
  ],
})

/** The bridge for a real-photograph catalogue. `dirs` feeds folder-drop
 *  scans; `dirDelay` holds one mid-flight for the skeleton-state capture. */
export const photoBridgePayload = (
  built: ReturnType<typeof buildCatalogue>,
  extras?: { dirs?: BridgePayload['dirs']; dirDelay?: BridgePayload['dirDelay'] },
): BridgePayload => ({
  catalogue: JSON.stringify(built),
  session: JSON.stringify(session),
  pixel: PIXEL,
  photos: true,
  ...extras,
})

/** Answers `/photos/<name>` with the original's own bytes, read from disk and
 *  handed to the browser untouched. */
export const servePhotos = async (page: Pick<Page, 'route'>, photos: FixturePhoto[]): Promise<void> => {
  await page.route('**/photos/*', (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.replace('/photos/', ''))
    const photo = photos.find((candidate) => candidate.name === name)
    if (!photo) return route.fulfill({ status: 404, body: 'not in the fixture' })
    return route.fulfill({ path: photo.path })
  })
}