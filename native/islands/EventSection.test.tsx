import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { useEventClustering } from '../lib/event-clustering-state'
import type { EventClusteringClient } from '../lib/event-clustering'
import EventSection from './EventSection'
import { eventPhotoWindow, eventViewerImages } from './EventViewer'
import type { EventClusteringController } from '../lib/event-clustering-state'
import type { EventCluster } from '../../packages/core/event-clustering'

const cluster: EventCluster = {
  id: 'evt_0123456789abcdef0123', startDate: new Date(2026, 2, 12).getTime(), endDate: new Date(2026, 2, 13).getTime(),
  isMultiDay: true, coverItemId: 'a', itemIds: ['a', 'b'],
  subDays: [{ id: '2026-03-12', date: new Date(2026, 2, 12).getTime(), itemIds: ['a'] }, { id: '2026-03-13', date: new Date(2026, 2, 13).getTime(), itemIds: ['b'] }],
}
const controller = (patch: Partial<EventClusteringController> = {}): EventClusteringController => ({
  status: { configured: true, label: 'Camera Roll', isAvailable: true, lastIndexedAt: null, eventCount: 1 },
  scan: { clusters: [cluster], screenshotCount: 0, rootPath: null }, busy: false, error: null, sourceRevision: 0,
  client: {} as EventClusteringController['client'], refresh: async () => {}, pick: async () => {}, clear: async () => {}, setDownload: async () => {}, ...patch,
})

