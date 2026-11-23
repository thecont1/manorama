import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync } from 'hono/jsx/dom'
import { unmountTracker } from '../../test/unmount'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { ExifData, GalleryImage, GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * `readMetadata` is the native/local lazy path: the first time a still's
 * Info sheet opens, the host-supplied reader runs once per image id and
 * its result merges UNDER the manifest's own `exif` (manifest wins per
 * field). Without the prop — every web mount — nothing is fetched and the
 * sheet shows manifest rows only.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const SLUG = 'viewer-metadata'

const armed = new Map<number, FrameRequestCallback>()
let nextFrameId = 1

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

const drainFrames = () => {
  const pending = [...armed.entries()]
  armed.clear()
  for (const [, callback] of pending) callback(0)
}

const mounts = unmountTracker()

const still = (id: string, exif?: ExifData): GalleryImage => ({
  id,
  filename: `${id}.jpg`,
  src: `https://example.test/${id}.jpg`,
  width: 800,
  height: 600,
  alt: `${id} test photograph`,
  c2pa: false,
  exif,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
})

const images: GalleryMediaItem[] = [still('first', { camera: 'Canon EOS R5', title: 'Manifest Title' }), still('second')]

const settingsFor = () => ({
  ...defaultGallerySettings({ slug: SLUG, title: 'Metadata', caption: '', date: '', images }),
  // Single mode commits the index directly — strip mode would resolve the
  // unmeasured test strip to its last frame.
  defaultMode: 'single' as const,
})

// happy-dom's DOM types do not satisfy lib.dom's ParentNode/Element
// constraints, so the helpers talk to the tree through this structural
// view — the same seam the other Viewer specs use.
interface Queryable {
  querySelector: (selector: string) => unknown
  querySelectorAll: (selector: string) => ArrayLike<unknown>
}
interface TextEl {
  textContent: string | null
  querySelector: (selector: string) => unknown
}

const mountViewer = async (root: Queryable, readMetadata?: (image: GalleryImage) => Promise<ExifData | undefined>) => {
  mounts.mount(
    <Viewer slug={SLUG} galleryTitle="Metadata" images={images} settings={settingsFor()} readMetadata={readMetadata} />,
    root as unknown as HTMLElement,
  )
  await settle()
  drainFrames()
  await settle()
  drainFrames()
  await settle()
}

const openInfo = async (root: Queryable) => {
  const button = root.querySelector('.m-chrome-pill[aria-label="Info"]') as unknown as { click: () => void } | null
  expect(button).not.toBeNull()
  button!.click()
  // The island's passive effects run through the rAF queue — drain it so
  // the lazy metadata effect actually fires before asserting.
  await settle()
  drainFrames()
  await settle()
  drainFrames()
  await settle()
}

const rows = (root: Queryable) =>
  Array.from(root.querySelectorAll('.m-info-row')).map((row) => {
    const el = row as unknown as TextEl
    const cell = (selector: string) => el.querySelector(selector) as unknown as TextEl | null
    return { label: cell('dt')?.textContent, value: cell('dd')?.textContent }
  })

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

describe('lazy embedded metadata in the Info sheet', () => {
  test('readMetadata runs once per still and merges under manifest exif', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const calls: string[] = []
    const readMetadata = async (image: GalleryImage) => {
      calls.push(image.id)
      return { title: 'Lazy Title', creator: 'Lazy Creator', camera: 'LazyCam' }
    }
    await mountViewer(root, readMetadata)

    await openInfo(root)
    expect(calls).toEqual(['first'])
    const found = rows(root)
    // Manifest title and camera win; the lazy-only creator fills in.
    expect(found.find((r) => r.label === 'Title')?.value).toBe('Manifest Title')
    expect(found.find((r) => r.label === 'Camera')?.value).toBe('Canon EOS R5')
    expect(found.find((r) => r.label === 'Creator')?.value).toBe('Lazy Creator')
  })

  test('a settled read is not repeated when the sheet reopens', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    let calls = 0
    const readMetadata = async () => { calls += 1; return { title: 'Once' } }
    await mountViewer(root, readMetadata)

    await openInfo(root)
    expect(calls).toBe(1)
    // Close via Escape, then reopen — the per-id result is already settled.
    dom.window.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    await openInfo(root)
    expect(calls).toBe(1)
  })

  test('without readMetadata the sheet shows manifest rows only', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    await mountViewer(root)
    await openInfo(root)
    const labels = rows(root).map((r) => r.label)
    expect(labels).toContain('Title')
    expect(labels).toContain('Camera')
    expect(labels).not.toContain('Creator')
    expect(labels).not.toContain('Keywords')
  })

  test('a failing readMetadata settles quietly — no extra rows', async () => {
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const readMetadata = async () => { throw new Error('no bytes') }
    await mountViewer(root, readMetadata)
    await openInfo(root)
    const labels = rows(root).map((r) => r.label)
    expect(labels).toContain('Title')
    expect(labels).not.toContain('Creator')
  })
})
