import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import type { MediaReference } from '../../../packages/core/encrypted-source'

const globals = globalThis as any
let dom: Window
let previous: Record<string, unknown>
let released = false

beforeAll(() => {
  previous = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame }
  dom = new Window({ url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => { callback(0); return 1 })
  mock.module('../../lib/encrypted-display', () => ({
    acquireEncryptedDisplay: async () => ({ url: 'blob:decrypted', release: () => { released = true } }),
    releaseEncryptedGallery: () => {},
    releaseAllEncryptedDisplays: () => {},
  }))
})
afterAll(() => {
  Object.assign(globals, previous)
  mock.restore()
})

describe('HeicImg encrypted media', () => {
  test('uses the client resolver and releases its blob on unmount', async () => {
    const { HeicImg } = await import('./HeicImg')
    const media: MediaReference = { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'source', nodeId: 'node', previewId: 'preview' }
    const Harness = () => {
      const [show, setShow] = useState(true)
      return <><button type="button" onClick={() => setShow(false)}>hide</button>{show ? <HeicImg src="" media={media} galleryId="0123456789abcdef" filename="a.jpg" alt="" /> : null}</>
    }
    const container = dom.document.createElement('div') as unknown as HTMLElement
    render(<Harness />, container)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:decrypted')
    container.querySelector('button')!.dispatchEvent(new dom.Event('click', { bubbles: true }) as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(released).toBe(true)
  })

  test('a decode-path cell releases the decrypted original once it is consumed', async () => {
    released = false
    const prevFetch = globals.fetch
    const prevCreate = URL.createObjectURL
    // A non-ftyp head answers "already renderable" — the real decode path
    // runs: fetch the materialized blob, mint a URL for it, then release.
    globals.fetch = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))) as unknown as typeof fetch
    URL.createObjectURL = (() => 'blob:decoded') as typeof URL.createObjectURL
    try {
      const { HeicImg } = await import('./HeicImg')
      const media: MediaReference = { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'source', nodeId: 'node' }
      const container = dom.document.createElement('div') as unknown as HTMLElement
      render(<HeicImg src="" media={media} galleryId="0123456789abcdef" filename="a.heic" alt="" />, container)
      await new Promise((resolve) => setTimeout(resolve, 10))
      // The decoded rendition is what renders, and the held multi-MB original
      // is back in the resolver's working set — a rail of these cannot overflow it.
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:decoded')
      expect(released).toBe(true)
    } finally {
      globals.fetch = prevFetch
      URL.createObjectURL = prevCreate
      const { clearHeicUrlCache } = await import('../../lib/heic')
      clearHeicUrlCache()
    }
  })

  test('a failed rendition falls back to the original src', async () => {
    const { HeicImg } = await import('./HeicImg')
    const container = dom.document.createElement('div') as unknown as HTMLElement
    render(<HeicImg src="https://cdn.example/original.jpg" preview="https://cdn.example/thumb.jpg" filename="a.jpg" alt="" />, container)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://cdn.example/thumb.jpg')
    img.dispatchEvent(new dom.Event('error') as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(img.getAttribute('src')).toBe('https://cdn.example/original.jpg')
  })
})
