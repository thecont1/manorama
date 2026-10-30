import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import GalleryEditor from './GalleryEditor'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import { installReorderCloseGuard, requestReorderClose } from '../lib/reorder-close-guard'

/**
 * The editor's whole contract is a matrix, a pair of taps and one write, so it
 * is exercised through the mounted island: the same rAF-by-hand harness the
 * account tests use, which turns every async boundary into a deliberate step.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
const settle = async () => {
  for (let round = 0; round < 6; round++) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let dom: Window
beforeAll(() => {
  dom = new Window({ width: 375, height: 812, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
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
})

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const STORAGE_PREFIX = 'capacitor-storage_'
const TOKEN_KEY = `${STORAGE_PREFIX}manorama.session-token`

const installLocalStorage = () => {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() { return data.size },
      clear: () => data.clear(),
    },
  })
  return data
}

/** `id` is deliberately not the order key: the manifest's handle differs from
 *  the provider key the repository matches an order against, which is exactly
 *  the confusion that made a save look like it worked when it had not. `b`
 *  carries no `ref`, so the filename fallback is exercised too. */
const photo = (id: string, width = 1200, height = 800) => ({
  id: `manifest-${id}`,
  ...(id === 'b' ? {} : { ref: `ref-${id}` }),
  filename: `${id}.jpg`,
  src: `https://cdn.example/${id}.jpg`,
  width,
  height,
  alt: `Photograph ${id}`,
  c2pa: false,
  placeholder: '',
})

const orderKey = (item: { id: string; ref?: string; filename: string }) => item.ref ?? item.filename

const readPhotos = () => [photo('a'), photo('b'), photo('c')]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
const originalFetch = globalThis.fetch

/** A stub that behaves like the gallery: a PATCH of `order` really does
 *  resequence what the next read returns, so the editor's read-back sees the
 *  change it made. `ignoreOrder` models the old silent no-op — the route
 *  answers 200 while the stored order never moves. `photos` overrides the
 *  manifest for large-gallery fixtures. */
const stubFetch = (orderStatus = 200, options: { ignoreOrder?: boolean; photos?: ReturnType<typeof photo>[] } = {}) => {
  let storedOrder: string[] | null = null
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url.includes('/api/gallery/')) {
      const photos = options.photos ?? readPhotos()
      const images = storedOrder && !options.ignoreOrder
        ? [
            ...storedOrder
              .map((key) => photos.find((item) => orderKey(item) === key))
              .filter((item): item is (typeof photos)[number] => Boolean(item)),
            ...photos.filter((item) => !storedOrder!.includes(orderKey(item))),
          ]
        : photos
      return json({ manifest: { slug: 'kashmir', title: 'Kashmir', caption: '', date: '', images }, settings: {} })
    }
    if (url.includes('/api/galleries/') && init?.method === 'PATCH') {
      if (orderStatus !== 200) return json({ error: 'That order could not be saved' }, orderStatus)
      const body = JSON.parse(String(init.body)) as { order?: string[] }
      if (Array.isArray(body.order)) storedOrder = body.order
      return json({ gallery: { slug: 'kashmir' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const mountEditor = (options: { onClose?: () => void; onSaved?: () => void } = {}) => {
  const closed = { value: false }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(
    <GalleryEditor
      owner="quiet-owner"
      slug="kashmir"
      title="Kashmir"
      apiBase="https://manorama.xyz"
      onClose={() => { closed.value = true; options.onClose?.() }}
      onSaved={options.onSaved}
    />,
    container,
  )
  return { container, closed }
}

const cellsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('.native-global-cell')] as HTMLButtonElement[]

const cellSources = (container: HTMLElement) =>
  [...container.querySelectorAll('.native-global-cell img')].map((img) => img.getAttribute('src'))

const orderKeys = (container: HTMLElement) =>
  cellsOf(container).map((cell) => cell.getAttribute('data-order-key'))

const confirmDialog = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="dialog"]')]
    .find((dialog) => dialog.textContent?.includes('Discard unsaved changes'))

const pressKey = (key: string, init: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  const target = dom.document.querySelector('[data-gallery-editor]') ?? dom.document.body
  const Ctor = dom.window.KeyboardEvent
  if (Ctor) {
    target.dispatchEvent(new Ctor('keydown', { key, bubbles: true, cancelable: true, ...init }))
  } else {
    const event = new dom.window.Event('keydown', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      key: { value: key },
      ctrlKey: { value: Boolean(init.ctrlKey) },
      metaKey: { value: Boolean(init.metaKey) },
    })
    target.dispatchEvent(event)
  }
}

const fireCell = (cell: HTMLButtonElement, type: string) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  cell.dispatchEvent(event as unknown as Event)
  return event
}

