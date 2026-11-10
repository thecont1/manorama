import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import Viewer from './Viewer'
import { defaultGallerySettings } from '../lib/gallery-settings'
import type { GalleryMediaItem } from '../../packages/core/imagesource'

/**
 * The native navigation handle.
 *
 * A native shell has a Gallery menu with its own Next / Previous / "go to
 * photograph N" commands, and the Viewer owns the index. The handle is how
 * the shell asks: it moves the stage, it never sets the index.
 *
 * The seam matters because the alternative — synthesising the keys a person
 * would press — cannot express a jump. The right arrow is a viewport
 * gesture, not a step, so "Home, then N times ArrowRight" lands on
 * whatever frame the strip stopped at rather than on N.
 *
 * It is a handle rather than a request prop on purpose. A request prop can
 * only be delivered by re-rendering, and this bundle's DOM renderer
 * replaces the container's children instead of diffing them — so a
 * re-render destroys the Viewer and mounts a new one, whose unmeasured
 * strip then settles on the last frame instead of the one that was asked
 * for. Asking the mounted Viewer to move keeps the strip measured, so the
 * commanded photograph sticks.
 *
 * These run in single mode on purpose. In strip mode the committed index
 * is read back from the strip's scroll position, which needs a laid-out
 * viewport — a test DOM has none, so the strip resolves every jump to the
 * last frame and the seam would be untestable there. Single mode commits
 * the index directly, which is the seam and nothing else.
 */

/** The repo's settle: let the scheduled work run, then flush the render. */
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const SLUG = 'navigation-handle'
const COUNT = 5

const images: GalleryMediaItem[] = Array.from({ length: COUNT }, (_, index) => ({
  id: `frame-${index}`,
  filename: `frame-${index}.jpg`,
  src: `https://example.test/frame-${index}.jpg`,
  width: 2267,
  height: 1700,
  alt: `frame ${index}`,
  c2pa: false,
  placeholder: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
}))

const settingsFor = (slug: string) => ({
  ...defaultGallerySettings({ slug, title: 'Navigation', caption: '', date: '', images }),
  defaultMode: 'single' as const,
})

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
  // The viewer asks about the reduced-motion preference and about the
  // device's scale. Neither is available in a test DOM.
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

/**
 * A mounted Viewer, and the handle the shell would hold.
 *
 * `rerender` exists so the test can prove the handle survives a re-render:
 * the handle is refreshed on every render, because it closes over the
 * viewer's current mode and index.
 */
const mountViewer = (slug: string, onPosition: (index: number) => void) => {
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  const navigationRef: { current: { goTo(index: number): void } | null } = { current: null }
  let bump: (() => void) | null = null

  const Harness = () => {
    const [tick, setTick] = useState(0)
    bump = () => setTick(tick + 1)
    return (
      <Viewer
        slug={slug}
        galleryTitle="Navigation"
        images={images}
        settings={settingsFor(slug)}
        navigationRef={navigationRef}
        onPositionChange={(position) => { onPosition(position.index) }}
      />
    )
  }

  render(<Harness />, root as unknown as HTMLElement)
  return {
    navigationRef,
    rerender: () => {
      if (!bump) throw new Error('the harness never mounted')
      bump()
    },
  }
}

describe('the native navigation handle', () => {
  test('a shell can ask for a photograph by index', async () => {
    const reported: number[] = []
    const shell = mountViewer(SLUG, (index) => { reported.push(index) })
    await settle()

    expect(reported[0]).toBe(0)
    expect(shell.navigationRef.current).not.toBeNull()

    shell.navigationRef.current?.goTo(3)
    await settle()

    // The handle moved the stage: the viewer reports the new index.
    expect(reported[reported.length - 1]).toBe(3)
  })

  test('the handle survives a re-render and still moves the stage', async () => {
    // The handle is refreshed on every render so it always holds the
    // current `goTo`. If it were captured once, a stale closure would
    // move from the wrong place.
    const reported: number[] = []
    const shell = mountViewer(`${SLUG}-rerender`, (index) => { reported.push(index) })
    await settle()

    shell.rerender()
    await settle()

    expect(shell.navigationRef.current).not.toBeNull()
    shell.navigationRef.current?.goTo(4)
    await settle()
    expect(reported[reported.length - 1]).toBe(4)
  })

  test('the same photograph asked for twice is harmless', async () => {
    // Two commands to the same index are two commands, and neither is
    // swallowed nor doubled.
    const reported: number[] = []
    const shell = mountViewer(`${SLUG}-twice`, (index) => { reported.push(index) })
    await settle()

    shell.navigationRef.current?.goTo(2)
    await settle()
    shell.navigationRef.current?.goTo(2)
    await settle()

    expect(reported[reported.length - 1]).toBe(2)
  })

  test('the web path is untouched — a viewer with no handle still works', async () => {
    // The web never passes a handle. If the seam cost the web anything,
    // this is where it would show.
    const root = dom.document.createElement('div')
    dom.document.body.appendChild(root)
    const reported: number[] = []
    const slug = `${SLUG}-web`

    render(
      <Viewer
        slug={slug}
        galleryTitle="Navigation"
        images={images}
        settings={settingsFor(slug)}
        onPositionChange={(position) => { reported.push(position.index) }}
      />,
      root as unknown as HTMLElement,
    )
    await settle()

    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]).toBe(0)
  })
})
