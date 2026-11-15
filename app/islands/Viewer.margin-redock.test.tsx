import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryImage, GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * A canvas switch mid-glide must not leave the strip parked at the
 * pre-switch destination. Dark/Light shrink every frame, so the offset a
 * paging glide was chasing is stale the moment the margin lands; the
 * glide finishing there leaves the photograph off its dock until the
 * next input. The re-dock is owed when motion ends — this pins that.
 *
 * happy-dom has no layout, so the strip's geometry is stamped by hand:
 * each frame's offsetLeft/offsetWidth and the track's scrollWidth are
 * getters over a `marginPx` the test flips when it picks Dark — the same
 * 10px-per-side shrink the real canvas applies. The stamps land before
 * the mount-time settles run, so the first bounds read sees real
 * geometry instead of resolving to the last frame. rAF is queued by
 * hand and `performance.now` is a manual clock, so the glide's eased
 * ticks advance deterministically.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>
let prevNow: () => number

const STAGE_WIDTH = 390
const STAGE_HEIGHT = 664
const FRAME_WIDTH = 600
const END_CAP_WIDTH = 300
const COUNT = 5

// happy-dom's DOM types do not satisfy lib.dom's ParentNode/Element
// constraints, so the test talks to the tree through this structural
// view and casts each hit — the same `as unknown as` seam the other
// Viewer specs use.
interface Queryable {
  querySelector: (selector: string) => unknown
  querySelectorAll: (selector: string) => ArrayLike<unknown>
}
interface StubEl {
  dataset: { index?: string }
  style: { transform: string }
  textContent: string | null
  click: () => void
}

const armed = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let fakeNow = 0

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

const drainFrames = () => {
  const pending = [...armed.entries()]
  armed.clear()
  for (const [, callback] of pending) callback(fakeNow)
}

// One animation frame: advance the clock, run whatever was queued.
const tick = () => {
  fakeNow += 16
  drainFrames()
}

const SLUG = 'margin-redock'

const photo = (id: string): GalleryImage => ({
  id,
  filename: `${id}.jpg`,
  src: `https://example.test/${id}.jpg`,
  width: 1200,
  height: 900,
  alt: `${id} test image`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const images: GalleryMediaItem[] = Array.from({ length: COUNT }, (_, i) => photo(`p${i}`))

// The margin the canvas currently applies — flipped to 10 by the Dark
// pick, mirroring imageMarginPx = background !== 'none' ? 10 : 0.
let marginPx = 0
const widthAt = (margin: number) => FRAME_WIDTH - margin * 3
const offsetAt = (index: number, margin: number) => {
  let left = 0
  for (let i = 0; i < index; i += 1) left += widthAt(margin)
  return left
}

const stampGeometry = (root: Queryable) => {
  const stage = root.querySelector('[data-stage]')
  expect(stage).not.toBeNull()
  Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => STAGE_WIDTH })
  Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => STAGE_HEIGHT })
  const track = root.querySelector('[data-track]')
  const cap = root.querySelector('[data-endcard]')
  const frames = Array.from(root.querySelectorAll('.viewer-frame[data-index]')) as unknown as StubEl[]
  expect(frames.length).toBe(COUNT)
  if (cap) {
    Object.defineProperty(cap, 'offsetLeft', { configurable: true, get: () => offsetAt(COUNT, marginPx) + END_CAP_WIDTH / 2 })
    Object.defineProperty(cap, 'offsetWidth', { configurable: true, get: () => END_CAP_WIDTH })
  }
  for (const frame of frames) {
    const index = Number(frame.dataset.index) - 1
    Object.defineProperty(frame, 'offsetLeft', { configurable: true, get: () => offsetAt(index, marginPx) })
    Object.defineProperty(frame, 'offsetWidth', { configurable: true, get: () => widthAt(marginPx) })
  }
  Object.defineProperty(track, 'scrollWidth', {
    configurable: true,
    get: () => frames.reduce((sum) => sum + widthAt(marginPx), 0) + (cap ? END_CAP_WIDTH : 0),
  })
}

