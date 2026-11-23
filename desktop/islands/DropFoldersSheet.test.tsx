import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { unmountTracker } from '../../test/unmount'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import { DropFoldersSheet, DropVeil } from './DropFoldersSheet'
import type { DroppedFolderCandidate } from '../lib/folder-drop'
import type { LocalGalleryRecord } from '../lib/catalogue'
import type { LocalGalleryItem } from '../lib/local-scan'

/**
 * DropFoldersSheet is presentational: rows, selection and callbacks are its
 * whole contract, so it is exercised mounted — the Sheet's focus/overlay
 * lifecycle included — rather than stringified.
 */

const globals = globalThis as Record<string, unknown>

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const item = (id: string, width = 4000, height = 3000): LocalGalleryItem => ({
  id,
  name: id,
  path: `/drop/src/${id}`,
  width,
  height,
})

const candidate = (over: Partial<DroppedFolderCandidate> = {}): DroppedFolderCandidate => ({
  path: '/drop/alpha',
  title: 'alpha',
  sourceKind: 'folder',
  items: [item('a.jpg'), item('b.jpg'), item('c.jpg')],
  itemCount: 3,
  state: 'new',
  ...over,
})

const existingRecord = (over: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Already Here',
  rootPath: '/drop/beta',
  sourceKind: 'folder',
  itemCount: 7,
  items: [item('old.jpg', 2000, 2000)],
  addedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

type Props = Parameters<typeof DropFoldersSheet>[0]

const mount = (overrides: Partial<Props> = {}) => {
  const calls = { toggles: [] as string[], selectAll: [] as boolean[], cancel: 0, add: 0 }
  const props: Props = {
    open: true,
    paths: ['/drop/alpha', '/drop/beta'],
    candidates: [candidate()],
    selected: new Set(['/drop/alpha']),
    committing: false,
    assetUrl: (path) => `asset://localhost/${path}`,
    onToggle: (path) => { calls.toggles.push(path); overrides.onToggle?.(path) },
    onSelectAll: (select) => { calls.selectAll.push(select); overrides.onSelectAll?.(select) },
    onCancel: () => { calls.cancel += 1; overrides.onCancel?.() },
    onAdd: () => { calls.add += 1; overrides.onAdd?.() },
    ...overrides,
  }
  // overrides must win for the spy-wrapped callbacks too — rebuild them.
  if (overrides.onToggle) props.onToggle = overrides.onToggle
  if (overrides.onSelectAll) props.onSelectAll = overrides.onSelectAll
  if (overrides.onCancel) props.onCancel = overrides.onCancel
  if (overrides.onAdd) props.onAdd = overrides.onAdd
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  mounts.mount(<DropFoldersSheet {...props} />, container)
  return { container, calls }
}

const mounts = unmountTracker()

const sheet = (container: HTMLElement) => container.querySelector('.m-sheet')
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.drop-folder-row')]
const rowFor = (container: HTMLElement, title: string) =>
  rows(container).find((row) => row.querySelector('.drop-folder-title')?.textContent === title)
const checkFor = (container: HTMLElement, title: string) =>
  rowFor(container, title)?.querySelector<HTMLInputElement>('.drop-folder-check')
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.m-sheet button')].find((b) => b.textContent?.trim() === text)

let dom: Window
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown
let previousHTMLElement: unknown
let previousMutationObserver: unknown

beforeAll(() => {
  dom = new Window({ width: 1280, height: 840, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  previousHTMLElement = globals.HTMLElement
  previousMutationObserver = globals.MutationObserver
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
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
  globals.HTMLElement = previousHTMLElement
  globals.MutationObserver = previousMutationObserver
})

afterEach(() => {
  releaseAllOverlays()
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
  frames = []
})

describe('DropFoldersSheet', () => {
  test('renders a skeleton row per path until its scan resolves', async () => {
    const { container } = mount({ paths: ['/drop/alpha', '/drop/beta'], candidates: [] })
    await settle()
    expect(rows(container)).toHaveLength(2)
    expect(container.textContent).toContain('Looking for photographs…')
    expect(container.textContent).toContain('Add folders')
    // Nothing selectable yet — Add stays disabled.
    expect(button(container, 'Add 0 galleries')?.disabled).toBe(true)
  })

  test('resolved rows show count, parent hint and memory-card tag', async () => {
    const card = candidate({
      path: '/Volumes/CARD/DCIM',
      title: 'DCIM',
      sourceKind: 'card',
      mountPoint: '/Volumes/CARD',
      items: [item('IMG_1.HEIC', 4032, 3024)],
      itemCount: 1,
    })
    const { container } = mount({
      paths: ['/drop/alpha', '/Volumes/CARD/DCIM'],
      candidates: [candidate(), card],
      selected: new Set(['/drop/alpha', '/Volumes/CARD/DCIM']),
    })
    await settle()
    const alpha = rowFor(container, 'alpha')
    expect(alpha?.textContent).toContain('3 photographs')
    expect(alpha?.textContent).toContain('in drop')
    const dcim = rowFor(container, 'DCIM')
    expect(dcim?.textContent).toContain('1 photograph')
    expect(dcim?.textContent).toContain('Memory card')
    expect(dcim?.textContent).toContain('in CARD')
    expect(button(container, 'Add 2 galleries')?.disabled).toBe(false)
  })

  test('a capped scan reads "1,000 of 1,432 photographs"', async () => {
    const huge = candidate({
      path: '/drop/huge',
      title: 'huge',
      items: Array.from({ length: 1000 }, (_, i) => item(`f${i}.jpg`)),
      itemCount: 1432,
      truncated: 1432,
    })
    const { container } = mount({ paths: ['/drop/huge'], candidates: [huge] })
    await settle()
    expect(rowFor(container, 'huge')?.textContent).toContain('1,000 of 1,432 photographs')
  })

  test('deselecting a row updates the primary label and the live subtitle', async () => {
    const { container, calls } = mount({
      paths: ['/drop/alpha', '/drop/beta'],
      candidates: [candidate(), candidate({ path: '/drop/beta', title: 'beta' })],
      selected: new Set(['/drop/alpha', '/drop/beta']),
    })
    await settle()
    expect(container.querySelector('.drop-folders-sub')?.textContent).toContain('2 of 2 selected')
    checkFor(container, 'beta')!.click()
    expect(calls.toggles).toEqual(['/drop/beta'])
    // The parent owns selection state — simulate it landing.
    mounts.unmountAll()
    dom.document.body.innerHTML = ''
    const second = mount({
      paths: ['/drop/alpha', '/drop/beta'],
      candidates: [candidate(), candidate({ path: '/drop/beta', title: 'beta' })],
      selected: new Set(['/drop/alpha']),
    })
    await settle()
    expect(second.container.querySelector('.drop-folders-sub')?.textContent).toContain('1 of 2 selected')
    expect(button(second.container, 'Add 1 gallery')).toBeTruthy()
    expect(button(second.container, 'Add 2 galleries')).toBeUndefined()
  })

  test('duplicate, empty and unreadable rows are disabled with their notes', async () => {
    const dup = candidate({
      path: '/drop/dup',
      title: 'dup',
      state: 'duplicate',
      items: [],
      itemCount: 7,
      existing: existingRecord(),
    })
    const empty = candidate({ path: '/drop/empty', title: 'empty', state: 'empty', items: [], itemCount: 0 })
    const broken = candidate({ path: '/drop/broken', title: 'broken', state: 'unreadable', items: [], itemCount: 0 })
    const { container } = mount({
      paths: ['/drop/alpha', '/drop/dup', '/drop/empty', '/drop/broken'],
      candidates: [candidate(), dup, empty, broken],
      selected: new Set(['/drop/alpha']),
    })
    await settle()
    expect(rowFor(container, 'dup')?.textContent).toContain('Already in your library')
    expect(rowFor(container, 'empty')?.textContent).toContain('No photographs Manorama can display')
    expect(rowFor(container, 'broken')?.textContent).toContain("Couldn't read this folder")
    expect(checkFor(container, 'dup')?.disabled).toBe(true)
    expect(checkFor(container, 'dup')?.checked).toBe(false)
    expect(checkFor(container, 'empty')?.disabled).toBe(true)
    expect(checkFor(container, 'broken')?.disabled).toBe(true)
    expect(checkFor(container, 'alpha')?.disabled).toBe(false)
    // The duplicate still shows its real count — it IS that gallery.
    expect(rowFor(container, 'dup')?.textContent).toContain('7 photographs')
    // The duplicate row's cover is the existing record's cover, at stored dims.
    const coverImg = rowFor(container, 'dup')?.querySelector<HTMLImageElement>('.drop-folder-cover img')
    expect(coverImg?.getAttribute('src')).toBe('asset://localhost//drop/src/old.jpg')
    expect(coverImg?.style.aspectRatio).toBe('2000 / 2000')
  })

  test('select all / none toggles only the selectable rows', async () => {
    const { container, calls } = mount({
      paths: ['/drop/alpha', '/drop/empty'],
      candidates: [candidate(), candidate({ path: '/drop/empty', title: 'empty', state: 'empty', items: [], itemCount: 0 })],
      selected: new Set(),
    })
    await settle()
    const toggle = [...container.querySelectorAll<HTMLButtonElement>('.m-sheet button')]
      .find((b) => b.textContent?.trim() === 'Select all')
    expect(toggle?.disabled).toBe(false)
    toggle!.click()
    expect(calls.selectAll).toEqual([true])
    mounts.unmountAll()
    dom.document.body.innerHTML = ''
    const second = mount({
      paths: ['/drop/alpha', '/drop/empty'],
      candidates: [candidate(), candidate({ path: '/drop/empty', title: 'empty', state: 'empty', items: [], itemCount: 0 })],
      selected: new Set(['/drop/alpha']),
    })
    await settle()
    const none = [...second.container.querySelectorAll<HTMLButtonElement>('.m-sheet button')]
      .find((b) => b.textContent?.trim() === 'Select none')
    expect(none).toBeTruthy()
    none!.click()
    expect(second.calls.selectAll).toEqual([false])
  })

  test('Add is disabled at zero selected; Cancel and Escape both cancel', async () => {
    const { container, calls } = mount({
      paths: ['/drop/alpha'],
      candidates: [candidate()],
      selected: new Set(),
    })
    await settle()
    expect(button(container, 'Add 0 galleries')?.disabled).toBe(true)
    button(container, 'Cancel')!.click()
    expect(calls.cancel).toBe(1)

    mounts.unmountAll()
    dom.document.body.innerHTML = ''
    const second = mount({ paths: ['/drop/alpha'], candidates: [candidate()], selected: new Set(['/drop/alpha']) })
    await settle()
    const esc = new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Parameters<typeof dom.document.dispatchEvent>[0]
    dom.document.dispatchEvent(esc)
    await settle()
    expect(second.calls.cancel).toBe(1)
    expect(second.calls.add).toBe(0)
  })

  test('the Add button reports the commit intent', async () => {
    const { container, calls } = mount({ selected: new Set(['/drop/alpha']) })
    await settle()
    button(container, 'Add 1 gallery')!.click()
    expect(calls.add).toBe(1)
  })

  test('more than 24 folders shows the first 24 and says so', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/drop/f${i}`)
    const candidates = paths.map((p, i) => candidate({ path: p, title: `f${i}`, items: [item(`f${i}.jpg`)], itemCount: 1 }))
    const { container } = mount({ paths, candidates, selected: new Set(paths.slice(0, 24)) })
    await settle()
    expect(rows(container)).toHaveLength(24)
    expect(container.textContent).toContain('Showing the first 24 of 30 folders.')
  })
})

describe('DropVeil', () => {
  test('pro tier names the gesture and counts folders', async () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    mounts.mount(<DropVeil folders={3} pro={true} />, container)
    await settle()
    expect(container.textContent).toContain('Drop folders to add them')
    expect(container.textContent).toContain('3 folders')
    expect(container.querySelector('.desktop-drop-veil')?.getAttribute('aria-hidden')).toBe('true')
  })

  test('free tier explains the gate instead', async () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    mounts.mount(<DropVeil folders={2} pro={false} />, container)
    await settle()
    expect(container.textContent).toContain('Local galleries are included with Visionary')
    expect(container.textContent).not.toContain('folders')
  })
})