describe('native event presentation', () => {
  test('capability absent or declaration absent shows no teaser or settings control', () => {
    expect(String(<EventSection events={controller({ status: null })} onOpen={() => {}} />)).toBe('')
    expect(String(<EventSection events={controller({ status: { configured: false, label: null, isAvailable: false, eventCount: 0, lastIndexedAt: null } })} onOpen={() => {}} />)).toBe('')
  })
  test('date, count and subday controls follow natural DOM order with no nested buttons', () => {
    const html = String(<EventSection events={controller()} onOpen={() => {}} presentation={{ locale: 'en-GB', calendar: 'gregory' }} />)
    expect(html).toMatch(/12\s*–\s*13 Mar 2026/)
    expect(html).toContain('2 photographs')
    expect(html.indexOf('12 Mar</button>')).toBeLessThan(html.indexOf('13 Mar</button>'))
    expect(html).toContain('role="list"')
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/)
  })
  test('localized card and day names include all visible context', () => {
    const html = String(<EventSection events={controller()} onOpen={() => {}} presentation={{
      locale: 'de-DE', calendar: 'gregory',
      messages: {
        photographCount: { one: '{count} Foto', other: '{count} Fotos' }, multiDay: 'Mehrtägig',
        daysIn: 'Tage in {date}', eventDay: '{day} ({event})',
      },
    }} />)
    expect(html).toContain('2 Fotos')
    expect(html).toContain('Mehrtägig')
    expect(html).toMatch(/role="group" aria-label="Tage in 12\.\s*–\s*13\. März 2026"/)
    expect(html).toMatch(/aria-label="12\. März \(12\.\s*–\s*13\. März 2026\)"/)
    expect(html).toMatch(/aria-label="12\.\s*–\s*13\. März 2026, 2 Fotos und Mehrtägig"/)
  })
  test('indexing, empty, unavailable and scan failure are distinct', () => {
    expect(String(<EventSection events={controller({ scan: null })} onOpen={() => {}} />)).toContain('Reading events')
    expect(String(<EventSection events={controller({ scan: { clusters: [], screenshotCount: 2, rootPath: null } })} onOpen={() => {}} />)).toContain('No events')
    expect(String(<EventSection events={controller({ status: { ...controller().status!, isAvailable: false } })} onOpen={() => {}} />)).toContain('Review the event source below')
    expect(String(<EventSection events={controller({ error: 'Cannot read events' })} onOpen={() => {}} />)).toContain('Try again')
  })
  test('limited access stays actionable inside the event list', () => {
    const limited = controller({ status: { ...controller().status!, authorization: 'limited', selectedPhotoCount: 12 } })
    const html = String(<EventSection events={limited} onOpen={() => {}} />)
    expect(html).toContain('Showing 12 selected photos')
    expect(html).toContain('Choose photos')
    const denied = controller({ status: { ...controller().status!, authorization: 'denied', isAvailable: false } })
    expect(String(<EventSection events={denied} onOpen={() => {}} />)).toContain('Photos access is not available')
  })
  test('viewer keeps all members, including every cloud/missing item and events over 1000 photos', () => {
    const items = eventViewerImages(cluster, { a: { id: 'a', url: null, src: null, width: 1200, height: 800, state: 'cloudOnly' } })
    expect(items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(items.every((item) => item.src.startsWith('data:image/svg+xml,'))).toBe(true)
    expect(items.every((item) => item.width === 1 && item.height === 1)).toBe(true)
    const huge = { ...cluster, itemIds: Array.from({ length: 1201 }, (_, index) => `id${index}`) }
    expect(eventViewerImages(huge, {}).length).toBe(1201)
  })
  test('a ready original keeps its exact source dimensions and no thumbnail variants', () => {
    const image = eventViewerImages(cluster, { a: { id: 'a', url: 'file:///original.heic', src: 'capacitor://original.heic', width: 20, height: 10, state: 'ready' } })[0]
    expect(image.src).toBe('capacitor://original.heic')
    expect(image.width).toBe(20); expect(image.height).toBe(10); expect(image.variants).toBeUndefined()
  })
  test('visited originals stay within the current three-photo window', () => {
    const ids = Array.from({ length: 40 }, (_, index) => `photo${index}`)
    let photos: Record<string, import('../lib/event-clustering').EventPhoto> = {}
    const released: string[] = []
    for (let index = 0; index < ids.length; index++) {
      photos[ids[index]] = { id: ids[index], url: `file:///original-${index}.jpg`, src: `capacitor://original-${index}.jpg`, width: 120, height: 80, state: 'ready' }
      const window = eventPhotoWindow(ids, index, photos)
      photos = window.retained
      released.push(...window.released)
      expect(Object.keys(photos).length).toBeLessThanOrEqual(3)
      expect(photos[ids[index]]).toBeDefined()
    }
    expect(released.length).toBe(38)
    const jumped = eventPhotoWindow(ids, 0, photos)
    expect(Object.keys(jumped.retained)).toEqual([])
    expect(jumped.released.length).toBe(2)
    expect(ids.length).toBe(40)
  })
  test('a library revision reloads a same-key cover after native cache invalidation', async () => {
    const globals = globalThis as Record<string, unknown>
    const previous = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, observer: globals.IntersectionObserver }
    const dom = new Window({ url: 'http://localhost/' })
    globals.window = dom; globals.document = dom.document
    globals.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 1)
    globals.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
    globals.IntersectionObserver = undefined
    let requests = 0
    const client = { images: async () => [{ id: 'a', url: `file:///cover-${++requests}.jpg`, src: `data:image/svg+xml,<svg id='cover-${requests}'/>`, width: 120, height: 80, state: 'ready' }] } as unknown as EventClusteringClient
    const root = dom.document.createElement('div')
    dom.document.body.append(root)
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(condition()).toBe(true)
    }
    try {
      render(<EventSection events={controller({ client })} onOpen={() => {}} />, root as unknown as HTMLElement)
      await until(() => requests === 1 && (root.querySelector('img')?.getAttribute('src')?.includes('cover-1') ?? false))
      render(<EventSection events={controller({ client, sourceRevision: 1 })} onOpen={() => {}} />, root as unknown as HTMLElement)
      await until(() => requests === 2 && (root.querySelector('img')?.getAttribute('src')?.includes('cover-2') ?? false))
    } finally {
      render(null, root as unknown as HTMLElement)
      globals.window = previous.window; globals.document = previous.document
      globals.requestAnimationFrame = previous.raf; globals.cancelAnimationFrame = previous.caf
      globals.IntersectionObserver = previous.observer
    }
  })
  test('a viewer cancellation retries an independent cover once', async () => {
    const globals = globalThis as Record<string, unknown>
    const previous = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, observer: globals.IntersectionObserver }
    const dom = new Window({ url: 'http://localhost/' })
    globals.window = dom; globals.document = dom.document
    globals.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 1)
    globals.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
    globals.IntersectionObserver = undefined
    let requests = 0
    const client = { images: async () => {
      requests += 1
      if (requests === 1) throw new Error('Event photograph request cancelled')
      return [{ id: 'a', url: 'file:///cover.jpg', src: 'data:image/svg+xml,<svg id="cover"/>', width: 120, height: 80, state: 'ready' }]
    } } as unknown as EventClusteringClient
    const root = dom.document.createElement('div')
    dom.document.body.append(root)
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(condition()).toBe(true)
    }
    try {
      render(<EventSection events={controller({ client })} onOpen={() => {}} />, root as unknown as HTMLElement)
      await until(() => requests === 2 && root.querySelector('img') !== null)
      expect(root.textContent).not.toContain('Reading preview')
    } finally {
      render(null, root as unknown as HTMLElement)
      globals.window = previous.window; globals.document = previous.document
      globals.requestAnimationFrame = previous.raf; globals.cancelAnimationFrame = previous.caf
      globals.IntersectionObserver = previous.observer
    }
  })
  test('clear wins a late scan and permission prompt; changed authorization refreshes', async () => {
    const globals = globalThis as Record<string, unknown>
    const previous = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame }
    const dom = new Window({ url: 'http://localhost/' })
    globals.window = dom; globals.document = dom.document
    globals.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 1)
    globals.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
    let configured = true
    let authorization: 'authorized' | 'denied' = 'authorized'
    let scanReply: ((value: NonNullable<EventClusteringController['scan']>) => void) | undefined
    let pickReply: (() => void) | undefined
    let changed: (() => void) | undefined
    let holdScan = false
    const client = {
      status: async () => ({ configured, authorization, label: configured ? 'Camera Roll' : null, isAvailable: configured && authorization === 'authorized', eventCount: configured ? 1 : 0, lastIndexedAt: null }),
      scan: async () => holdScan ? await new Promise((resolve) => { scanReply = resolve }) : ({ clusters: [cluster], screenshotCount: 0, rootPath: null }),
      pick: async () => { await new Promise<void>((resolve) => { pickReply = resolve }); return null },
      clear: async () => { configured = false }, close: async () => {},
      changes: async (listener: () => void) => { changed = listener; return { remove: async () => { changed = undefined } } },
    } as EventClusteringClient
    let latest: EventClusteringController | undefined
    function Harness() { latest = useEventClustering(client); return <output>{latest.status?.authorization}</output> }
    const root = dom.document.createElement('div')
    dom.document.body.append(root)
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 2000
      while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(condition()).toBe(true)
    }
    try {
      render(<Harness />, root as unknown as HTMLElement)
      await until(() => latest?.scan !== null && latest?.status?.configured === true)
      holdScan = true
      const pendingScan = latest!.refresh()
      await until(() => !!scanReply)
      await latest!.clear()
      scanReply!({ clusters: [cluster], screenshotCount: 0, rootPath: null })
      await pendingScan
      await until(() => latest?.status?.configured === false && latest?.scan === null)
      const pendingPick = latest!.pick()
      await until(() => !!pickReply)
      await latest!.clear()
      pickReply!()
      await pendingPick
      await until(() => latest?.status?.configured === false && latest?.scan === null)
      const revisionBeforePermissionChange = latest!.sourceRevision
      authorization = 'denied'
      changed!()
      await until(() => latest?.status?.authorization === 'denied')
      expect(latest?.sourceRevision).toBe(revisionBeforePermissionChange + 1)
    } finally {
      render(null, root as unknown as HTMLElement)
      globals.window = previous.window; globals.document = previous.document
      globals.requestAnimationFrame = previous.raf; globals.cancelAnimationFrame = previous.caf
    }
  })
  test('layout is intrinsic multi-column and preserves keyboard order and source geometry', () => {
    const css = readFileSync(new URL('../styles/event-clustering.css', import.meta.url), 'utf8')
    expect(css).toContain('repeat(auto-fit, minmax(min(100%, 16rem), 1fr))')
    expect(css).toContain('object-fit: contain')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('(hover: hover)')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).toContain('min-block-size: 2.75rem')
    expect(css).not.toMatch(/grid-auto-flow:\s*dense|\border\s*:|object-fit:\s*cover/)
  })
})