const mountViewer = async (root: Queryable) => {
  render(
    <Viewer
      slug={SLUG}
      galleryTitle="Margin redock"
      images={images}
      settings={defaultGallerySettings({ slug: SLUG, title: 'Margin redock', caption: '', date: '', images })}
    />,
    root as unknown as HTMLElement,
  )
  // Geometry must exist before the mount-time settles read it — stamping
  // afterwards lets a zero-measure pass resolve the strip to its end.
  stampGeometry(root)
  await settle()
  dom.dispatchEvent(new dom.Event('resize'))
  drainFrames()
  await settle()
  drainFrames()
  await settle()
  await settle()
}

const transformX = (root: Queryable) => {
  const track = root.querySelector('[data-track]') as unknown as { style?: { transform?: string } } | null
  const match = /translate3d\((-?[\d.]+)px/.exec(track?.style?.transform ?? '')
  return match ? parseFloat(match[1]) : null
}

const arrowRight = () => {
  dom.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowRight' }))
}

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch, ls: globals.localStorage,
  }
  prevNow = performance.now.bind(performance)
  dom = new Window({ url: `http://localhost/${SLUG}` })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.localStorage = dom.localStorage
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++
    armed.set(id, callback)
    return id
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => {
    armed.delete(id)
  }) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  ;(dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false })
  ;(dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
  performance.now = () => fakeNow
})

afterAll(() => {
  performance.now = prevNow
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.svg
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.fetch = prev.fetch
  globals.localStorage = prev.ls
})

describe('the canvas-switch re-dock', () => {
  test('a width change during a paging glide re-docks at the new offset', async () => {
    marginPx = 0
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const q = root as unknown as Queryable
    await mountViewer(q)

    // The strip opens docked on the first photograph.
    expect(transformX(q)).toBe(0)

    // First page travels one viewport (-390): frame 1's 600px offset is
    // wider than the stage, so the dock lands between frames and the
    // position report keeps the index on frame 0.
    arrowRight()
    await settle()
    for (let i = 0; i < 80; i += 1) tick()
    await settle()
    tick()
    await settle()
    expect(Math.abs(transformX(q)! - -390)).toBeLessThan(0.001)

    // Second page glides toward frame 1's dock (-600 pre-margin) —
    // mid-flight it has left the first dock behind.
    arrowRight()
    await settle()
    for (let i = 0; i < 15; i += 1) tick()
    await settle()
    expect(transformX(q)!).toBeLessThan(-400)

    // Switch Blank → Dark mid-glide through the real settings sheet.
    const pill = Array.from(q.querySelectorAll('button.m-chrome-pill')) as unknown as StubEl[]
    const settingsPill = pill.find((el) => el.textContent?.includes('Gallery Settings'))
    expect(settingsPill).not.toBeUndefined()
    settingsPill!.click()
    await settle()
    const radios = Array.from(q.querySelectorAll('[role="radio"]')) as unknown as StubEl[]
    const dark = radios.find((el) => el.textContent?.includes('Dark'))
    expect(dark).not.toBeUndefined()
    dark!.click()
    await settle()
    marginPx = 10

    // Run the glide out, the landing report, and the re-dock's frames.
    for (let i = 0; i < 200; i += 1) tick()
    await settle()
    tick()
    await settle()
    tick()
    await settle()

    // The dock must read the post-switch geometry — frame 1 now starts
    // at 570, not the stale 600 the glide was chasing.
    const current = q.querySelector('.viewer-frame[aria-current="true"]') as unknown as StubEl | null
    expect(current).not.toBeNull()
    const index = Number(current!.dataset.index) - 1
    expect(Math.abs(transformX(q)! - -offsetAt(index, 10))).toBeLessThan(0.001)
  })
})
