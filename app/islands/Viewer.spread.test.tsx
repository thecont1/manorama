import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import { unmountTracker } from '../../test/unmount'
import Viewer from './Viewer'
import { GalleryCurtain } from '../components/GalleryShell'
import { defaultGallerySettings } from '../lib/gallery-settings'
import { resolveFoldLayout, type FoldLayout, type FoldSegment } from '../../packages/core/fold'
import type { GalleryImage, GalleryMediaItem, VideoItem } from '../../packages/core/imagesource'
import { flatSpreadSegments } from '../../packages/core/spread'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const photo = (id: string, width = 1600, height = 1200): GalleryImage => ({
  id,
  filename: `${id}.jpg`,
  src: `https://example.test/${id}.jpg`,
  width,
  height,
  alt: id,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const clip = (id: string): VideoItem => ({
  type: 'video',
  id,
  filename: `${id}.mp4`,
  src: `https://example.test/${id}.mp4`,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  poster: { src: 'https://example.test/poster.jpg', width: 1920, height: 1080 },
  alt: id,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const images: GalleryMediaItem[] = [photo('p0', 1800, 1200), clip('v1'), photo('p2', 1200, 1800), photo('p3')]

const layoutFor = (horizontalSizeClass: 'compact' | 'regular', divided = false): FoldLayout => resolveFoldLayout({
  viewport: { width: 1200, height: 800 },
  ios: {
    horizontalSizeClass,
    verticalSizeClass: 'regular',
    verticalBarEdge: 'unspecified',
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    regions: divided ? [{ kind: 'division', active: true, frame: { x: 590, y: 0, width: 20, height: 800 } }] : [],
  },
})

type SpreadCall = {
  frames: readonly GalleryMediaItem[]
  activeIndex: number
  segments: readonly FoldSegment[]
  dpr: number
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch, localStorage: globals.localStorage,
  }
  dom = new Window({ url: 'http://localhost/spread' })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => { callback(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
  ;(dom.window as unknown as { matchMedia: () => { matches: boolean } }).matchMedia = () => ({ matches: false })
  ;(dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1
  globals.localStorage = dom.localStorage
})

const disposers: (() => void)[] = []

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
  dom.document.body.classList.remove('gallery-entered')
  dom.localStorage.clear()
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.svg
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.fetch = prev.fetch
  globals.localStorage = prev.localStorage
})

const mount = async ({ mode = 'spread', initialIndex = 0, foldLayout = layoutFor('regular'), items = images, withCurtain = false }: {
  mode?: 'strip' | 'vertical' | 'single' | 'spread'
  initialIndex?: number
  foldLayout?: FoldLayout
  items?: GalleryMediaItem[]
  withCurtain?: boolean
} = {}) => {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  const calls: SpreadCall[] = []
  const settings = {
    ...defaultGallerySettings({ slug: 'spread', title: 'Spread', caption: '', date: '', images: items }),
    defaultMode: mode,
  }
  const curtainRoot = withCurtain ? dom.document.createElement('div') : undefined
  if (curtainRoot) {
    root.appendChild(curtainRoot)
  }
  const viewerRoot = dom.document.createElement('div')
  root.appendChild(viewerRoot)
  const dropCurtain = curtainRoot
    ? mounts.mount(<GalleryCurtain settings={settings} />, curtainRoot as unknown as HTMLElement)
    : undefined
  const dropViewer = mounts.mount(
    <Viewer
      slug="spread"
      galleryTitle="Spread"
      images={items}
      settings={settings}
      initialIndex={initialIndex}
      foldLayout={foldLayout}
      foldRenderer={(props) => {
        calls.push(props)
        return <div data-spread-stage />
      }}
    />,
    viewerRoot as unknown as HTMLElement,
  )
  // Renders into distinct containers: unmount each through its tracker
  // drop — deleting DOM alone skips effect cleanup, and so does
  // render(null).
  const dispose = () => {
    dropViewer()
    dropCurtain?.()
  }
  disposers.push(dispose)
  await settle()
  await settle()
  return { root: root as unknown as HTMLElement, calls, dispose }
}

describe('explicit Spread', () => {
  test('an active division does not substitute a spread for Strip', async () => {
    const { root, calls } = await mount({ mode: 'strip', foldLayout: layoutFor('regular', true) })
    expect(calls).toHaveLength(0)
    expect(root.querySelector('[data-track]')).not.toBeNull()
    expect(root.querySelector<HTMLElement>('[data-chrome-bottom]')?.style.left).toBe('610px')
  })

  test('flat vertical chrome stays edge-anchored while divided chrome keeps its safe region', async () => {
    const flat = await mount({
      mode: 'strip',
      foldLayout: { ...layoutFor('regular'), verticalBarEdge: 'trailing' },
    })
    const flatChrome = flat.root.querySelector<HTMLElement>('[data-chrome-bottom]')!
    expect(flatChrome.classList.contains('m-chrome--side-trailing')).toBe(true)
    expect(flatChrome.style.left).toBe('1140px')
    expect(flatChrome.style.right).toBe('auto')
    expect(flatChrome.style.width).toBe('60px')
    expect(flat.root.querySelector('.stage-arrows--system-trailing')).not.toBeNull()

    const divided = await mount({
      mode: 'strip',
      foldLayout: { ...layoutFor('regular', true), verticalBarEdge: 'trailing' },
    })
    const dividedChrome = divided.root.querySelector<HTMLElement>('[data-chrome-bottom]')!
    expect(dividedChrome.style.left).toBe('1140px')
    expect(dividedChrome.style.width).toBe('60px')
  })

  test('flat Spread keeps photographer order and uses a centred gutter', async () => {
    const { calls } = await mount({ items: [photo('landscape', 1800, 1200), photo('portrait', 1200, 1800)] })
    const call = calls[calls.length - 1]
    expect(call.frames.map((frame) => frame.id)).toEqual(['landscape', 'portrait'])
    expect(call.segments).toHaveLength(2)
    expect(call.segments).toEqual(flatSpreadSegments(call.frames, { x: 8, y: 8, width: 1124, height: 784 }, 1))
    expect(call.segments[0].height).toBe(call.segments[1].height)
    expect(call.segments[0].width).toBeGreaterThan(call.segments[1].width)
  })

  test('a video and its neighbouring photographs each keep their ordered spread', async () => {
    const before = await mount({ initialIndex: 0 })
    expect(before.calls[before.calls.length - 1].frames.map((frame) => frame.id)).toEqual(['p0'])

    const video = await mount({ initialIndex: 1 })
    const videoCall = video.calls[video.calls.length - 1]
    expect(videoCall.frames.map((frame) => frame.id)).toEqual(['v1'])
    expect(videoCall.segments).toEqual([{ x: 8, y: 8, width: 1124, height: 784 }])

    const after = await mount({ initialIndex: 2 })
    expect(after.calls[after.calls.length - 1].frames.map((frame) => frame.id)).toEqual(['p2', 'p3'])
  })

  test('compact fallback presents Strip without discarding the saved Spread preference', async () => {
    dom.localStorage.setItem('manorama:view:spread-resize', JSON.stringify({ mode: 'spread' }))
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const calls: SpreadCall[] = []
    let widen: (() => void) | null = null
    const settings = {
      ...defaultGallerySettings({ slug: 'spread-resize', title: 'Spread', caption: '', date: '', images }),
      defaultMode: 'strip' as const,
    }
    const Harness = () => {
      const [foldLayout, setFoldLayout] = useState(layoutFor('compact'))
      widen = () => setFoldLayout(layoutFor('regular'))
      return <Viewer
        slug="spread-resize"
        images={images}
        settings={settings}
        initialIndex={2}
        foldLayout={foldLayout}
        foldRenderer={(props) => { calls.push(props); return <div data-spread-stage /> }}
      />
    }
    const dropHarness = mounts.mount(<Harness />, root as unknown as HTMLElement)
    disposers.push(dropHarness)
    await settle()
    expect(root.querySelector('.viewer-stage.mode-strip')).not.toBeNull()
    expect(calls).toHaveLength(0)
    expect(root.querySelector('[data-chrome-position]')?.getAttribute('aria-label')).toContain('Photograph 3 of 4')
    // The fold fallback is temporary — it never rewrites the stored choice.
    expect(JSON.parse(dom.localStorage.getItem('manorama:view:spread-resize') ?? '{}')).toEqual({ mode: 'spread' })

    flushSync(() => widen?.())
    await settle()
    expect(calls.length).toBeGreaterThan(0)
    expect(root.querySelector('[data-spread-stage]')).not.toBeNull()
    expect(root.querySelector('[data-chrome-position]')?.getAttribute('aria-label')).toContain('Photograph 3 of 4')

    dropHarness()
    const remount = dom.document.createElement('div')
    dom.document.body.appendChild(remount)
    disposers.push(mounts.mount(
      <Viewer
        slug="spread-resize"
        images={images}
        settings={settings}
        initialIndex={2}
        foldLayout={layoutFor('regular')}
        foldRenderer={(props) => { calls.push(props); return <div data-spread-stage /> }}
      />,
      remount as unknown as HTMLElement,
    ))
    await settle()
    expect(remount.querySelector('[data-spread-stage]')).not.toBeNull()
  })

  test('an active division confines curtain copy and every end-card presentation to the trailing region', async () => {
    const divided = layoutFor('regular', true)
    const strip = await mount({ mode: 'strip', foldLayout: divided, withCurtain: true })
    const curtain = strip.root.querySelector<HTMLElement>('[data-curtain]')!
    expect(curtain.style.paddingLeft).toBe('638px')
    expect(curtain.style.paddingRight).toBe('28px')
    const stripEnd = strip.root.querySelector<HTMLElement>('[data-endcard]')!
    expect(stripEnd.style.flex).toBe('0 0 590px')
    expect(stripEnd.style.marginRight).toBe('0px')

    const vertical = await mount({ mode: 'vertical', foldLayout: divided })
    const feedEnd = vertical.root.querySelector<HTMLElement>('[data-endcard]')!
    expect(feedEnd.style.width).toBe('590px')
    /* Blank is retired: the mount lands on the Dark default, whose 10px
       image margin is deducted from the feed endcard's offset — the same
       deduction Light and Dark have always shared. */
    expect(feedEnd.style.marginLeft).toBe('600px')

    const single = await mount({ mode: 'single', foldLayout: divided })
    const singleEnd = single.root.querySelector<HTMLElement>('[data-endcard]')!
    expect(singleEnd.style.position).toBe('absolute')
    expect(singleEnd.style.left).toBe('610px')
    expect(singleEnd.style.width).toBe('590px')
  })
})
