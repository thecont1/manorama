import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import OwnerGalleryPanel, { type OwnerGalleryPanelProps } from './OwnerGalleryPanel'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
let assigned: string[] = []
let replaced: string[] = []

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch,
  }
  dom = new Window({ url: 'http://localhost/thecontrarian/mixed' })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ gallery: { slug: 'renamed', title: 'New name', caption: 'New caption' } }), { status: 200 })
  }) as unknown as typeof fetch
  // The panel navigates on rename and delete — record the calls instead.
  ;(dom.location as unknown as { assign: (u: string) => void }).assign = (u: string) => { assigned.push(u) }
  ;(dom.location as unknown as { replace: (u: string) => void }).replace = (u: string) => { replaced.push(u) }
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.svg
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.fetch = prev.fetch
})

const base: OwnerGalleryPanelProps = {
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
}

const mounted = (overrides: Partial<typeof base> = {}) => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    render(<OwnerGalleryPanel {...base} {...overrides} />, container as unknown as HTMLElement)
  })
  return container as unknown as HTMLElement
}

const row = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLElement>('.m-actionrow')].find((node) => node.textContent?.includes(label))
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(() => {}) }
const bodies = (method: string) =>
  calls.filter((call) => call.init?.method === method).map((call) => JSON.parse(String(call.init?.body ?? '{}')))

describe('the web owner panel', () => {
  test('renders the header meta and every management row', () => {
    const root = mounted()
    expect(root.textContent).not.toContain('This gallery')
    expect(root.textContent).toContain('Mixed album')
    expect(root.textContent).toContain('24 photographs · 1 video · Dropbox')
    for (const label of ['Share link', 'Name', 'Caption', 'Address', 'Reorder photographs', 'Read the folder again', 'Remove gallery']) {
      expect(row(root, label)).toBeTruthy()
    }
    expect(root.querySelector('.m-owner-panel-note')?.textContent).toContain('Removing it leaves every photograph in Dropbox.')
  })

  test('a present caption reads in full on the head — the row never ellipsizes it', () => {
    const root = mounted()
    expect(root.querySelector('.m-owner-panel-cap')?.textContent).toBe('A quiet set')
    // The Caption row keeps only its empty state — a real caption never
    // appears inside an m-actionrow-value cell where it would truncate.
    expect(row(root, 'Caption')?.querySelector('.m-actionrow-value')).toBeNull()
    const bare = mounted({ caption: '' })
    expect(bare.querySelector('.m-owner-panel-cap')).toBeNull()
    expect(row(bare, 'Caption')?.querySelector('.m-actionrow-value')?.textContent).toBe('None')
  })

  test('the Open row only renders when a host asks for it', () => {
    const inside = mounted()
    expect(row(inside, 'Open gallery')).toBeFalsy()
    const library = mounted({ onOpen: () => {} })
    expect(row(library, 'Open gallery')).toBeTruthy()
  })

  test('name and caption PATCH their own field and report through onTitleSaved', async () => {
    calls = []
    const saved: string[] = []
    const root = mounted({ onTitleSaved: (title: string) => saved.push(title) })
    flushSync(() => row(root, 'Name')?.click())
    const input = root.querySelector<HTMLInputElement>('.m-owner-edit input')!
    input.value = 'New name'
    flushSync(() => input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event))
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click() })
    await settle()
    expect(bodies('PATCH')).toEqual([{ title: 'New name' }])
    expect(saved).toEqual(['New name'])

    flushSync(() => row(root, 'Caption')?.click())
    const area = root.querySelector<HTMLTextAreaElement>('.m-owner-edit textarea')!
    area.value = 'New caption'
    flushSync(() => area.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event))
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click() })
    await settle()
    expect(bodies('PATCH')).toEqual([{ title: 'New name' }, { caption: 'New caption' }])
  })

  test('an invalid address shows its message without fetching', async () => {
    calls = []
    const root = mounted()
    flushSync(() => row(root, 'Address')?.click())
    const input = root.querySelector<HTMLInputElement>('.m-owner-edit input')!
    input.value = 'Not A Slug!'
    flushSync(() => input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event))
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click() })
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('Use lowercase letters, numbers, and single hyphens for the gallery URL')
    expect(calls).toEqual([])
  })

  test('a valid address PATCHes newSlug and replaces the location', async () => {
    calls = []; replaced = []
    const root = mounted()
    flushSync(() => row(root, 'Address')?.click())
    const input = root.querySelector<HTMLInputElement>('.m-owner-edit input')!
    input.value = 'renamed'
    flushSync(() => input.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event))
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.click() })
    await settle()
    expect(bodies('PATCH')).toEqual([{ newSlug: 'renamed' }])
    expect(replaced).toEqual(['/thecontrarian/renamed?photo=photo-3'])
  })

  test('Read the folder again POSTs bare for an ordinary source', async () => {
    calls = []
    const root = mounted()
    flushSync(() => row(root, 'Read the folder again')?.click())
    await settle()
    const refresh = calls.filter((call) => call.url === '/api/galleries/mixed/refresh')
    expect(refresh.length).toBe(1)
    expect(refresh[0].init?.method).toBe('POST')
    expect(refresh[0].init?.body).toBeUndefined()
  })

  test('an encrypted source without the key explains instead of fetching', async () => {
    calls = []
    // No fragment — the manifest URL is keyless, so the key must come from
    // this device's store, which is empty in the test.
    const root = mounted({ galleryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sourceUrl: 'https://mega.nz/folder/28NkBZqD' })
    flushSync(() => row(root, 'Read the folder again')?.click())
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('does not hold the key')
    expect(calls).toEqual([])
  })

  test('temporary galleries lock the edit rows but keep Share and Remove', () => {
    const root = mounted({ temporary: true, expiresAt: '2026-11-01T00:00:00.000Z' })
    expect(root.textContent).toContain('Temporary gallery · expires 2026-11-01')
    expect(root.textContent).toContain('temporary gallery cannot be edited')
    for (const label of ['Name', 'Caption', 'Address', 'Reorder photographs', 'Read the folder again']) {
      const button = row(root, label) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    }
    expect((row(root, 'Share link') as HTMLButtonElement).disabled).toBe(false)
    expect((row(root, 'Remove gallery') as HTMLButtonElement).disabled).toBe(false)
    expect(root.querySelector('.m-owner-panel-lock a')?.getAttribute('href')).toBe('/thecontrarian')
  })

  test('remove asks inline, then DELETEs and lands on the library', async () => {
    calls = []; assigned = []
    const root = mounted()
    flushSync(() => row(root, 'Remove gallery')?.click())
    expect(root.textContent).toContain('Remove “Mixed album”?')
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Remove')?.click() })
    await settle()
    expect(calls.filter((call) => call.init?.method === 'DELETE').map((call) => call.url)).toEqual(['/api/galleries/mixed'])
    expect(assigned).toEqual(['/thecontrarian'])
  })

  test('Escape in an editor cancels the edit only', () => {
    const root = mounted()
    flushSync(() => row(root, 'Name')?.click())
    const input = root.querySelector<HTMLInputElement>('.m-owner-edit input')!
    const editor = input.closest('[data-escape-owner]')
    expect(editor).toBeTruthy()
    // The marker is what keeps the sheet's capture-phase Escape handler
    // from closing the popover; stopPropagation covers the viewer's own.
    flushSync(() => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event))
    expect(root.querySelector('.m-owner-edit')).toBeNull()
    expect(row(root, 'Name')).toBeTruthy()
    // And the panel itself is still mounted — nothing closed underneath.
    expect(root.querySelector('.m-owner-panel')).toBeTruthy()
  })
})
