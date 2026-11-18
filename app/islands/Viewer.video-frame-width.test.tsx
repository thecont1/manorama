import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { unmountTracker } from '../../test/unmount'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryImage, GalleryMediaItem, VideoItem } from '../../packages/core/imagesource'

/**
 * A strip video frame must carry an explicit px width once the stage is
 * measured. Aspect-ratio alone leaves the frame's max-content size to its
 * contents, and WebKit reads the poster's intrinsic width into the
 * `width: max-content` track — the track then measures wider than its
 * laid-out frames and the pan range overshoots "The End." card
 * (specs/endcap-webkit.playwright.ts covers the engine-level symptom;
 * this pins the style contract in a DOM that has no layout engine).
 *
 * happy-dom reports every box as 0×0, so each test stamps the measured
 * stage box onto its own `[data-stage]` element — an own property, never
 * a prototype stub: happy-dom shares its HTMLElement class across Window
 * instances in one process, and a prototype override leaks into whatever
 * spec file bun happens to run next.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const STAGE_WIDTH = 390
const STAGE_HEIGHT = 664
const VIDEO_WIDTH = 1920
const VIDEO_HEIGHT = 1080

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

// applyStageMetrics reads stage.clientWidth/clientHeight; happy-dom has
// no layout, so the stage element itself reports the measured box. The
// mount-time onResize already queued an rAF that re-reads it — draining
// after the stamp is what publishes stageSize into the render.
// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

const mountViewer = async (
  root: { querySelector: (selector: string) => unknown },
  settings: ReturnType<typeof defaultGallerySettings>,
) => {
  mounts.mount(<Viewer slug={SLUG} galleryTitle="Video frame" images={images} settings={settings} />, root as unknown as HTMLElement)
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

const SLUG = 'video-frame-width'

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

const clip = (id: string): VideoItem => ({
  type: 'video',
  id,
  filename: `${id}.mp4`,
  src: '',
  mimeType: 'video/mp4',
  width: VIDEO_WIDTH,
  height: VIDEO_HEIGHT,
  durationSeconds: 5,
  poster: {
    src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
  },
  alt: `${id} test video`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const images: GalleryMediaItem[] = [photo('p0'), clip('v1'), photo('p2')]

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
  // The canvas preference lives in localStorage — without this global the
  // viewer's `typeof localStorage === 'undefined'` guard reads no prefs.
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

describe('the strip video frame size contract', () => {
  test('a measured strip video frame carries an explicit px width', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = defaultGallerySettings({ slug: SLUG, title: 'Video frame', caption: '', date: '', images })

    await mountViewer(root, settings)

    const videoFrame = root.querySelector('.viewer-frame[data-media-type="video"]') as unknown as HTMLElement | null
    expect(videoFrame).not.toBeNull()
    // stageSize.height * frameW / frameH — the same box the aspect ratio
    // would produce, stated as a definite width so WebKit cannot reach
    // for the poster's intrinsic size. The CSSOM serializes the px value,
    // so compare numerically.
    expect(videoFrame!.style.width).toMatch(/^\d+(\.\d+)?px$/)
    expect(Math.abs(parseFloat(videoFrame!.style.width) - (STAGE_HEIGHT * VIDEO_WIDTH) / VIDEO_HEIGHT)).toBeLessThan(0.001)
    expect(videoFrame!.style.aspectRatio).toBe(`${VIDEO_WIDTH} / ${VIDEO_HEIGHT}`)
  })

  test('strip photographs keep their staged width and height', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = defaultGallerySettings({ slug: SLUG, title: 'Video frame', caption: '', date: '', images })

    await mountViewer(root, settings)

    const photoFrame = root.querySelector('.viewer-frame[data-media-type="image"]') as unknown as HTMLElement | null
    expect(photoFrame).not.toBeNull()
    expect(photoFrame!.style.width).toMatch(/px$/)
    expect(photoFrame!.style.height).toMatch(/px$/)
    expect(photoFrame!.style.aspectRatio).toBe('')
  })

  test('a Dark canvas measures the frame against stagingHeight, not the raw stage', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = defaultGallerySettings({ slug: SLUG, title: 'Video frame', caption: '', date: '', images })
    // The canvas preference is read from localStorage before first render;
    // Dark puts the 10px image margin on every strip frame, so the staged
    // height is the stage minus 20px.
    dom.localStorage.setItem(`manorama:view:${SLUG}`, JSON.stringify({ background: 'dark' }))
    try {
      await mountViewer(root, settings)

      const videoFrame = root.querySelector('.viewer-frame[data-media-type="video"]') as unknown as HTMLElement | null
      expect(videoFrame).not.toBeNull()
      // (STAGE_HEIGHT - 2 * 10) * frameW / frameH — a frame sized from the
      // raw stage would be ~20·ratio px too wide under a visible canvas.
      expect(videoFrame!.style.width).toMatch(/^\d+(\.\d+)?px$/)
      expect(Math.abs(parseFloat(videoFrame!.style.width) - ((STAGE_HEIGHT - 20) * VIDEO_WIDTH) / VIDEO_HEIGHT)).toBeLessThan(0.001)
      expect(videoFrame!.style.aspectRatio).toBe(`${VIDEO_WIDTH} / ${VIDEO_HEIGHT}`)
    } finally {
      dom.localStorage.removeItem(`manorama:view:${SLUG}`)
    }
  })

  test('vertical mode does not pick up the strip width rule', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const settings = {
      ...defaultGallerySettings({ slug: SLUG, title: 'Video frame', caption: '', date: '', images }),
      defaultMode: 'vertical' as const,
    }

    await mountViewer(root, settings)

    const videoFrame = root.querySelector('.viewer-frame[data-media-type="video"]') as unknown as HTMLElement | null
    expect(videoFrame).not.toBeNull()
    // An uncapped vertical video frame has never carried an inline box —
    // the strip-only rule must not leak into it.
    expect(videoFrame!.style.width).toBe('')
    expect(videoFrame!.style.aspectRatio).toBe('')
  })
})
