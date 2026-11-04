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
})
