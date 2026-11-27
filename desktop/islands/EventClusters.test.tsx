import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { useState } from 'hono/jsx'
import { render } from 'hono/jsx/dom'
import { overlayDepth, releaseAllOverlays } from '../../app/lib/overlay-stack'
import type { EventAssetRequest, EventCluster, RawDumpStatus } from '../../packages/core/event-clustering'
import { createEventClustering, type RawDumpBridge } from '../lib/event-clustering'
import CameraRoll, { CameraRollFolderAction, CameraRollPill } from './EventClusters'
import { eventViewerImages } from './EventViewer'

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
const lease = 'manorama-event://localhost/0123456789abcdef0123456789abcdef'

const first: EventCluster = {
  id: 'evt_0123456789abcdef0123',
  startDate: at(2026, 3, 12, 9),
  endDate: at(2026, 3, 13, 21),
  isMultiDay: true,
  coverItemId: '2026/03/a.jpg',
  itemIds: ['2026/03/a.jpg', '2026/03/b.jpg'],
  subDays: [
    { id: '2026-03-12', date: at(2026, 3, 12, 9), itemIds: ['2026/03/a.jpg'] },
    { id: '2026-03-13', date: at(2026, 3, 13, 10), itemIds: ['2026/03/b.jpg'] },
  ],
}

const second: EventCluster = {
  id: 'evt_abcdef0123456789abcd',
  startDate: at(2026, 4, 1, 8),
  endDate: at(2026, 4, 1, 20),
  isMultiDay: false,
  coverItemId: '2026/04/c.jpg',
  itemIds: ['2026/04/c.jpg'],
  subDays: [],
}

const statusFor = (configured: boolean, isAvailable = true): RawDumpStatus => ({
  configured,
  label: configured ? 'Photos Backup' : null,
  isAvailable: configured && isAvailable,
  lastIndexedAt: configured ? at(2026, 11, 22, 9) : null,
  eventCount: configured ? 2 : 0,
})

type Call = { command: string; args: Record<string, unknown> | undefined }
type FakeOptions = {
  configured?: boolean
  available?: boolean
  scan?: EventCluster[]
  asset?: (request: EventAssetRequest) => Promise<unknown>
}

