import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import GallerySettingsSheet from './GallerySettingsSheet'
import { releaseAllOverlays } from '../lib/overlay-stack'
import type { OwnerGalleryPanelProps } from './viewer/OwnerGalleryPanel'

/**
 * The Library's gallery settings sheet runs the viewer's two-layer
 * drill: the front layer's quick actions (share, reorder, refresh)
 * under the gallery head, "More Settings" holding the rest. One panel
 * instance owns both layers, so an in-flight refresh survives the
 * round trip instead of being discarded with the unmounted quick layer.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const REPLACED_GLOBALS = [
  'window', 'document', 'fetch', 'SVGElement', 'HTMLElement',
  'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
] as const

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []

const panel: OwnerGalleryPanelProps = {
  owner: 'thecontrarian',
  slug: 'mixed',
  title: 'Mixed album',
  caption: 'A quiet set',
  sourceLabel: 'Dropbox',
  temporary: false,
  expiresAt: null,
  mediaCount: { stills: 24, videos: 1, hidden: 0 },
  libraryHref: '/thecontrarian',
  onReorder: () => {},
  currentPhotoId: () => 'photo-3',
  onTitleSaved: () => {},
  onRefreshed: () => {},
}

const mounted = () => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    render(<GallerySettingsSheet open onClose={() => {}} {...panel} />, container as unknown as HTMLElement)
  })
  return container as unknown as HTMLElement
}

/** The action row whose text carries `label`. */
const row = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLElement>(`.m-actionrow`)].find((node) => node.textContent?.includes(label))
/** Lets hono's async effect re-arm settle between interactions. */
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(() => {}) }

beforeAll(() => {
  prev = Object.fromEntries(REPLACED_GLOBALS.map((key) => [key, globals[key]]))
  dom = new Window({ url: 'http://localhost/thecontrarian' })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({}), { status: 200 })
  }) as unknown as typeof fetch
})

afterAll(() => {
  for (const key of REPLACED_GLOBALS) globals[key] = prev[key]
})

afterEach(() => {
  releaseAllOverlays()
  dom.document.body.innerHTML = ''
  calls = []
})

describe('the Library gallery settings sheet', () => {
  test('the front layer carries the quick actions and drills into the rest', async () => {
    const root = mounted()
    for (const label of ['Share link', 'Reorder photographs', 'Refresh gallery contents', 'More Settings']) {
      expect(row(root, label)).toBeTruthy()
    }
    // The front layer never shows the management rows.
    expect(row(root, 'Name')).toBeUndefined()
    expect(row(root, 'Remove from Library')).toBeUndefined()

    flushSync(() => row(root, 'More Settings')?.click())
    await settle()
    expect(row(root, 'Name')).toBeTruthy()
    expect(row(root, 'Address')).toBeTruthy()
    expect(row(root, 'Remove from Library')).toBeTruthy()
    // The quick rows are gone from the rest layer — one panel, one slice.
    expect(row(root, 'Share link')).toBeUndefined()
    expect(row(root, 'Refresh gallery contents')).toBeUndefined()
    // Focus moved to the rest layer's heading.
    expect(dom.document.activeElement?.textContent).toBe('More Settings')

    const back = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Gallery Settings')!
    flushSync(() => back.click())
    await settle()
    expect(row(root, 'Refresh gallery contents')).toBeTruthy()
    expect(row(root, 'Name')).toBeUndefined()
    // Focus returned to the More Settings row.
    expect(dom.document.activeElement?.closest('.m-actionrow')?.textContent).toContain('More Settings')
  })

  test('an in-flight refresh survives the drill instead of resetting', async () => {
    const realFetch = globals.fetch
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    globals.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/refresh')) return gate
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const root = mounted()
      flushSync(() => row(root, 'Refresh gallery contents')?.click())
      await settle()
      expect(row(root, 'Refreshing')?.textContent).toContain('Refreshing…')

      // Drill in and back while the scan is still running — the row must
      // come back busy, not silently reset to idle.
      flushSync(() => row(root, 'More Settings')?.click())
      await settle()
      const back = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Gallery Settings')!
      flushSync(() => back.click())
      await settle()
      const busy = row(root, 'Refreshing') as HTMLButtonElement | undefined
      expect(busy?.textContent).toContain('Refreshing…')
      expect(busy?.disabled).toBe(true)

      // The failure lands on the same panel that started the request.
      release(new Response(JSON.stringify({ error: 'scan failed' }), { status: 500 }))
      await settle()
      expect(row(root, 'Refresh gallery contents')).toBeTruthy()
      expect(root.querySelector('[role="alert"]')?.textContent).toBe('scan failed')
    } finally {
      globals.fetch = realFetch
    }
  })
})
