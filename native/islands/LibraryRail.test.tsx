import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { LibraryRail } from './LibraryRail'
import { cacheFillRegistry } from '../lib/cache-fill'
import type { LibraryMediaCell, LibraryMediaLease } from '../lib/library-media'

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
} = {}) => {
  const recorded = recordedLoader()
  const opened: number[] = []
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  render(
    <LibraryRail
      galleryId="g-1"
      images={images(options.count ?? 3)}
      loader={(options.loader ?? recorded.loader) as never}
      title="Kashmir"
      onOpen={options.onOpen ?? ((index) => opened.push(index))}
    />,
    container as unknown as HTMLElement,
  )
  await settle()
  return { container, recorded, opened }
}

const pointer = (type: string, init: { clientX?: number; pointerId?: number; button?: number; bubbles?: boolean } = {}) =>
  new dom.Event(type, { bubbles: init.bubbles ?? true }) as unknown as PointerEvent & { clientX: number }
const withX = (event: Event, x: number) => Object.assign(event, { clientX: x, button: 0, pointerId: 1, pointerType: 'mouse' })

describe('LibraryRail', () => {
  test('every photograph rides the rail at its own aspect ratio', async () => {
    const { container, recorded } = await mount({ count: 3 })
    const cells = [...container.querySelectorAll<HTMLButtonElement>('.lib-th')]
    expect(cells).toHaveLength(3)
    expect(cells[0].style.getPropertyValue('--ar')).toBe('1200 / 800')
    expect(cells[1].style.getPropertyValue('--ar')).toBe('800 / 1200')
    // Without an observer the fallback lets every cell acquire — the
    // loader's own budgets still bound what is actually held.
    expect(recorded.cells).toHaveLength(3)
    // Each asks by the same key the vault write uses: id's thumbnail entry.
    expect(recorded.cells.map((cell) => cell.entryId)).toEqual([
      'thumb:photo-0', 'thumb:photo-1', 'thumb:photo-2',
    ])
    // The remote preview is what lands in the <img>.
    const imgs = [...container.querySelectorAll<HTMLImageElement>('.lib-th img')]
    expect(imgs[0].src).toBe('https://cdn.example/photo-0.jpg')
  })

  test('a thumb click opens its own index; rail background opens the first', async () => {
    const { container, opened } = await mount({ count: 3 })
    ;(container.querySelectorAll<HTMLButtonElement>('.lib-th')[2]).click()
    await settle()
    expect(opened).toEqual([2])
    ;(container.querySelector('.lib-rail') as HTMLElement).click()
    await settle()
    expect(opened).toEqual([2, 0])
  })

  test('a drag past 6px pans and suppresses the click; shorter travel still opens', async () => {
    const { container, opened } = await mount({ count: 3 })
    const rail = container.querySelector('.lib-rail') as HTMLElement

    // Short travel — an ordinary click still opens.
    rail.dispatchEvent(withX(pointer('pointerdown'), 100))
    rail.dispatchEvent(withX(pointer('pointermove'), 104))
    rail.dispatchEvent(withX(pointer('pointerup'), 104))
    ;(container.querySelectorAll<HTMLButtonElement>('.lib-th')[0]).click()
    await settle()
    expect(opened).toEqual([0])
    expect(rail.classList.contains('lib-rail--dragging')).toBe(false)

    // Real travel — the rail pans and the click it followed opens nothing.
    rail.dispatchEvent(withX(pointer('pointerdown'), 100))
    rail.dispatchEvent(withX(pointer('pointermove'), 90))
    rail.dispatchEvent(withX(pointer('pointerup'), 90))
    expect(rail.classList.contains('lib-rail--dragging')).toBe(false)
    expect(rail.scrollLeft).toBe(10)
    ;(container.querySelectorAll<HTMLButtonElement>('.lib-th')[0]).click()
    await settle()
    expect(opened).toEqual([0])

    // The click after that is free again.
    ;(container.querySelectorAll<HTMLButtonElement>('.lib-th')[0]).click()
    await settle()
    expect(opened).toEqual([0, 0])
  })

  test('only intersecting cells acquire media', async () => {
    class StubObserver {
      static last: StubObserver | undefined
      readonly targets = new Set<Element>()
      constructor(private readonly callback: IntersectionObserverCallback) {
        StubObserver.last = this
      }
      observe(el: Element) { this.targets.add(el) }
      unobserve(el: Element) { this.targets.delete(el) }
      disconnect() { this.targets.clear() }
      fire(visible: Element[]) {
        const entries = [...this.targets].map((target) => ({
          target,
          isIntersecting: visible.includes(target),
        } as IntersectionObserverEntry))
        this.callback(entries, this as unknown as IntersectionObserver)
      }
    }
    globals.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver
    const recorded = recordedLoader()
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    render(<LibraryRail galleryId="g-1" images={images(3)} loader={recorded.loader as never} title="Kashmir" onOpen={() => {}} />, container as unknown as HTMLElement)
    await settle()

    // Nothing intersecting yet — offscreen media never starts.
    expect(recorded.cells).toHaveLength(0)
    const cells = [...container.querySelectorAll<HTMLElement>('[data-rail-cell]')]
    StubObserver.last!.fire([cells[1]])
    await settle()
    expect(recorded.cells.map((cell) => cell.entryId)).toEqual(['thumb:photo-1'])

    // Leaving the window releases the lease.
    StubObserver.last!.fire([])
    await settle()
    expect(recorded.releases).toBe(1)

    // Entering again re-acquires.
    StubObserver.last!.fire([cells[0], cells[2]])
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
})
