import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { useState } from 'hono/jsx'
import { unmountTracker } from '../../../test/unmount'
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
// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

afterAll(() => {
  mounts.unmountAll()
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
    mounts.mount(<Harness />, container)
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
      mounts.mount(<HeicImg src="" media={media} galleryId="0123456789abcdef" filename="a.heic" alt="" />, container)
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

  test('a vault still resolves through its lease resolver and decodes only once the original lands', async () => {
    const prevFetch = globals.fetch
    const prevCreate = URL.createObjectURL
    const fetched: string[] = []
    globals.fetch = (async (input: unknown) => {
      fetched.push(String(input))
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
    }) as unknown as typeof fetch
    let minted = 0
    URL.createObjectURL = (() => `blob:decoded-${++minted}`) as typeof URL.createObjectURL
    const acquired: Array<{ reference: MediaReference; preview: boolean }> = []
    let released = 0
    const resolver = {
      acquire: async (reference: MediaReference, preview = false) => {
        acquired.push({ reference, preview })
        return 'blob:vault-original'
      },
      release: () => { released += 1 },
    }
    // A vault lease carries one entry per still: previewMedia and media are
    // the same reference, never a rendition of their own.
    const media: MediaReference = { kind: 'encrypted', provider: 'vault', entryId: 'thumb:still', mimeType: 'image/heic' }
    const placeholder = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"/>'
    try {
      const { HeicImg } = await import('./HeicImg')
      const container = dom.document.createElement('div') as unknown as HTMLElement
      mounts.mount(<HeicImg src={placeholder} preview={placeholder} media={media} previewMedia={media} encryptedResolver={resolver as never} filename="a.heic" alt="" />, container)
      await new Promise((resolve) => setTimeout(resolve, 10))
      // Acquisition ran through the lease resolver — never the mocked
      // key-store path, whose 'blob:decrypted' would expose the bypass.
      expect(acquired).toHaveLength(1)
      // The placeholder is display furniture, not media: the only bytes ever
      // fetched for decoding are the materialized original's.
      expect(fetched).toEqual(['blob:vault-original'])
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:decoded-1')
      // The decoded rendition frees the multi-MB original back to the bounded set.
      expect(released).toBe(1)
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
    mounts.mount(<HeicImg src="https://cdn.example/original.jpg" preview="https://cdn.example/thumb.jpg" filename="a.jpg" alt="" />, container)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://cdn.example/thumb.jpg')
    img.dispatchEvent(new dom.Event('error') as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(img.getAttribute('src')).toBe('https://cdn.example/original.jpg')
  })
})
