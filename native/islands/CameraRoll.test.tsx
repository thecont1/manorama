import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { useState } from 'hono/jsx'
import { render } from 'hono/jsx/dom'
import { closeTopOverlay, overlayDepth, releaseAllOverlays } from '../../app/lib/overlay-stack'
import { createEventClustering, type EventClusteringBridge } from '../lib/event-clustering'
import type { EventCluster, RawDumpStatus } from '../../packages/core/event-clustering'
import CameraRoll, { CameraRollFolderAction, CameraRollPill } from './CameraRoll'
import GalleryList from './GalleryList'

const first: EventCluster = {
  id: 'evt_0123456789abcdef0123', startDate: new Date(2026, 2, 12).getTime(), endDate: new Date(2026, 2, 13).getTime(),
  isMultiDay: true, coverItemId: 'a', itemIds: ['a', 'b'],
  subDays: [{ id: '2026-03-12', date: new Date(2026, 2, 12).getTime(), itemIds: ['a'] }, { id: '2026-03-13', date: new Date(2026, 2, 13).getTime(), itemIds: ['b'] }],
}
const second: EventCluster = {
  id: 'evt_abcdef0123456789abcd', startDate: new Date(2026, 3, 1).getTime(), endDate: new Date(2026, 3, 1).getTime(),
  isMultiDay: false, coverItemId: 'c0', itemIds: Array.from({ length: 1201 }, (_, index) => `c${index}`), subDays: [],
}
const original = 'file:///private/container/tmp/event-originals/01234567-0123-0123-0123-012345678901/01234567-0123-0123-0123-012345678902.jpg'
const thumb = `file:///private/container/Library/Caches/event-thumbs/${'a'.repeat(64)}.jpg`
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
const fake = (patch: Partial<EventClusteringBridge> = {}) => {
  let configured = true
  let authorization: RawDumpStatus['authorization'] = 'authorized'
  let scans = 0
  let probes = 0
  const requests: Parameters<EventClusteringBridge['getEventAssetImage']>[0][] = []
  const released: string[] = []
  const cancelled: string[] = []
  const listeners = new Map<string, (value: unknown) => void>()
  const bridge: EventClusteringBridge = {
    getRawDumpStatus: async () => { probes++; return { configured, authorization, label: 'Camera Roll', isAvailable: authorization === 'authorized' || authorization === 'limited', lastIndexedAt: null, eventCount: 2, selectedPhotoCount: 1203, downloadCloudOnOpen: false } },
    scanRawDumpEvents: async () => { scans++; return { clusters: [first, second], screenshotCount: 0, rootPath: null } },
    pickRawDumpRoot: async () => { configured = true; listeners.get('eventLibraryChanged')?.({}); return { label: 'Camera Roll', itemCount: 1203, rootPath: null } },
    clearRawDumpRoot: async () => { configured = false; listeners.get('eventLibraryChanged')?.({}); return null },
    getEventAssetImage: async (request) => { requests.push(request); return { items: request.ids.map((id) => ({ id, url: request.purpose === 'thumbnail' ? thumb : original, width: 20, height: 10, state: 'ready' })) } },
    cancelEventAssetImage: async ({ ids }) => { cancelled.push(...ids); return null },
    releaseEventAssetImages: async ({ urls }) => { released.push(...urls); return null },
    setEventCloudDownload: async () => null, presentLimitedLibraryPicker: async () => null,
    openEventPhotosSettings: async () => null, openEventAssetInPhotos: async () => null,
    addListener: async (event, listener) => { listeners.set(event, listener); return { remove: async () => { if (listeners.get(event) === listener) listeners.delete(event) } } },
    ...patch,
  }
  return { client: createEventClustering(bridge, () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>'), requests, released, cancelled, listeners,
    get scans() { return scans }, get probes() { return probes },
    permission(value: RawDumpStatus['authorization']) { authorization = value; listeners.get('eventLibraryChanged')?.({}) },
    undeclare() { configured = false },
  }
}

const globals = globalThis as Record<string, unknown>
let dom: Window
let previous: Record<string, unknown>
let frames: FrameRequestCallback[] = []
let root: HTMLElement
const settle = async () => {
  for (let round = 0; round < 8; round++) {
    const queued = frames; frames = []
    for (const callback of queued) callback(performance.now())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2500
  while (!condition() && Date.now() < deadline) await settle()
  expect(condition()).toBe(true)
}
const button = (label: string | RegExp) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent?.trim() ?? ''))!
const escape = () => dom.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