const fake = (options: FakeOptions = {}) => {
  let configured = options.configured ?? true
  let available = options.available ?? true
  const calls: Call[] = []
  const listeners = new Set<(payload: unknown) => void>()
  const bridge: RawDumpBridge = {
    invoke: async (command, args) => {
      calls.push({ command, args })
      if (command === 'get_raw_dump_status') return statusFor(configured, available)
      if (command === 'pick_raw_dump_root') {
        configured = true
        available = true
        return { label: 'Photos Backup', itemCount: 3, rootPath: '/Users/example/Photos Backup' }
      }
      if (command === 'clear_raw_dump_root') { configured = false; return null }
      if (command === 'scan_raw_dump_events') {
        return { clusters: options.scan ?? [first, second], screenshotCount: 0, rootPath: '/Users/example/Photos Backup' }
      }
      if (command === 'get_event_asset_image') {
        if (options.asset) return options.asset(args as unknown as EventAssetRequest)
        const request = args as unknown as EventAssetRequest
        return { items: request.ids.map((id) => ({
          id,
          url: lease,
          width: 4032,
          height: 3024,
          state: 'ready',
        })) }
      }
      if (command === 'reveal_event_asset') return null
      return null
    },
    listen: async (_event, handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  return {
    client: createEventClustering(bridge),
    calls,
    commands: () => calls.map((call) => call.command),
    emitChanged: () => { for (const listener of listeners) listener({}) },
    configure(value: boolean) { configured = value },
    availability(value: boolean) { available = value },
  }
}

const globals = globalThis as Record<string, unknown>
let dom: Window
let root: HTMLElement
let previous: Record<string, unknown>
let frames: FrameRequestCallback[] = []

const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    const queued = frames
    frames = []
    for (const callback of queued) callback(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const until = async (condition: () => boolean) => {
  for (let round = 0; round < 30 && !condition(); round += 1) await settle()
  expect(condition()).toBe(true)
}

const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button')]
const button = (text: string) => buttons().find((item) => item.textContent?.trim() === text)
const labelledButton = (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const row = (label: string) => [...root.querySelectorAll<HTMLElement>('.m-actionrow-label')]
  .find((item) => item.textContent === label)
  ?.closest<HTMLElement>('.m-actionrow')
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  ;(element as HTMLElement).dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
}

beforeEach(() => {
  previous = Object.fromEntries([
    'window', 'document', 'MutationObserver', 'IntersectionObserver', 'requestAnimationFrame',
    'cancelAnimationFrame', 'getComputedStyle', 'HTMLElement', 'SVGElement', 'fetch',
  ].map((key) => [key, globals[key]]))
  dom = new Window({ url: 'http://localhost/', width: 1280, height: 840 })
  Object.defineProperty(dom, 'devicePixelRatio', { configurable: true, value: 2 })
  globals.window = dom
  globals.document = dom.document
  globals.MutationObserver = dom.MutationObserver
  globals.IntersectionObserver = undefined
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => { frames.push(callback); return frames.length }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.HTMLElement = dom.HTMLElement
  globals.SVGElement = dom.SVGElement
  globals.fetch = async () => new Response('{}', { status: 404 })
  root = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(root as unknown as Parameters<typeof dom.document.body.appendChild>[0])
})

afterEach(async () => {
  render(null, root)
  await settle()
  releaseAllOverlays()
  expect(overlayDepth()).toBe(0)
  for (const [key, value] of Object.entries(previous)) globals[key] = value
})

const mountMode = async (deps: ReturnType<typeof fake>, props: Partial<Parameters<typeof CameraRoll>[0]> = {}) => {
  render(<CameraRoll client={deps.client} native onClose={() => {}} onOpenSettings={() => {}} {...props} />, root)
  await until(() => !!root.querySelector('[data-camera-roll-mode]'))
}

describe('Camera Roll controls', () => {
  test('the pill performs only the cheap capability probe', async () => {
    const deps = fake()
    let trigger: HTMLElement | null = null
    function Fixture() {
      const [active, setActive] = useState(false)
      return <CameraRollPill client={deps.client} native active={active} onActivate={(next) => { trigger = next; setActive((value) => !value) }} />
    }
    render(<Fixture />, root)
    await until(() => !!button('Camera Roll'))
    expect(deps.commands()).toEqual(['get_raw_dump_status'])
    expect(button('Camera Roll')?.getAttribute('aria-pressed')).toBe('false')
    click(button('Camera Roll'))
    await until(() => button('Camera Roll')?.getAttribute('aria-pressed') === 'true')
    expect(trigger).toBe(button('Camera Roll'))
    expect(deps.commands()).toEqual(['get_raw_dump_status'])
  })

  test('unsupported shells and plain web render no Camera Roll control', async () => {
    render(<CameraRollPill client={fake().client} native={false} active={false} onActivate={() => {}} />, root)
    render(<CameraRollFolderAction client={fake().client} native={false} />, root)
    await settle()
    expect(root.innerHTML).toBe('')
  })

  test('Settings chooses and clears one folder without scanning or loading previews', async () => {
    const deps = fake({ configured: false })
    const changed: number[] = []
    render(<CameraRollFolderAction client={deps.client} native onDeclarationChanged={() => changed.push(changed.length)} />, root)
    await until(() => !!row('Folder'))
    expect(row('Folder')?.textContent).toContain('Choose folder')
    expect(root.textContent).not.toMatch(/Re-index|events|photographs/i)
    click(row('Folder'))
    await until(() => !!row('Clear folder'))
    expect(deps.commands()).toEqual(['get_raw_dump_status', 'pick_raw_dump_root', 'get_raw_dump_status'])
    expect(changed).toHaveLength(1)
    click(row('Clear folder'))
    await until(() => !!row('Folder') && !row('Clear folder'))
    expect(deps.commands()).toEqual([
      'get_raw_dump_status', 'pick_raw_dump_root', 'get_raw_dump_status',
      'clear_raw_dump_root', 'get_raw_dump_status',
    ])
    expect(changed).toHaveLength(2)
    expect(deps.commands()).not.toContain('scan_raw_dump_events')
    expect(deps.commands()).not.toContain('get_event_asset_image')
  })

  test('an unconfigured mode asks Settings for a folder and never scans', async () => {
    const deps = fake({ configured: false })
    let opened = false
    await mountMode(deps, { onOpenSettings: () => { opened = true } })
    await until(() => !!button('Choose folder'))
    click(button('Choose folder'))
    expect(opened).toBe(true)
    expect(deps.commands()).toEqual(['get_raw_dump_status'])
  })
})

describe('Camera Roll rail', () => {
  test('activation replaces gallery contents and closing restores them', async () => {
    const deps = fake()
    function Fixture() {
      const [active, setActive] = useState(false)
      return <>
        <CameraRollPill client={deps.client} native active={active} onActivate={() => setActive((value) => !value)} />
        <section data-test-rail>{active
          ? <CameraRoll client={deps.client} native onClose={() => setActive(false)} onOpenSettings={() => {}} />
          : <div data-gallery-list>Cloud galleries</div>}</section>
      </>
    }
    render(<Fixture />, root)
    await until(() => !!button('Camera Roll'))
    expect(root.querySelector('[data-gallery-list]')).not.toBeNull()
    expect(deps.commands()).toEqual(['get_raw_dump_status'])
    click(button('Camera Roll'))
    await until(() => root.querySelectorAll('.event-card').length === 2)
    expect(root.querySelector('[data-gallery-list]')).toBeNull()
    expect(deps.commands().filter((command) => command === 'scan_raw_dump_events')).toHaveLength(1)
    click(labelledButton('Back to galleries'))
    await until(() => !!root.querySelector('[data-gallery-list]'))
    expect(root.querySelector('.event-card')).toBeNull()
  })

  test('localized event lists retain list, group and combined accessible names', async () => {
    const deps = fake()
    await mountMode(deps, { presentation: {
      locale: 'de-DE', calendar: 'gregory',
      messages: {
        photographCount: { one: '{count} Foto', other: '{count} Fotos' }, multiDay: 'Mehrtägig',
        daysIn: 'Tage in {date}', eventDay: '{day} ({event})',
      },
    } })
    await until(() => root.querySelectorAll('.event-card img').length === 2)
    expect(root.querySelector('.event-grid')?.getAttribute('role')).toBe('list')
    expect(root.textContent).toContain('2 Fotos')
    expect(root.textContent).toContain('Mehrtägig')
    expect(root.querySelector('.event-days')?.getAttribute('aria-label')).toMatch(/^Tage in 12\.\s*–\s*13\. März 2026$/)
    expect(root.querySelector('[data-event-day="2026-03-12"]')?.getAttribute('aria-label')).toMatch(/^12\. März \(12\.\s*–\s*13\. März 2026\)$/)
    expect(root.querySelector('.event-card-open')?.getAttribute('aria-label')).toMatch(/^12\.\s*–\s*13\. März 2026, 2 Fotos und Mehrtägig$/)
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toContain('overflow-wrap: anywhere')
  })

  test('event covers are lazy, intrinsic and use only native-returned URLs', async () => {
    const deps = fake()
    await mountMode(deps)
    await until(() => root.querySelectorAll('.event-card img').length === 2)
    const image = root.querySelector<HTMLImageElement>('.event-card img')!
    expect(image.getAttribute('src')).toBe(lease)
    expect(image.getAttribute('srcset')).toBeNull()
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.width).toBe(4032)
    expect(image.height).toBe(3024)
    expect(image.style.maxInlineSize).toBe('min(100%, 2016px)')
    expect(image.style.maxBlockSize).toBe('min(100%, 1512px)')
    const requests = deps.calls.filter((call) => call.command === 'get_event_asset_image')
    expect(requests.every((call) => call.args?.purpose === 'thumbnail' && call.args?.allowNetwork === false)).toBe(true)
    expect(requests.every((call) => !String(call.args?.ids).includes('/Users/example'))).toBe(true)
  })

  test('ready covers adopt intrinsic ratios and small images are never upscaled', async () => {
    const dimensions: Record<string, { width: number; height: number }> = {
      '2026/03/a.jpg': { width: 1200, height: 1800 },
      '2026/04/c.jpg': { width: 64, height: 64 },
    }
    const deps = fake({ asset: async (request) => ({ items: request.ids.map((id) => ({
      id,
      url: lease,
      ...dimensions[id],
      state: 'ready',
    })) }) })
    await mountMode(deps)
    await until(() => root.querySelectorAll('.event-card img').length === 2)
    const portrait = root.querySelector<HTMLImageElement>('.event-card img')!
    const square = root.querySelectorAll<HTMLImageElement>('.event-card img')[1]
    const portraitFrame = portrait.closest<HTMLElement>('.event-card-cover')!
    const squareFrame = square.closest<HTMLElement>('.event-card-cover')!
    expect(portraitFrame.style.aspectRatio).toBe('1200 / 1800')
    expect(squareFrame.style.aspectRatio).toBe('64 / 64')
    expect(portraitFrame.style.maxInlineSize).toBe('min(100%, 600px, calc(var(--event-cover-max-block) * 0.6666666666666666))')
    expect(squareFrame.style.maxInlineSize).toBe('min(100%, 32px, calc(var(--event-cover-max-block) * 1))')
    expect(portrait.style.maxInlineSize).toBe('min(100%, 600px)')
    expect(portrait.style.maxBlockSize).toBe('min(100%, 900px)')
    expect(square.style.maxInlineSize).toBe('min(100%, 32px)')
    expect(square.style.maxBlockSize).toBe('min(100%, 32px)')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    const coverRule = css.match(/\.event-card-cover \{([^}]*)\}/)?.[1]
    expect(coverRule).toBeDefined()
    expect(coverRule).not.toContain('overflow: hidden')
    expect(coverRule).not.toContain('border-radius')
  })

  test('repeated request cancellation retries the cover instead of reporting a failure', async () => {
    let attempts = 0
    const deps = fake({ asset: async (request) => {
      attempts += 1
      if (attempts <= 2) throw new Error('Event photograph request cancelled')
      return { items: request.ids.map((id) => ({
        id,
        url: lease,
        width: 4032,
        height: 3024,
        state: 'ready',
      })) }
    } })
    await mountMode(deps)
    await until(() => root.querySelectorAll('.event-card img').length === 2)
    expect(attempts).toBe(6)
    expect(root.textContent).not.toContain('Preview unavailable')
  })

  test('persistent request cancellation stops after a bounded number of attempts', async () => {
    let attempts = 0
    const deps = fake({ asset: async () => {
      attempts += 1
      throw new Error('Event photograph request cancelled')
    } })
    await mountMode(deps)
    await until(() => root.textContent?.includes('Preview unavailable') === true)
    expect(attempts).toBe(6)
    await settle()
    expect(attempts).toBe(6)
  })

  test('a day opens the shared viewer at its first frame and returns focus without rescanning', async () => {
    const deps = fake()
    const host: { open: boolean; close: (() => void) | null; positions: { index: number; total: number }[] } = { open: false, close: null, positions: [] }
    await mountMode(deps, {
      onViewerOpenChange: (open, close) => { host.open = open; host.close = close ?? null },
      onPositionChange: (position) => host.positions.push(position),
    })
    await until(() => !!root.querySelector('[data-event-day="2026-03-13"]'))
    const day = root.querySelector<HTMLButtonElement>('[data-event-day="2026-03-13"]')!
    click(day)
    await until(() => !!root.querySelector('.event-viewer'))
    expect(host.open).toBe(true)
    expect(typeof host.close).toBe('function')
    expect(deps.calls.filter((call) => call.command === 'get_event_asset_image' && call.args?.purpose === 'viewer').map((call) => call.args?.ids)).toEqual([['2026/03/b.jpg']])
    expect(root.querySelector('.event-viewer [data-curtain]')).toBeNull()
    expect(host.positions.at(-1)).toEqual({ index: 1, total: 2 })
    click(labelledButton('Back to Camera Roll'))
    await until(() => !root.querySelector('.event-viewer'))
    expect(host.open).toBe(false)
    expect(host.close).toBeNull()
    expect(dom.document.activeElement).toBe(day)
    expect(deps.commands().filter((command) => command === 'scan_raw_dump_events')).toHaveLength(1)
  })

  test('cloud-only photographs expose reveal, never an implicit download', async () => {
    const deps = fake({ asset: async (request) => ({ items: request.ids.map((id) => ({
      id,
      url: request.purpose === 'thumbnail' ? lease : null,
      width: request.purpose === 'thumbnail' ? 4032 : 0,
      height: request.purpose === 'thumbnail' ? 3024 : 0,
      state: request.purpose === 'thumbnail' ? 'ready' : 'cloudOnly',
    })) }) })
    await mountMode(deps)
    await until(() => !!root.querySelector('.event-card-open'))
    click(root.querySelector('.event-card-open'))
    await until(() => !!root.querySelector('[data-event-placeholder]'))
    expect(root.textContent).toContain('Not downloaded')
    expect(root.textContent).not.toMatch(/Download this photo|Download photo/i)
    const assetCalls = deps.calls.filter((call) => call.command === 'get_event_asset_image')
    expect(assetCalls.every((call) => call.args?.allowNetwork === false)).toBe(true)
    click(button('Reveal in folder'))
    await until(() => deps.commands().includes('reveal_event_asset'))
    expect(deps.calls.find((call) => call.command === 'reveal_event_asset')?.args).toEqual({ id: '2026/03/a.jpg' })
  })

  test('a source revision closes a stale viewer and offers a re-scan', async () => {
    const deps = fake()
    await mountMode(deps)
    await until(() => !!root.querySelector('.event-card-open'))
    click(root.querySelector('.event-card-open'))
    await until(() => !!root.querySelector('.event-viewer'))
    deps.emitChanged()
    await until(() => !root.querySelector('.event-viewer') && !!button('Re-scan'))
    expect(root.textContent).toContain('Folder changed since this was indexed')
    expect(overlayDepth()).toBe(0)
    click(button('Re-scan'))
    await until(() => !button('Re-scan'))
    expect(deps.commands().filter((command) => command === 'scan_raw_dump_events')).toHaveLength(2)
  })

  test('the event picker is a wrapping matrix with the active photograph marked', async () => {
    const deps = fake()
    await mountMode(deps)
    await until(() => !!root.querySelector('.event-card-open'))
    click(root.querySelector('.event-card-open'))
    await until(() => !!root.querySelector<HTMLButtonElement>('.event-viewer [data-chrome-position]'))
    click(root.querySelector('.event-viewer [data-chrome-position]'))
    await until(() => !!root.querySelector('.event-picker'))
    expect(root.querySelectorAll('.event-picker-grid button')).toHaveLength(2)
    expect(root.querySelector('.event-picker-grid button[aria-current="true"]')?.getAttribute('aria-label')).toBe('Open photograph')
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.event-picker-grid \{[\s\S]*?gap: 0;/)
    expect(css).toMatch(/\.event-picker-grid button \{[\s\S]*?block-size: 18dvh;/)
  })
})

describe('event viewer contract and host wiring', () => {
  test('unavailable members remain truthful vector blanks until native replies', () => {
    const images = eventViewerImages(first, {
      '2026/03/a.jpg': { id: '2026/03/a.jpg', url: null, src: null, width: 0, height: 0, state: 'cloudOnly' },
      '2026/03/b.jpg': { id: '2026/03/b.jpg', url: lease, src: lease, width: 4032, height: 3024, state: 'ready' },
    })
    expect(images[0]).toMatchObject({ src: eventViewerImages(first, {})[0].src, width: 1, height: 1, fidelity: 'unknown' })
    expect(images[0].src).toMatch(/^data:image\/svg\+xml/)
    expect(images[1]).toMatchObject({ src: lease, width: 4032, height: 3024, fidelity: 'original' })
  })

  test('Catalogue mounts the controller only in Camera Roll mode and Settings owns one folder action', () => {
    const source = readFileSync(new URL('./Catalogue.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<CameraRollPill')
    expect(source).toContain('cameraRollOpen && !settingsOpen && !settingsClosing')
    expect(source.match(/<CameraRollFolderAction\s*\/>/g)).toHaveLength(1)
    expect(source).toContain('onViewerOpenChange={handleEventViewerOpenChange}')
    expect(source).not.toMatch(/eventGalleryRecord|RawDumpSettings|EventOpenTarget|useEventClustering/)
  })
})
