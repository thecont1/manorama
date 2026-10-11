import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import GalleryEditor from './GalleryEditor'

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

const photo = (id: string, width = 1200, height = 800) => ({
  id,
  filename: `${id}.jpg`,
  src: `https://cdn.example/${id}.jpg`,
  width,
  height,
  alt: `Photograph ${id}`,
  c2pa: false,
  placeholder: '',
})

const manifestBody = () => ({
  manifest: {
    slug: 'kashmir',
    title: 'Kashmir',
    caption: '',
    date: '',
    images: [photo('a'), photo('b'), photo('c')],
  },
  settings: {},
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
const originalFetch = globalThis.fetch

const stubFetch = (orderStatus = 200) => {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    if (url.includes('/api/gallery/')) return json(manifestBody())
    if (url.includes('/api/galleries/') && init?.method === 'PATCH') {
      return orderStatus === 200 ? json({ gallery: { slug: 'kashmir' } }) : json({ error: 'That order could not be saved' }, orderStatus)
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

const mountEditor = (onClose: () => void = () => {}) => {
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(
    <GalleryEditor
      owner="quiet-owner"
      slug="kashmir"
      title="Kashmir"
      apiBase="https://manorama.xyz"
      onClose={onClose}
    />,
    container,
  )
  return { container }
}

const cellSources = (container: HTMLElement) =>
  [...container.querySelectorAll('.native-global-cell img')].map((img) => img.getAttribute('src'))

afterEach(() => {
  globalThis.fetch = originalFetch
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  } else {
    delete (globalThis as Record<string, unknown>).localStorage
  }
  dom.document.body.innerHTML = ''
})

describe('gallery editor', () => {
  test('lays the gallery out on the picker matrix, in the stored order', async () => {
    const storage = installLocalStorage()
    storage.set(TOKEN_KEY, 'session-token-1')
    stubFetch()
    const { container } = mountEditor()
    await settle()

    expect(container.querySelector('[data-gallery-editor]')).not.toBeNull()
    // The picker's own classes: same cells, same matrix, same zero gaps.
    expect(container.querySelectorAll('.native-global-grid .native-global-cell')).toHaveLength(3)
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
      'https://cdn.example/c.jpg',
    ])
    expect([...container.querySelectorAll('.native-global-cell')].map((cell) => cell.getAttribute('aria-label'))).toEqual([
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

    const cells = [...container.querySelectorAll('.native-global-cell')] as HTMLButtonElement[]
    cells[2].click()
    await settle()
    // The photograph in hand carries the picker's pink.
    expect(cells[2].className).toContain('is-active')
    expect(cells[2].getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('in hand')

    cells[0].click()
    await settle()
    expect(cellSources(container)).toEqual([
      'https://cdn.example/c.jpg',
      'https://cdn.example/a.jpg',
      'https://cdn.example/b.jpg',
    ])
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('position 1 of 3')
    expect(container.querySelectorAll('.native-global-cell.is-active')).toHaveLength(0)
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('saves only the order it was given, and discards back to the stored one', async () => {
    installLocalStorage()
    stubFetch()
    const { container } = mountEditor()
    await settle()

    const cells = [...container.querySelectorAll('.native-global-cell')] as HTMLButtonElement[]
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
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ order: ['a', 'c', 'b'] })
    expect(container.querySelector('.native-editor-note')?.textContent).toContain('saved')
    // A saved order is the new baseline, so the button goes quiet again.
    expect((container.querySelector('.native-editor-save') as HTMLButtonElement).disabled).toBe(true)

    cells[0].click()
    await settle()
    cells[2].click()
    await settle()
    expect(cellSources(container)).not.toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/c.jpg',
      'https://cdn.example/b.jpg',
    ])
    const discard = [...container.querySelectorAll('.native-editor-actions button')]
      .find((button) => button.textContent === 'Discard changes') as HTMLButtonElement
    discard.click()
    await settle()
    expect(cellSources(container)).toEqual([
      'https://cdn.example/a.jpg',
      'https://cdn.example/c.jpg',
      'https://cdn.example/b.jpg',
    ])
  })

  test('a failed save keeps the shuffle on screen and says why', async () => {
    installLocalStorage()
    stubFetch(422)
    const { container } = mountEditor()
    await settle()

    const cells = [...container.querySelectorAll('.native-global-cell')] as HTMLButtonElement[]
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
  })

  test('closes through the caller', async () => {
    installLocalStorage()
    let closed = false
    const { container } = mountEditor(() => { closed = true })
    await settle()

    ;(container.querySelector('[aria-label="Close the editor"]') as HTMLButtonElement).click()
    expect(closed).toBe(true)
  })
})