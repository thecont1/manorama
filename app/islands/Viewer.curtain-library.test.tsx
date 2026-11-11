import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * The curtain's Library exit.
 *
 * A veil with nowhere to go is a dead end: a visitor who followed a link
 * and wants back had to enter the gallery first to find the chrome's
 * Library pill. While the curtain is down the viewer now mounts a clone
 * of the raised chrome's top bar — same pill, same 3s idle clock — that
 * wakes on pointer movement or focus and unmounts when the veil lifts.
 */

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const SLUG = 'curtain-library'
const images: GalleryMediaItem[] = [{
  id: 'frame-1',
  filename: 'frame-1.jpg',
  src: 'https://example.test/frame-1.jpg',
  width: 2267,
  height: 1700,
  alt: 'frame 1',
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
}]

const mountViewer = (props: {
  onReturnToGalleries?: () => void
  libraryHref?: string
  viewerRole?: 'owner' | 'member' | 'visitor'
}): HTMLElement => {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  render(
    <Viewer
      slug={SLUG}
      galleryTitle="Curtain"
      images={images}
      settings={defaultGallerySettings({ slug: SLUG, title: 'Curtain', caption: '', date: '', images })}
      {...props}
    />,
    root as unknown as HTMLElement,
  )
  return root as unknown as HTMLElement
}

const curtainEl = () => {
  const curtain = dom.document.createElement('section')
  curtain.setAttribute('data-curtain', '')
  dom.document.body.appendChild(curtain)
  return curtain
}

const pointermove = () => dom.window.dispatchEvent(new dom.window.Event('pointermove'))

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
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
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

describe('the curtain Library pill', () => {
  // Mounted viewers and curtains append to the shared body — clear the
  // field so selectors can never match a previous test's tree.
  beforeEach(() => {
    dom.document.body.innerHTML = ''
    dom.document.body.classList.remove('gallery-entered')
  })

  test('it stays tucked until a pointer moves, then wakes like the raised chrome', async () => {
    curtainEl()
    const root = mountViewer({ onReturnToGalleries: () => {} })
    await settle()

    const bar = root.querySelector<HTMLElement>('[data-veil-chrome]')!
    expect(bar).not.toBeNull()
    expect(bar.classList.contains('is-visible')).toBe(false)
    expect(bar.getAttribute('aria-hidden')).toBe('true')

    pointermove()
    await settle()
    expect(bar.classList.contains('is-visible')).toBe(true)
    expect(bar.hasAttribute('aria-hidden')).toBe(false)
  })

  test('a desktop pill calls back instead of dismissing the curtain', async () => {
    const curtain = curtainEl()
    let returned = 0
    const root = mountViewer({ onReturnToGalleries: () => { returned += 1 } })
    pointermove()
    await settle()

    root.querySelector<HTMLElement>('[data-veil-chrome] [data-chrome-library]')!.click()
    await settle()
    expect(returned).toBe(1)
    expect(curtain.classList.contains('fading')).toBe(false)
    expect(curtain.hidden).not.toBe(true)
  })

  test('a web member gets the same Library href the raised chrome offers', async () => {
    curtainEl()
    const root = mountViewer({ libraryHref: '/thecontrarian', viewerRole: 'member' })
    await settle()
    const link = root.querySelector('a[data-chrome-library]')
    expect(link?.getAttribute('href')).toBe('/thecontrarian')
  })

  test('a visitor with no library gets no dead-end pill', async () => {
    curtainEl()
    const root = mountViewer({ libraryHref: '/thecontrarian', viewerRole: 'visitor' })
    pointermove()
    await settle()
    expect(root.querySelector('[data-veil-chrome]')).toBeNull()
  })

  test('a curtain already dissolving keeps the pill tucked away', async () => {
    const curtain = curtainEl()
    const root = mountViewer({ onReturnToGalleries: () => {} })
    await settle()
    curtain.classList.add('fading')
    pointermove()
    await settle()
    const bar = root.querySelector<HTMLElement>('[data-veil-chrome]')!
    expect(bar.classList.contains('is-visible')).toBe(false)
  })

  test('an entered gallery never renders the curtain chrome', async () => {
    // No curtain at all — the viewer counts the veil as already lifted.
    const root = mountViewer({ onReturnToGalleries: () => {} })
    pointermove()
    await settle()
    expect(root.querySelector('[data-veil-chrome]')).toBeNull()
  })
})
