import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import { LibraryRail } from './LibraryRail'
import { LibraryDeviceStatus } from './GalleryList'
import { cacheFillRegistry } from '../lib/cache-fill'
import type { LibraryMediaCell, LibraryMediaLease } from '../lib/library-media'
import type { OfflineGallerySummary } from '../lib/offline-gallery'

/** The rail is a component contract: one cell per photograph at its own
 *  aspect ratio, media only inside the visible window, a 6px drag that pans
 *  without eating the click it followed, and a tap that opens at its own
 *  index. A fake loader records exactly which cells were asked to start
 *  work — the contract is that offscreen cells never are. */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
const settle = async () => {
  for (let i = 0; i < 8; i += 1) {
    runFrames()
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeAll(() => {
  prev = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, io: globals.IntersectionObserver }
  dom = new Window({ width: 375, height: 812, url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    nextFrameId += 1
    frames.push({ id: nextFrameId, callback: cb })
    return nextFrameId
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => { frames = frames.filter((f) => f.id !== id) }) as unknown as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.IntersectionObserver = prev.io
})

afterEach(() => {
  cacheFillRegistry.reset()
  dom.document.body.innerHTML = ''
})

const images = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `photo-${index}`,
    filename: `photo-${index}.jpg`,
    src: `https://cdn.example/photo-${index}.jpg`,
    width: index % 2 === 0 ? 1200 : 800,
    height: index % 2 === 0 ? 800 : 1200,
    alt: `Photograph ${index + 1}`,
    placeholder: '',
  }))

type RecordedLoader = {
  cells: LibraryMediaCell[]
  releases: number
  loader: { acquire(cell: LibraryMediaCell): Promise<LibraryMediaLease>; invalidate(id: string): void; release(): void }
}
const recordedLoader = (): RecordedLoader => {
  const recorded: RecordedLoader = {
    cells: [],
    releases: 0,
    loader: {
      acquire: async (cell: LibraryMediaCell) => {
        recorded.cells.push(cell)
        return {
          src: cell.remote,
          kind: cell.remote ? 'remote' : 'none',
          release: () => { recorded.releases += 1 },
        }
      },
      invalidate: () => {},
      release: () => {},
    },
  }
  return recorded
}

const mount = async (options: {
  count?: number
  onOpen?: (index: number) => void
  loader?: RecordedLoader['loader']
  placeholder?: string
  viewport?: { width: number; height: number; scrollLeft?: number }
} = {}) => {
  const recorded = recordedLoader()
  const opened: number[] = []
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const frames = images(options.count ?? 3)
  if (options.placeholder !== undefined && frames[0]) frames[0].placeholder = options.placeholder
  render(
    <LibraryRail
      galleryId="g-1"
      images={frames}
      loader={(options.loader ?? recorded.loader) as never}
      title="Kashmir"
      onOpen={options.onOpen ?? ((index) => opened.push(index))}
    />,
    container as unknown as HTMLElement,
  )
  if (options.viewport) {
    const rail = container.querySelector('.lib-rail') as unknown as HTMLElement
    Object.defineProperty(rail, 'clientWidth', { configurable: true, value: options.viewport.width })
    Object.defineProperty(rail, 'clientHeight', { configurable: true, value: options.viewport.height })
    rail.scrollLeft = options.viewport.scrollLeft ?? 0
  }
  await settle()
  return { container: container as unknown as HTMLElement, recorded, opened }
}

const pointer = (type: string, init: { clientX?: number; pointerId?: number; button?: number; bubbles?: boolean } = {}) =>
  new dom.Event(type, { bubbles: init.bubbles ?? true }) as unknown as PointerEvent & { clientX: number }
const withX = (event: Event, x: number) => Object.assign(event, { clientX: x, button: 0, pointerId: 1, pointerType: 'mouse' })