/** Happy-dom does not lay out elements, so the editor's scroll metrics are
 *  stubbed to the fixture viewport. The component reads these once on mount
 *  and again on scroll, which is exactly the contract the browser satisfies. */
const stubScrollMetrics = (container: HTMLElement, width: number, height: number) => {
  const el = container.querySelector<HTMLElement>('[data-editor-scroll]')!
  let scrollTop = 0
  Object.defineProperties(el, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    },
  })
  return {
    scrollTo: (top: number) => {
      scrollTop = top
      el.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }) as unknown as Event)
    },
  }
}

const matchMediaFinePointer = () => {
  ;(dom.window as unknown as Record<string, unknown>).matchMedia = ((() => ({
    matches: true,
    media: '(pointer: fine)',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia)
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  } else {
    delete (globalThis as Record<string, unknown>).localStorage
  }
  delete (dom.window as unknown as Record<string, unknown>).matchMedia
  releaseAllOverlays()
  // The guard is a module singleton; a fresh neutral guard keeps one test's
  // editor from answering another test's back requests.
  installReorderCloseGuard(() => false)
  dom.document.body.innerHTML = ''
})

describe('gallery editor', () => {
  test('renders the owner screen and lays the gallery out in the stored order', async () => {
    const storage = installLocalStorage()
    storage.set(TOKEN_KEY, 'session-token-1')
    stubFetch()
    const { container } = mountEditor()
    await settle()

    expect(container.querySelector('[data-gallery-editor]')).not.toBeNull()
    // Top bar: Cancel on the left, the gallery name in the title, Save on the right.
    expect(container.querySelector('.native-editor-cancel')?.textContent).toBe('Cancel')
    expect(container.querySelector('.m-topbar')?.textContent).toContain('Reorder Kashmir')
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).textContent).toBe('Save')
    // The status line opens with the pick-up hint.
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('Tap a photograph to pick it up')
    // The bottom sizer drives the row height.
    const sizer = container.querySelector('.native-editor-sizer input[type="range"]') as HTMLInputElement
    expect(sizer.min).toBe('56')
    expect(sizer.max).toBe('248')
    expect(sizer.getAttribute('aria-label')).toBe('Photograph size')
    // The matrix, in the stored order, one cell per photograph.
    expect(cellsOf(container)).toHaveLength(3)
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
      'https://cdn.example/c.jpg',
    ])
    expect(cellsOf(container).map((cell) => cell.getAttribute('aria-label'))).toEqual([
      'Photograph a, position 1 of 3',
      'Photograph b, position 2 of 3',
      'Photograph c, position 3 of 3',
    ])
    // Nothing has moved, so there is nothing to save yet.
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(true)
    const read = calls.find((call) => call.url.includes('/api/gallery/quiet-owner/kashmir'))
    expect((read?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
  })

  test('picking a photograph up and putting it down resequences the matrix', async () => {
    installLocalStorage()
    stubFetch()
    const { container } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[2].click()
    await settle()
    // The photograph in hand carries the picker's pink.
    expect(cells[2].className).toContain('is-active')
    expect(cells[2].getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('Picked up')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('Tap where it goes.')

    cells[0].click()
    await settle()
    expect(cellSources(container)).toEqual([
      'https://cdn.example/c.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ])
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 1 of 3')
    expect(cellsOf(container).filter((cell) => cell.className.includes('is-active'))).toHaveLength(0)
    // Only the photograph that was actually moved wears the position badge.
    const moved = cellsOf(container).filter((cell) => cell.className.includes('is-moved'))
    expect(moved).toHaveLength(1)
    expect(moved[0].querySelector('.pos')?.textContent).toBe('1')
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('tapping the held cell cancels the pick-up', async () => {
    installLocalStorage()
    stubFetch()
    const { container } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[1].click()
    await settle()
    expect(cells[1].className).toContain('is-active')

    cells[1].click()
    await settle()
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
      'https://cdn.example/c.jpg',
    ])
    expect(cellsOf(container).filter((cell) => cell.className.includes('is-active'))).toHaveLength(0)
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('Nothing is in hand now.')
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(true)
  })

  test('saves the provider key the repository reorders by, verified by read-back', async () => {
    installLocalStorage()
    stubFetch()
    let savedCalls = 0
    const { container } = mountEditor({ onSaved: () => { savedCalls += 1 } })
    await settle()

    const cells = cellsOf(container)
    cells[1].click()
    await settle()
    cells[2].click()
    await settle()
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/c.jpg',
      'https://cdn.example/b.jpg',
    ])

    ;(container.querySelector('.native-editor-save') as HTMLButtonElement).click()
    await settle()
    const patch = calls.find((call) => call.url === 'https://manorama.xyz/api/galleries/kashmir' && call.init?.method === 'PATCH')
    // `ref` when the provider gives one, the filename otherwise — never the
    // manifest's own id, which matches nothing server-side.
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ order: ['ref-a', 'ref-c', 'b.jpg'] })
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('saved')
    expect(savedCalls).toBe(1)
    // A saved order is the new baseline, so the button goes quiet again.
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(true)

    cells[0].click()
    await settle()
    cells[2].click()
    await settle()
    expect(orderKeys(container)).not.toEqual(['ref-a', 'ref-c', 'b.jpg'])
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('an order the gallery did not take is never reported as saved', async () => {
    installLocalStorage()
    // The old failure: the route answers 200 and the stored order never moves.
    stubFetch(200, { ignoreOrder: true })
    let savedCalls = 0
    const { container } = mountEditor({ onSaved: () => { savedCalls += 1 } })
    await settle()

    const cells = cellsOf(container)
    cells[1].click()
    await settle()
    cells[2].click()
    await settle()
    ;(container.querySelector('.native-editor-save') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('.native-editor-note')?.textContent).toContain('did not take that order')
    expect(savedCalls).toBe(0)
    // The shuffle stays on screen and stays saveable, so the owner is not left
    // believing a change landed when it did not.
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/c.jpg',
      'https://cdn.example/b.jpg',
    ])
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('a failed save keeps the shuffle on screen and says why', async () => {
    installLocalStorage()
    stubFetch(422)
    const { container } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[2].click()
    await settle()
    cells[0].click()
    await settle()
    ;(container.querySelector('.native-editor-save') as HTMLButtonElement).click()
    await settle()

    expect(container.querySelector('.native-editor-note')?.textContent).toContain('That order could not be saved')
    expect(cellSources(container)).toEqual([
      'https://cdn.example/c.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ])
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('closes straight through when nothing is unsaved', async () => {
    installLocalStorage()
    stubFetch()
    const { container, closed } = mountEditor()
    await settle()

    ;(container.querySelector('.native-editor-cancel') as HTMLButtonElement).click()
    await settle()
    expect(closed.value).toBe(true)
    expect(confirmDialog(container)).toBeUndefined()
  })

  test('a dirty Close opens the confirmation; Continue editing keeps the draft', async () => {
    installLocalStorage()
    stubFetch()
    const { container, closed } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[0].click()
    await settle()
    cells[2].click()
    await settle()
    const shuffled = cellSources(container)

    ;(container.querySelector('.native-editor-cancel') as HTMLButtonElement).click()
    await settle()
    // The editor is still open; the confirmation sits on top with both paths.
    expect(closed.value).toBe(false)
    const dialog = confirmDialog(container)
    expect(dialog).not.toBeUndefined()
    expect(dialog!.textContent).toContain('Continue editing')
    expect(dialog!.textContent).toContain('Discard')

    const continueEditing = [...dialog!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Continue editing') as HTMLButtonElement
    continueEditing.click()
    await settle()
    expect(confirmDialog(container)).toBeUndefined()
    expect(container.querySelector('[data-gallery-editor]')).not.toBeNull()
    expect(cellSources(container)).toEqual(shuffled)
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)

    ;(container.querySelector('.native-editor-cancel') as HTMLButtonElement).click()
    await settle()
    const discard = [...confirmDialog(container)!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Discard') as HTMLButtonElement
    discard.click()
    await settle()
    // Discard settles the snap-back beat before the editor actually closes.
    await new Promise((resolve) => setTimeout(resolve, 280))
    expect(closed.value).toBe(true)
  })

  test('Escape closes clean, and every close path shares the dirty confirmation', async () => {
    installLocalStorage()
    stubFetch()
    const { container, closed } = mountEditor()
    await settle()

    // Clean: the back guard does not intercept, and Escape closes straight
    // through without any confirmation.
    expect(requestReorderClose()).toBe(false)
    pressKey('Escape')
    await settle()
    expect(closed.value).toBe(true)
    expect(confirmDialog(container)).toBeUndefined()

    // A fresh editor for the dirty flows.
    const second = mountEditor()
    await settle()
    const cells = cellsOf(second.container)
    cells[1].click()
    await settle()
    cells[2].click()
    await settle()

    // Escape routes through the overlay stack into the same dirty guard.
    pressKey('Escape')
    await settle()
    expect(confirmDialog(second.container)).not.toBeUndefined()
    expect(second.closed.value).toBe(false)

    // Continue editing dismisses the confirmation and keeps the draft.
    pressKey('Escape')
    await settle()
    expect(confirmDialog(second.container)).toBeUndefined()
    expect(orderKeys(second.container)).toEqual(['ref-a', 'ref-c', 'b.jpg'])

    // Android back: dirty asks again and swallows; while the confirmation is
    // open it swallows too; after Discard the editor signals it is done.
    expect(requestReorderClose()).toBe(true)
    await settle()
    expect(confirmDialog(second.container)).not.toBeUndefined()
    expect(requestReorderClose()).toBe(true)
    const discard = [...confirmDialog(second.container)!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Discard') as HTMLButtonElement
    discard.click()
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 280))
    expect(second.closed.value).toBe(true)
    expect(requestReorderClose()).toBe(false)
  })

  test('keyboard moves the held photograph; Home and End hit the boundaries', async () => {
    installLocalStorage()
    stubFetch()
    const { container } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[1].click()
    await settle()

    pressKey('ArrowRight', { ctrlKey: true })
    await settle()
    expect(orderKeys(container)).toEqual(['ref-a', 'ref-c', 'b.jpg'])
    expect(cellsOf(container)[2].className).toContain('is-active')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 3 of 3')

    pressKey('ArrowLeft', { metaKey: true })
    await settle()
    expect(orderKeys(container)).toEqual(['ref-a', 'b.jpg', 'ref-c'])
    expect(cellsOf(container)[1].className).toContain('is-active')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 2 of 3')

    pressKey('Home')
    await settle()
    expect(orderKeys(container)).toEqual(['b.jpg', 'ref-a', 'ref-c'])
    expect(cellsOf(container)[0].className).toContain('is-active')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 1 of 3')

    pressKey('End')
    await settle()
    expect(orderKeys(container)).toEqual(['ref-a', 'ref-c', 'b.jpg'])
    expect(cellsOf(container)[2].className).toContain('is-active')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 3 of 3')

    // Without a hold, arrows never move anything.
    cellsOf(container)[2].click()
    await settle()
    pressKey('ArrowRight', { ctrlKey: true })
    await settle()
    expect(orderKeys(container)).toEqual(['ref-a', 'ref-c', 'b.jpg'])
  })

  test('a dirty Cancel discards to the saved keys and closes after the settle beat', async () => {
    installLocalStorage()
    stubFetch()
    const { container, closed } = mountEditor()
    await settle()

    const cells = cellsOf(container)
    cells[0].click()
    await settle()
    cells[2].click()
    await settle()
    expect(orderKeys(container)).toEqual(['b.jpg', 'ref-c', 'ref-a'])

    ;(container.querySelector('.native-editor-cancel') as HTMLButtonElement).click()
    await settle()
    const discard = [...confirmDialog(container)!.querySelectorAll('button')]
      .find((button) => button.textContent === 'Discard') as HTMLButtonElement
    discard.click()
    await settle()
    // The draft is already discarded, the surface is settling, and nothing is
    // interactive until the close lands.
    expect(container.querySelector('.native-editor')?.className).toContain('is-settling')
    expect(orderKeys(container)).toEqual(['ref-a', 'b.jpg', 'ref-c'])
    expect(closed.value).toBe(false)
    expect((container.querySelector('.native-editor-cancel') as HTMLButtonElement).disabled).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 280))
    expect(closed.value).toBe(true)
  })

  test('virtualises a 1,000-photograph gallery to the visible rows and cells', async () => {
    installLocalStorage()
    const thousand = Array.from({ length: 1000 }, (_, index) => photo(`p${index}`))
    stubFetch(200, { photos: thousand })
    const { container } = mountEditor()
    const scroll = stubScrollMetrics(container, 375, 812)
    await settle()

    // Every item is 1200×800, so at the 97px viewport-relative row height
    // each cell is 145.5px wide: two per row, 500 rows, 48,500px tall.
    const grid = container.querySelector('.native-editor-virtual') as HTMLElement
    expect(grid.style.height).toBe('48500px')
    const rows = [...container.querySelectorAll('[data-editor-row]')]
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.length).toBeLessThan(500)
    // Rows 0–9 are the visible window plus overscan: 10 rows × 2 cells.
    expect(container.querySelectorAll('.native-global-cell')).toHaveLength(20)
    expect(rows[0].getAttribute('data-editor-row')).toBe('0')
    expect((rows[0] as HTMLElement).style.top).toBe('0px')
    expect((rows[1] as HTMLElement).style.top).toBe('97px')
    expect(rows[rows.length - 1].getAttribute('data-editor-row')).toBe('9')
    // Early photographs are mounted; far-off ones are not.
    expect(container.querySelector('[data-photo="manifest-p0"]')).not.toBeNull()
    expect(container.querySelector('[data-photo="manifest-p50"]')).toBeNull()

    scroll.scrollTo(24250)
    await settle()
    const scrolledRows = [...container.querySelectorAll('[data-editor-row]')]
    expect(scrolledRows[0].getAttribute('data-editor-row')).toBe('249')
    expect(scrolledRows[scrolledRows.length - 1].getAttribute('data-editor-row')).toBe('259')
    expect(container.querySelectorAll('.native-global-cell')).toHaveLength(22)
    expect(container.querySelector('[data-photo="manifest-p498"]')).not.toBeNull()
    expect(container.querySelector('[data-photo="manifest-p0"]')).toBeNull()
    // The mount stays a fragment of the gallery, not the gallery.
    expect(container.querySelectorAll('.native-global-cell')).toHaveLength(22)
  })

  test('mouse drag moves only under a fine pointer; otherwise cells are not draggable', async () => {
    installLocalStorage()
    stubFetch()
    const { container } = mountEditor()
    await settle()

    // No matchMedia (touch / unknown): no HTML5 drag at all.
    expect(cellsOf(container)[0].getAttribute('draggable')).not.toBe('true')

    // A fine pointer enables HTML5 drag: pick up, drag over, drop.
    matchMediaFinePointer()
    const fine = mountEditor()
    await settle()
    const cells = cellsOf(fine.container)
    expect(cells[0].getAttribute('draggable')).toBe('')

    fireCell(cells[2], 'dragstart')
    await settle()
    expect(cells[2].className).toContain('is-active')
    expect(fine.container.querySelector('.native-editor-note')?.textContent).toContain('Picked up')

    fireCell(cells[0], 'dragover')
    await settle()
    expect(cells[0].className).toContain('is-drop-target')

    fireCell(cells[0], 'drop')
    await settle()
    expect(cellSources(fine.container)).toEqual([
      'https://cdn.example/c.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ])
    expect(cellsOf(fine.container).filter((cell) => cell.className.includes('is-drop-target'))).toHaveLength(0)
    expect((fine.container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })
})