beforeEach(() => {
  previous = Object.fromEntries(['window', 'document', 'MutationObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'fetch'].map((key) => [key, globals[key]]))
  dom = new Window({ url: 'http://localhost/', width: 375, height: 812 })
  globals.window = dom; globals.document = dom.document
  globals.MutationObserver = dom.MutationObserver; globals.IntersectionObserver = undefined
  globals.SVGElement = dom.SVGElement
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => { frames.push(callback); return frames.length }
  globals.cancelAnimationFrame = () => {}
  globals.fetch = async () => new Response('{}', { status: 404 })
  root = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.append(root as unknown as Parameters<typeof dom.document.body.append>[0])
})
afterEach(async () => {
  render(null, root)
  await settle()
  expect(overlayDepth()).toBe(0)
  releaseAllOverlays()
  for (const [key, value] of Object.entries(previous)) globals[key] = value
})

const mountMode = async (deps: ReturnType<typeof fake>, onClose = () => {}, onOpenSettings = () => {}) => {
  render(<CameraRoll client={deps.client} presentation={{ locale: 'en-GB', calendar: 'gregory' }} onClose={onClose} onOpenSettings={onOpenSettings} />, root)
  await until(() => !!root.querySelector('[data-camera-roll-mode]'))
}

describe('Camera Roll Library mode', () => {
  test('the normal Library contains no event contents and Settings owns only the folder action', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const storage = new Map([['capacitor-storage_manorama.session-token', 'test-token']])
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
    try {
      render(<GalleryList apiBase="http://api.test" />, root)
      await until(() => !!root.querySelector('[aria-label="Settings"]'))
      expect(root.querySelector('[data-library-mode]')?.getAttribute('data-library-mode')).toBe('galleries')
      expect(root.querySelector('[data-event-section]')).toBeNull()
      expect(root.querySelector('.event-card')).toBeNull()
      expect(root.textContent).not.toContain('Camera Roll')
      ;(root.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click()
      await until(() => !!root.querySelector('[data-screen="settings"]'))
      expect(root.querySelector('[data-screen="settings"]')!.textContent).not.toContain('Re-index')
      expect(root.textContent).not.toContain('Download iCloud photos')
      const source = readFileSync(new URL('./GalleryList.tsx', import.meta.url), 'utf8')
      expect(source).toContain('<CameraRollPill')
      expect(source).toContain('<CameraRoll ')
      expect(source).toContain("navRef.current.screen.kind === 'library'")
      expect(source).not.toMatch(/useEventClustering|EventSection|EventViewer|enterEvent|eventOpen/)
      const settings = readFileSync(new URL('./Settings.tsx', import.meta.url), 'utf8')
      expect(settings.match(/<CameraRollFolderAction\s*\/>/g)).toHaveLength(1)
    } finally {
      render(null, root); await settle()
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else delete globals.localStorage
    }
  })

  test('Settings chooses one folder with a cheap probe and never scans or loads previews', async () => {
    const deps = fake()
    deps.undeclare()
    render(<CameraRollFolderAction client={deps.client} />, root)
    await until(() => !!button(/Camera Roll folder/))
    await settle()
    expect(deps.probes).toBe(2)
    expect(deps.scans).toBe(0)
    expect(deps.requests).toHaveLength(0)
    expect(root.querySelectorAll('button')).toHaveLength(1)
    expect(root.textContent).not.toMatch(/events|photographs|iCloud|Re-index/)
    button(/Camera Roll folder/).click()
    await until(() => !!button(/Clear Camera Roll folder/))
    expect(deps.scans).toBe(0)
    expect(deps.requests).toHaveLength(0)
    expect(root.textContent).toContain('Camera Roll')
  })

  test('unsupported and plain web folder actions stay absent', async () => {
    render(<CameraRollFolderAction client={fake({ getRawDumpStatus: async () => null }).client} />, root)
    await settle()
    expect(root.textContent).toBe('')
    render(<CameraRollFolderAction />, root)
    await settle()
    expect(root.querySelector('button')).toBeNull()
    expect(overlayDepth()).toBe(0)
  })

  test('the supported pill activates Camera Roll without scanning', async () => {
    const deps = fake()
    let trigger: HTMLElement | null = null
    function PillFixture() {
      const [selected, setSelected] = useState(false)
      return <CameraRollPill client={deps.client} active={selected} onActivate={(next) => { trigger = next; setSelected((value) => !value) }} />
    }
    render(<PillFixture />, root)
    await until(() => !!button('Camera Roll'))
    expect(button('Camera Roll').getAttribute('aria-pressed')).toBe('false')
    button('Camera Roll').click()
    await until(() => button('Camera Roll').getAttribute('aria-pressed') === 'true')
    expect(trigger).toBe(button('Camera Roll'))
    expect(deps.scans).toBe(0)
    expect(deps.requests).toHaveLength(0)
  })

  test('an unconfigured mode asks Settings for a folder and performs no scan', async () => {
    const deps = fake()
    deps.undeclare()
    let opened = false
    await mountMode(deps, () => {}, () => { opened = true })
    await until(() => !!button('Choose folder'))
    expect(deps.scans).toBe(0)
    expect(deps.requests).toHaveLength(0)
    button('Choose folder').click()
    expect(opened).toBe(true)
    expect(overlayDepth()).toBe(0)
  })

  test('opening the mode scans once, lists every event, and the viewer returns to its card', async () => {
    const deps = fake()
    let closed = false
    await mountMode(deps, () => { closed = true })
    await until(() => root.querySelectorAll('.event-card').length === 2)
    expect(deps.scans).toBe(1)
    expect(overlayDepth()).toBe(0)
    expect(root.textContent).toContain('12 – 13 Mar 2026')
    expect(root.textContent).toContain('2 photographs')
    expect(root.textContent).toContain('1 Apr 2026')
    expect(root.textContent).toContain('1,201 photographs')
    expect(root.querySelectorAll('.event-card img')).toHaveLength(2)
    expect(deps.requests.every((item) => item.purpose === 'thumbnail' && item.allowNetwork === false)).toBe(true)
    const day = button('13 Mar')
    day.click()
    await until(() => !!root.querySelector('.event-viewer') && deps.requests.some((item) => item.purpose === 'viewer'))
    expect(overlayDepth()).toBe(1)
    expect(deps.requests.filter((item) => item.purpose === 'viewer').map((item) => item.ids)).toEqual([['b']])
    expect(root.querySelector('[aria-label="Back to Camera Roll"]')).not.toBeNull()
    ;(root.querySelector('[aria-label="Back to Camera Roll"]') as HTMLButtonElement).click()
    await settle()
    expect(root.querySelector('.event-viewer')).toBeNull()
    expect(root.querySelectorAll('.event-card')).toHaveLength(2)
    expect(dom.document.activeElement).toBe(day as unknown as typeof dom.document.activeElement)
    expect(deps.released).toContain(original)
    expect(deps.scans).toBe(1)
    ;(root.querySelector('[aria-label="Back to galleries"]') as HTMLButtonElement).click()
    expect(closed).toBe(true)
  })

  test('picker and event viewer unwind without leaving the mode', async () => {
    const deps = fake()
    await mountMode(deps)
    await until(() => !!button('13 Mar'))
    button('13 Mar').click()
    await until(() => !!root.querySelector('.event-viewer'))
    const curtain = root.querySelector<HTMLElement>('.event-viewer [data-curtain]')!
    curtain.click()
    const transition = new dom.Event('transitionend')
    Object.defineProperty(transition, 'propertyName', { value: 'opacity' })
    curtain.dispatchEvent(transition as unknown as Event)
    await until(() => !!root.querySelector('.event-viewer [data-chrome-position]'))
    ;(root.querySelector<HTMLButtonElement>('.event-viewer [data-chrome-position]')!).click()
    await until(() => !!root.querySelector('.event-picker'))
    expect(overlayDepth()).toBe(2)
    expect(root.querySelectorAll('.event-picker-grid button')).toHaveLength(2)
    closeTopOverlay(); await settle()
    expect(root.querySelector('.event-picker')).toBeNull()
    expect(root.querySelector('.event-viewer')).not.toBeNull()
    expect(overlayDepth()).toBe(1)
    escape(); await settle()
    expect(root.querySelector('.event-viewer')).toBeNull()
    expect(root.querySelectorAll('.event-card')).toHaveLength(2)
    expect(dom.document.activeElement).toBe(button('13 Mar') as unknown as typeof dom.document.activeElement)
  })

  test('a permission revision closes a stale viewer, cancels its original and releases a late reply', async () => {
    const pending = deferred<Awaited<ReturnType<EventClusteringBridge['getEventAssetImage']>>>()
    const deps = fake({ getEventAssetImage: async (request) => request.purpose === 'viewer' ? pending.promise : { items: request.ids.map((id) => ({ id, url: thumb, width: 20, height: 10, state: 'ready' })) } })
    await mountMode(deps)
    await until(() => !!button('12 Mar'))
    button('12 Mar').click()
    await until(() => !!root.querySelector('.event-viewer'))
    deps.permission('denied')
    await until(() => !root.querySelector('.event-viewer') && deps.cancelled.includes('a'))
    pending.resolve({ items: [{ id: 'a', url: original, width: 20, height: 10, state: 'ready' }] })
    await until(() => deps.released.includes(original))
    expect(root.textContent).toContain('Camera Roll is unavailable')
    expect(root.querySelector('.event-card')).toBeNull()
    expect(overlayDepth()).toBe(0)
    deps.permission('authorized')
    await until(() => !!root.querySelector('.event-card'))
    expect(root.querySelector('.event-viewer')).toBeNull()
  })

  test('clearing the folder removes the event list without touching a gallery catalogue', async () => {
    const deps = fake()
    function Fixture() {
      return <><CameraRollFolderAction client={deps.client} /><CameraRoll client={deps.client} onClose={() => {}} onOpenSettings={() => {}} /></>
    }
    render(<Fixture />, root)
    await until(() => root.querySelectorAll('.event-card').length === 2)
    button(/Clear Camera Roll folder/).click()
    await until(() => !!button('Choose folder'))
    expect(root.querySelector('.event-card')).toBeNull()
    expect(root.querySelector('.event-viewer')).toBeNull()
    expect(deps.scans).toBe(1)
    expect(overlayDepth()).toBe(0)
  })
})