describe('LibraryRail', () => {
  test('every photograph rides the rail at its own aspect ratio', async () => {
    const { container, recorded } = await mount({ count: 3 })
    const cells = [...container.querySelectorAll('.lib-th')]
    expect(cells).toHaveLength(3)
    expect((cells[0] as unknown as HTMLElement).style.getPropertyValue('--ar')).toBe('1200 / 800')
    expect((cells[1] as unknown as HTMLElement).style.getPropertyValue('--ar')).toBe('800 / 1200')
    // Without an observer the fallback lets every cell acquire — the
    // loader's own budgets still bound what is actually held.
    expect(recorded.cells).toHaveLength(3)
    // Each asks by the same key the vault write uses: id's thumbnail entry.
    expect(recorded.cells.map((cell) => cell.entryId)).toEqual([
      'thumb:photo-0', 'thumb:photo-1', 'thumb:photo-2',
    ])
    // The remote preview is what lands in the <img>.
    const imgs = [...container.querySelectorAll('.lib-th img')]
    expect((imgs[0] as unknown as HTMLImageElement).src).toBe('https://cdn.example/photo-0.jpg')
  })

  test('a 1,000-item rail mounts only the visible window', async () => {
    const { container, recorded } = await mount({ count: 1000, viewport: { width: 300, height: 200 } })
    const rail = container.querySelector('.lib-rail') as HTMLElement
    expect(rail.getAttribute('data-rail-total')).toBe('1000')
    expect(container.querySelectorAll('.lib-th').length).toBeLessThan(30)
    expect(recorded.cells.length).toBeLessThan(30)
    expect((container.querySelector('.lib-rail-spacer') as HTMLElement).style.width).not.toBe('300px')

    rail.scrollLeft = 50_000
    rail.dispatchEvent(new dom.Event('scroll', { bubbles: true }) as unknown as Event)
    await settle()
    expect(Number((container.querySelector('.lib-th') as HTMLElement).dataset.at)).toBeGreaterThan(0)
    expect(container.querySelectorAll('.lib-th').length).toBeLessThan(30)
  })

  test('a remote placeholder is never loaded as a CSS background', async () => {
    const placeholder = 'https://evil.test/tracker'
    const { container } = await mount({ count: 1, placeholder })
    const cell = container.querySelector<HTMLButtonElement>('.lib-th')!
    expect(cell.style.backgroundImage).toBe('')
  })

  test('a thumb click opens its own index; rail background opens the first', async () => {
    const { container, opened } = await mount({ count: 3 })
    ;(container.querySelectorAll('.lib-th')[2] as unknown as HTMLElement).click()
    await settle()
    expect(opened).toEqual([2])
    ;(container.querySelector('.lib-rail') as unknown as HTMLElement).click()
    await settle()
    expect(opened).toEqual([2, 0])
  })

  test('a drag past 6px pans and suppresses the click; shorter travel still opens', async () => {
    const { container, opened } = await mount({ count: 3 })
    const rail = container.querySelector('.lib-rail') as unknown as HTMLElement

    // Short travel — an ordinary click still opens.
    rail.dispatchEvent(withX(pointer('pointerdown'), 100))
    rail.dispatchEvent(withX(pointer('pointermove'), 104))
    rail.dispatchEvent(withX(pointer('pointerup'), 104))
    ;(container.querySelectorAll('.lib-th')[0] as unknown as HTMLElement).click()
    await settle()
    expect(opened).toEqual([0])
    expect(rail.classList.contains('lib-rail--dragging')).toBe(false)

    // Real travel — the rail pans and the click it followed opens nothing.
    rail.dispatchEvent(withX(pointer('pointerdown'), 100))
    rail.dispatchEvent(withX(pointer('pointermove'), 90))
    rail.dispatchEvent(withX(pointer('pointerup'), 90))
    expect(rail.classList.contains('lib-rail--dragging')).toBe(false)
    expect(rail.scrollLeft).toBe(10)
    ;(container.querySelectorAll('.lib-th')[0] as unknown as HTMLElement).click()
    await settle()
    expect(opened).toEqual([0])

    // The click after that is free again.
    ;(container.querySelectorAll('.lib-th')[0] as unknown as HTMLElement).click()
    await settle()
    expect(opened).toEqual([0, 0])
  })

  test('only intersecting cells acquire media, and only while the rail is on the page', async () => {
    class StubObserver {
      static all: StubObserver[] = []
      readonly targets = new Set<unknown>()
      readonly root: unknown
      constructor(private readonly callback: IntersectionObserverCallback, options?: { root?: unknown }) {
        this.root = options?.root ?? null
        StubObserver.all.push(this)
      }
      observe(el: unknown) { this.targets.add(el) }
      unobserve(el: unknown) { this.targets.delete(el) }
      disconnect() { this.targets.clear() }
      takeRecords() { return [] }
      emit(entries: unknown[]) {
        this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
      }
      fire(visible: unknown[]) {
        const entries = [...this.targets].map((target) => ({
          target,
          isIntersecting: visible.includes(target),
        } as IntersectionObserverEntry))
        this.callback(entries, this as unknown as IntersectionObserver)
      }
    }
    StubObserver.all = []
    globals.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver
    const recorded = recordedLoader()
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    render(<LibraryRail galleryId="g-1" images={images(3)} loader={recorded.loader as never} title="Kashmir" onOpen={() => {}} />, container as unknown as HTMLElement)
    await settle()

    const cells = [...(container as unknown as HTMLElement).querySelectorAll<HTMLElement>('[data-rail-cell]')]
    const rail = (container as unknown as HTMLElement).querySelector('.lib-rail')
    const pageGate = StubObserver.all.find((observer) => observer.root === null)
    const cellObserver = StubObserver.all.find((observer) => observer.root === rail)
    expect(cellObserver).toBeTruthy()
    expect(pageGate).toBeTruthy()
    // The page gate owns the rail. Cells stay unwatched until it says the card is on screen.
    expect(pageGate!.targets.has(rail)).toBe(true)
    expect(cellObserver!.targets.size).toBe(0)
    expect(recorded.cells).toHaveLength(0)

    // A cell callback before the gate opens must not start media.
    cellObserver!.fire([cells[1]])
    await settle()
    expect(recorded.cells).toHaveLength(0)

    pageGate!.fire([rail])
    await settle()
    expect([...cellObserver!.targets]).toEqual(cells)
    cellObserver!.fire([cells[1]])
    await settle()
    expect(recorded.cells.map((cell) => cell.entryId)).toEqual(['thumb:photo-1'])

    // Leaving the page drops every lease and stops watching cells.
    pageGate!.fire([])
    await settle()
    expect(recorded.releases).toBe(1)
    expect(cellObserver!.targets.size).toBe(0)
    // Entries queued while the rail was leaving are delivered anyway — the
    // closed gate must drop them instead of re-marking cells visible.
    cellObserver!.emit(cells.map((target) => ({ target, isIntersecting: true })))
    await settle()
    expect(recorded.cells).toHaveLength(1)
    expect(recorded.releases).toBe(1)

    // Coming back re-watches, and a later cell intersection acquires again.
    pageGate!.fire([rail])
    cellObserver!.fire([cells[0], cells[2]])
    await settle()
    expect(recorded.cells.map((cell) => cell.entryId)).toEqual([
      'thumb:photo-1', 'thumb:photo-0', 'thumb:photo-2',
    ])
    delete globals.IntersectionObserver
  })

  test('a cache-fill arrival re-acquires its cell', async () => {
    const { recorded } = await mount({ count: 3 })
    const before = recorded.cells.length
    cacheFillRegistry.publish({ galleryId: 'g-1', item: { id: 'photo-1', entryId: 'thumb:photo-1', mimeType: 'image/jpeg', index: 1 } })
    await settle()
    expect(recorded.cells.length).toBe(before + 1)
    expect(recorded.cells[recorded.cells.length - 1].entryId).toBe('thumb:photo-1')
    // An arrival for another gallery asks nothing of this rail.
    cacheFillRegistry.publish({ galleryId: 'other', item: { id: 'photo-0', entryId: 'thumb:photo-0', mimeType: 'image/jpeg', index: 0 } })
    await settle()
    expect(recorded.cells.length).toBe(before + 1)
  })

  test('a pre-commit catalog refresh does not pull the fill meter backwards', async () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    const initial: OfflineGallerySummary = { status: 'cached', galleryId: 'g-1', owner: 'owner', slug: 'gallery', title: 'Gallery', images: 2 }
    let refresh: (summary: OfflineGallerySummary | undefined) => void = () => {}
    const Harness = () => {
      const [summary, setSummary] = useState<OfflineGallerySummary | undefined>(initial)
      refresh = setSummary
      return <LibraryDeviceStatus galleryId="g-1" imageCount={3} streamOnly={false} summary={summary} />
    }
    render(<Harness />, container)
    await settle()
    expect(container.textContent).toContain('Saving 2 of 3')
    cacheFillRegistry.publish({ galleryId: 'g-1', item: { id: 'photo-1', entryId: 'thumb:photo-1', mimeType: 'image/jpeg', index: 1 } })
    await settle()
    flushSync(() => refresh(undefined))
    await settle()
    expect(container.textContent).toContain('Saving 2 of 3')
  })

  test('an authoritative catalog removal resets the saved status', async () => {
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    const initial: OfflineGallerySummary = { status: 'cached', galleryId: 'g-1', owner: 'owner', slug: 'gallery', title: 'Gallery', images: 1 }
    let refresh: (summary: OfflineGallerySummary | undefined) => void = () => {}
    const Harness = () => {
      const [summary, setSummary] = useState<OfflineGallerySummary | undefined>(initial)
      refresh = setSummary
      return <LibraryDeviceStatus galleryId="g-1" imageCount={1} streamOnly={false} summary={summary} />
    }
    render(<Harness />, container)
    await settle()
    expect(container.textContent).toContain('Saved on this device')
    flushSync(() => refresh(undefined))
    await settle()
    expect(container.textContent).not.toContain('Saved on this device')
  })

  test('a batched viewport exit-and-return still loads the rail', async () => {
    class StubObserver {
      static instances: StubObserver[] = []
      readonly targets = new Set<unknown>()
      constructor(private readonly callback: IntersectionObserverCallback) {
        StubObserver.instances.push(this)
      }
      observe(el: unknown) { this.targets.add(el) }
      unobserve(el: unknown) { this.targets.delete(el) }
      disconnect() { this.targets.clear() }
      takeRecords() { return [] }
      fireBatch(entries: Array<{ target: unknown; isIntersecting: boolean }>) {
        this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
      }
    }
    globals.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver
    const { container, recorded } = await mount({ count: 3 })
    // The rail builds its viewport gate first and the cell observer second.
    const [gate, cells] = StubObserver.instances
    const rail = container.querySelector('.lib-rail') as unknown

    // Off-screen: cell watching stops entirely.
    gate.fireBatch([{ target: rail, isIntersecting: false }])
    expect(cells.targets.size).toBe(0)

    // Exit and return delivered as one batch — the latest entry decides,
    // so the rail re-watches without needing another transition first.
    gate.fireBatch([
      { target: rail, isIntersecting: false },
      { target: rail, isIntersecting: true },
    ])
    expect(cells.targets.size).toBe(3)
    cells.fireBatch([...container.querySelectorAll('[data-rail-cell]')].map((el) => ({ target: el, isIntersecting: true })))
    await settle()
    expect(recorded.cells.length).toBeGreaterThan(0)
  })
})
