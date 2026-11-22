import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { unmountTracker } from '../../../test/unmount'
import { HeicImg } from './HeicImg'
import { clearHeicUrlCache } from '../../lib/heic'
import type { MediaReference } from '../../../packages/core/encrypted-source'
import type { EncryptedMediaResolver } from '../../lib/encrypted-resolver'

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

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

afterAll(() => {
  mounts.unmountAll()
  globals.window = prev.window
  globals.document = prev.document
  globals.fetch = prev.fetch
  URL.createObjectURL = prev.create as typeof URL.createObjectURL
  globals.requestAnimationFrame = prev.raf
  // Decoded URLs minted under stubs must not outlive the file — a later
  // spec for the same source would read the fake blob instead of fetching.
  clearHeicUrlCache()
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
    mounts.mount(<HeicImg src="/orig.jpg" preview="/thumb.webp" filename="a.jpg" alt="" />, container)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/thumb.webp')
    mounts.mount(<HeicImg src="/orig.jpg" filename="b.jpg" alt="" />, container)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/orig.jpg')
  })

  test('a .heic filename with a preview renders the preview and skips decode', async () => {
    globals.fetch = (() => { throw new Error('must not fetch') }) as unknown as typeof fetch
    const container = mount()
    mounts.mount(<HeicImg src="/api/mega/file?x" preview="/api/mega/preview?x" filename="a.heic" alt="" />, container)
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
    mounts.mount(<HeicImg src="/api/mega/file?x" filename="IMG_9728.heic" alt="" />, container)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBeNull()
    for (let i = 0; i < 40 && img.getAttribute('src') !== 'blob:decoded'; i++) await tick()
    expect(img.getAttribute('src')).toBe('blob:decoded')
    expect(fetches).toEqual(['/api/mega/file?x'])
  })

  test('leaving the view releases the pin but keeps the resolved frame painted', async () => {
    // The stub observer hands the test control of `inView`: flipping it
    // crosses the acquire↔release boundary that blanked the frame and
    // collapsed the card — the layout loop behind the library flicker.
    let notify: ((intersecting: boolean) => void) | null = null
    class Observer {
      constructor(cb: IntersectionObserverCallback) {
        notify = (intersecting) => cb([{ isIntersecting: intersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const prevIO = globals.IntersectionObserver
    globals.IntersectionObserver = Observer
    try {
      let acquires = 0
      let releases = 0
      const resolver = {
        acquire: () => { acquires += 1; return Promise.resolve('blob:preview-frame') },
        release: () => { releases += 1 },
      } as unknown as EncryptedMediaResolver
      const media: MediaReference = { kind: 'encrypted', provider: 'proton', sourceKind: 'urls', sourceId: 's', nodeId: 'n' }
      const previewMedia: MediaReference = { ...media, previewId: 'p' }
      const container = mount()
      mounts.mount(
        <HeicImg src="https://x/orig.jpg" preview="https://x/prev.jpg" media={media} previewMedia={previewMedia} encryptedResolver={resolver} filename="a.jpg" alt="" />,
        container,
      )
      const img = container.querySelector('img')!
      // Out of view the remote preview paints; entering resolves the frame.
      expect(img.getAttribute('src')).toBe('https://x/prev.jpg')
      notify!(true)
      for (let i = 0; i < 40 && img.getAttribute('src') !== 'blob:preview-frame'; i++) await tick()
      expect(acquires).toBe(1)
      notify!(false)
      for (let i = 0; i < 40 && releases < 1; i++) await tick()
      expect(releases).toBe(1)
      // The pin is freed but the paint survives — no collapse back to the
      // placeholder, which is what re-triggered the layout loop.
      expect(img.getAttribute('src')).toBe('blob:preview-frame')
      // Re-entering re-acquires the entry and the frame stays put through it.
      notify!(true)
      for (let i = 0; i < 40 && acquires < 2; i++) await tick()
      expect(acquires).toBe(2)
      expect(img.getAttribute('src')).toBe('blob:preview-frame')
    } finally {
      globals.IntersectionObserver = prevIO
    }
  })

  test('a failed fetch retries once before falling back to the source URL', async () => {
    let calls = 0
    globals.fetch = (() => { calls += 1; return Promise.resolve(new Response('no', { status: 503 })) }) as unknown as typeof fetch
    const container = mount()
    // Its own src — the decode cache is per-source, and the earlier test
    // already cached a blob under ?x.
    mounts.mount(<HeicImg src="/api/mega/file?retry" filename="a.heic" alt="" />, container)
    const img = container.querySelector('img')!
    // The retry lands ~2s out — poll generously, then the img falls back
    // to the proxy URL (Safari renders HEIC natively; elsewhere onError).
    for (let i = 0; i < 400 && calls < 2; i++) await tick()
    expect(calls).toBe(2)
    for (let i = 0; i < 40 && img.getAttribute('src') !== '/api/mega/file?retry'; i++) await tick()
    expect(img.getAttribute('src')).toBe('/api/mega/file?retry')
  })
})
