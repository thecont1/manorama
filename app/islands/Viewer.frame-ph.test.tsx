import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { unmountTracker } from '../../test/unmount'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryImage, GalleryMediaItem, VideoItem } from '../../packages/core/imagesource'

/**
 * The preview layer (`img.frame-ph`) must occupy the same honest staged
 * box as the full image (`img.frame-img`). The `.frame-ph` CSS stretches
 * it to 100%/100% of the frame, which for a source too small to fill the
 * stage paints a thumbnail far larger than its pixels — invariant 13.
 * The fix hands the photo preview the same `stagedStyle` the full image
 * already carries; the video poster keeps its own `cappedMediaStyle`.
 *
 * happy-dom reports every box as 0×0, so the test stamps the measured
 * stage box onto its own `[data-stage]` element — an own property, never
 * a prototype stub (see Viewer.video-frame-width.test.tsx for why).
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const STAGE_WIDTH = 390
const STAGE_HEIGHT = 664
const SMALL_WIDTH = 64
const SMALL_HEIGHT = 64

// Frames are queued by hand rather than run inline: an inline rAF would
// let a strip glide's self-rescheduling tick recurse synchronously.
const armed = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

// Runs each queued frame once; anything a callback re-arms stays queued
// for the next drain, so a self-rescheduling glide cannot loop here.
const drainFrames = () => {
  const pending = [...armed.entries()]
  armed.clear()
  for (const [, callback] of pending) callback(0)
}

const mounts = unmountTracker()

const mountViewer = async (
  root: { querySelector: (selector: string) => unknown },
  settings: ReturnType<typeof defaultGallerySettings>,
) => {
  mounts.mount(<Viewer slug={SLUG} galleryTitle="Preview stage" images={images} settings={settings} />, root as unknown as HTMLElement)
  const stage = root.querySelector('[data-stage]') as unknown as HTMLElement | null
  expect(stage).not.toBeNull()
  Object.defineProperty(stage!, 'clientWidth', { configurable: true, get: () => STAGE_WIDTH })
  Object.defineProperty(stage!, 'clientHeight', { configurable: true, get: () => STAGE_HEIGHT })
  await settle()
  dom.dispatchEvent(new dom.Event('resize'))
  // Effects can arm their rAF only once a flush has run them, so drain,
  // flush, and drain once more — applyStageMetrics is idempotent.
  drainFrames()
  await settle()
  drainFrames()
  await settle()
  await settle()
}

const SLUG = 'frame-ph-staged'

const smallPhoto = (id: string): GalleryImage => ({
  id,
  filename: `${id}.jpg`,
  src: `https://example.test/${id}.jpg`,
  width: SMALL_WIDTH,
  height: SMALL_HEIGHT,
  alt: `${id} small test image`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  variants: [{ width: 256, src: `https://example.test/${id}-256.webp`, format: 'webp' }],
})

const clip = (id: string): VideoItem => ({
  type: 'video',
  id,
  filename: `${id}.mp4`,
  src: '',
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  durationSeconds: 5,
  poster: {
    src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    width: 1920,
    height: 1080,
  },
  alt: `${id} test video`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const images: GalleryMediaItem[] = [smallPhoto('tiny'), clip('v1')]

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch, ls: globals.localStorage,
  }
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
})

afterAll(() => {
  mounts.unmountAll()
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.svg
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.fetch = prev.fetch
  globals.localStorage = prev.ls
})

describe('the photo preview layer staging', () => {
  test('a small source\'s frame-ph carries the same staged box as frame-img', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = defaultGallerySettings({ slug: SLUG, title: 'Preview stage', caption: '', date: '', images })

    await mountViewer(root, settings)

    const frame = root.querySelector('.viewer-frame[data-media-type="image"]') as unknown as HTMLElement | null
    expect(frame).not.toBeNull()
    const preview = frame!.querySelector('img.frame-ph') as unknown as HTMLImageElement | null
    const full = frame!.querySelector('img.frame-img') as unknown as HTMLImageElement | null
    expect(preview).not.toBeNull()
    expect(full).not.toBeNull()

    // The preview must not fall back to the frame-filling 100%/100% box:
    // it carries the identical staged geometry as the photograph itself.
    expect(preview!.style.width).not.toBe('')
    expect(preview!.style.width).toBe(full!.style.width)
    expect(preview!.style.height).toBe(full!.style.height)

    // And neither may exceed what the source's own pixels can honestly
    // cover at this density (dpr 1 → the 64×64 intrinsic is the budget).
    expect(parseFloat(preview!.style.width)).toBeGreaterThan(0)
    expect(parseFloat(preview!.style.width)).toBeLessThanOrEqual(SMALL_WIDTH)
    expect(parseFloat(preview!.style.height)).toBeLessThanOrEqual(SMALL_HEIGHT)
    expect(parseFloat(full!.style.width)).toBeLessThanOrEqual(SMALL_WIDTH)
    expect(parseFloat(full!.style.height)).toBeLessThanOrEqual(SMALL_HEIGHT)
  })

  test('the video poster keeps its own sizing contract', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = defaultGallerySettings({ slug: SLUG, title: 'Preview stage', caption: '', date: '', images })

    await mountViewer(root, settings)

    const frame = root.querySelector('.viewer-frame[data-media-type="video"]') as unknown as HTMLElement | null
    expect(frame).not.toBeNull()
    const poster = frame!.querySelector('img.frame-ph') as unknown as HTMLImageElement | null
    expect(poster).not.toBeNull()
    // Uncapped (touch pointer, unmeasured cap) the poster carries no
    // staged box — the strip rule must not leak onto video.
    expect(poster!.style.width).toBe('')
    expect(poster!.style.height).toBe('')
  })
})
