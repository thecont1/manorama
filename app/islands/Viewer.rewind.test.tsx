import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * Scroll mode rewinds home over a 0.75s rAF ride. The native and desktop
 * gallery lists unmount a Viewer without a page load, so that ride has to be
 * cancellable: left running it writes to a detached stage every frame for as
 * long as the shell stays open, and a paused one never ends at all.
 *
 * Frames are queued by hand rather than run inline so the test can see what
 * is still armed after the unmount.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const armed = new Map<number, FrameRequestCallback>()
const cancelled: number[] = []
let nextFrameId = 1

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

/** Run what is queued, then what those callbacks queued, and so on. */
const drain = (rounds: number) => {
  for (let round = 0; round < rounds; round += 1) {
    const due = [...armed.values()]
    armed.clear()
    for (const callback of due) callback(performance.now())
    flushSync(() => {})
  }
}

const SLUG = 'rewind-lifetime'

const images: GalleryMediaItem[] = Array.from({ length: 4 }, (_, index) => ({
  id: `frame-${index}`,
  filename: `frame-${index}.jpg`,
  src: `https://example.test/frame-${index}.jpg`,
  width: 1700,
  height: 2267,
  alt: `frame ${index}`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
}))

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch,
  }
  dom = new Window({ url: `http://localhost/${SLUG}` })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++
    armed.set(id, callback)
    return id
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => {
    cancelled.push(id)
    armed.delete(id)
  }) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  ;(dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false })
  ;(dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.svg
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.fetch = prev.fetch
})

describe('the Scroll rewind lifetime', () => {
  test('leaving the gallery mid-rewind cancels the ride instead of orphaning it', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = {
      ...defaultGallerySettings({ slug: SLUG, title: 'Rewind', caption: '', date: '', images }),
      defaultMode: 'vertical' as const,
    }

    const Harness = () => {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" data-close onClick={() => setOpen(false)}>close</button>
          {open ? <Viewer slug={SLUG} galleryTitle="Rewind" images={images} settings={settings} /> : null}
        </>
      )
    }

    render(<Harness />, root as unknown as HTMLElement)
    await settle()
    drain(4)
    armed.clear()
    cancelled.length = 0

    const rewindButton = root.querySelector('.viewer-endcap--feed .endcap-reset')
    expect(rewindButton).not.toBeNull()
    rewindButton!.dispatchEvent(new dom.Event('click', { bubbles: true }))
    await settle()

    const ride = [...armed.keys()]
    expect(ride.length).toBeGreaterThan(0)

    root.querySelector('[data-close]')!.dispatchEvent(new dom.Event('click', { bubbles: true }))
    await settle()

    expect(ride.some((id) => cancelled.includes(id))).toBe(true)
    drain(6)
    expect([...armed.keys()]).toEqual([])
  })
})