import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { HeicImg } from './HeicImg'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

beforeAll(() => {
  prev = { window: globals.window, document: globals.document, fetch: globals.fetch, create: URL.createObjectURL, raf: globals.requestAnimationFrame }
  dom = new Window({ width: 1440, height: 900, url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  // hono's dom renderer schedules useEffect through rAF — run it inline.
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
  URL.createObjectURL = prev.create as typeof URL.createObjectURL
  globals.requestAnimationFrame = prev.raf
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const mount = () => {
  const container = dom.document.createElement('div')
  // In the document so an IntersectionObserver (where the DOM provides
  // one) can actually intersect; happy-dom lacks it, so the component's
  // no-observer path decodes immediately.
  dom.document.body.appendChild(container)
  return container as unknown as HTMLElement
}

describe('HeicImg', () => {
  test('a renderable item is a plain img — no decode work', async () => {
    globals.fetch = (() => { throw new Error('must not fetch') }) as unknown as typeof fetch
    const container = mount()
    render(<HeicImg src="/orig.jpg" preview="/thumb.webp" filename="a.jpg" alt="" />, container)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/thumb.webp')
    render(<HeicImg src="/orig.jpg" filename="b.jpg" alt="" />, container)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/orig.jpg')
  })

  test('a .heic filename with a preview renders the preview and skips decode', async () => {
    globals.fetch = (() => { throw new Error('must not fetch') }) as unknown as typeof fetch
    const container = mount()
    render(<HeicImg src="/api/mega/file?x" preview="/api/mega/preview?x" filename="a.heic" alt="" />, container)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/mega/preview?x')
  })

  test('a variantless .heic starts empty, then swaps in the decoded blob', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const fetches: string[] = []
    globals.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input))
      return new Response(jpeg)
    }) as unknown as typeof fetch
    URL.createObjectURL = (() => 'blob:decoded') as typeof URL.createObjectURL
    const container = mount()
    render(<HeicImg src="/api/mega/file?x" filename="IMG_9728.heic" alt="" />, container)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBeNull()
    for (let i = 0; i < 40 && img.getAttribute('src') !== 'blob:decoded'; i++) await tick()
    expect(img.getAttribute('src')).toBe('blob:decoded')
    expect(fetches).toEqual(['/api/mega/file?x'])
  })

  test('a failed fetch retries once before falling back to the source URL', async () => {
    let calls = 0
    globals.fetch = (() => { calls += 1; return Promise.resolve(new Response('no', { status: 503 })) }) as unknown as typeof fetch
    const container = mount()
    render(<HeicImg src="/api/mega/file?x" filename="a.heic" alt="" />, container)
    const img = container.querySelector('img')!
    // The retry lands ~2s out — poll generously, then the img falls back
    // to the proxy URL (Safari renders HEIC natively; elsewhere onError).
    for (let i = 0; i < 400 && calls < 2; i++) await tick()
    expect(calls).toBe(2)
    for (let i = 0; i < 40 && img.getAttribute('src') !== '/api/mega/file?x'; i++) await tick()
    expect(img.getAttribute('src')).toBe('/api/mega/file?x')
  })
})
