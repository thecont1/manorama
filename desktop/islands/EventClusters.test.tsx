import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { unmountTracker } from '../../test/unmount'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import EventClusters, { RawDumpSettings, type EventOpenTarget } from './EventClusters'
import type { RawDumpBridge } from '../lib/event-clustering'

/**
 * Both Raw Dump surfaces are exercised through mounted islands, because the
 * interesting behaviour is in the effects: what the section asks the shell on
 * mount, what it refuses to ask when the shell has no answer, and what it
 * offers once the dump moves underneath it. The bridge is the injected stub —
 * the same seam `desktop/lib/event-clustering.test.ts` drives — so no
 * `@tauri-apps` runtime is involved, and the asset URL is stubbed to keep the
 * asserted path readable.
 */

const globals = globalThis as Record<string, unknown>

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
/** Drain effects, microtask state flushes and any promise they resolve. */
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const ROOT = '/Users/home/Library/CloudStorage/Backups/Photos Backup'

const at = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour, 0, 0, 0).getTime()

const singleDayCluster = {
  id: 'evt_aaaaaaaaaaaaaaaaaaaa',
  startDate: at(2026, 3, 12, 9),
  endDate: at(2026, 3, 12, 21),
  isMultiDay: false,
  coverItemId: '2026/03/IMG_4821.jpg',
  itemIds: ['2026/03/IMG_4821.jpg', '2026/03/IMG_4822.jpg', '2026/03/IMG_4823.jpg'],
}

const tripCluster = {
  id: 'evt_bbbbbbbbbbbbbbbbbbbb',
  startDate: at(2026, 6, 1, 8),
  endDate: at(2026, 6, 3, 22),
  isMultiDay: true,
  coverItemId: '2026/06/IMG_5001.jpg',
  itemIds: ['2026/06/IMG_5001.jpg', '2026/06/IMG_5002.jpg', '2026/06/IMG_5003.jpg', '2026/06/IMG_5004.jpg'],
  subDays: [
    { id: '2026-06-01', date: at(2026, 6, 1, 8), itemIds: ['2026/06/IMG_5001.jpg'] },
    { id: '2026-06-02', date: at(2026, 6, 2, 10), itemIds: ['2026/06/IMG_5002.jpg', '2026/06/IMG_5003.jpg'] },
    { id: '2026-06-03', date: at(2026, 6, 3, 9), itemIds: ['2026/06/IMG_5004.jpg'] },
  ],
}

const statusFor = (overrides: Record<string, unknown> = {}) => ({
  configured: true,
  label: 'Photos Backup',
  isAvailable: true,
  lastIndexedAt: at(2026, 11, 22, 9),
  eventCount: 2,
  ...overrides,
})

type Stub = {
  bridge: RawDumpBridge
  commands: () => string[]
  emitChanged: () => void
}

/** `answers` maps a command to a reply, or to an Error to reject with. */
const stub = (answers: Record<string, unknown> = {}): Stub => {
  const calls: string[] = []
  const handlers = new Set<(payload: unknown) => void>()
  return {
    commands: () => [...calls],
    emitChanged: () => {
      for (const handler of handlers) handler({})
    },
    bridge: {
      invoke: async (command) => {
        calls.push(command)
        const answer = answers[command]
        if (answer instanceof Error) throw answer
        return answer ?? null
      },
      listen: async (_event, handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    },
  }
}

const mounts = unmountTracker()

const srcFor = (path: string) => `asset://localhost/${path}`

type SectionProps = Parameters<typeof EventClusters>[0]
type SettingsProps = Parameters<typeof RawDumpSettings>[0]

const mountSection = (overrides: Partial<SectionProps> = {}) => {
  const opened: EventOpenTarget[] = []
  const props: SectionProps = {
    native: true,
    bridge: stub().bridge,
    srcFor,
    onOpenEvent: (target) => opened.push(target),
    ...overrides,
  }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  mounts.mount(<EventClusters {...props} />, container)
  return { container, opened }
}

const mountSettings = (overrides: Partial<SettingsProps> = {}) => {
  const changed: number[] = []
  const props: SettingsProps = {
    native: true,
    bridge: stub().bridge,
    onDeclarationChanged: () => changed.push(changed.length),
    ...overrides,
  }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  mounts.mount(<RawDumpSettings {...props} />, container)
  return { container, changed }
}

const byText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)

/** An action row's clickable element, found by its visible label. */
const row = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('.m-actionrow-label')]
    .find((element) => element.textContent === label)
    ?.closest<HTMLElement>('.m-actionrow')

const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy()
  ;(element as HTMLElement).dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event)
}

let dom: Window
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown
let previousHTMLElement: unknown
let previousMutationObserver: unknown

beforeAll(() => {
  dom = new Window({ width: 1280, height: 840, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  previousHTMLElement = globals.HTMLElement
  previousMutationObserver = globals.MutationObserver
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    nextFrameId += 1
    frames.push({ id: nextFrameId, callback })
    return nextFrameId
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id)
  }) as unknown as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
  globals.getComputedStyle = previousGetComputedStyle
  globals.HTMLElement = previousHTMLElement
  globals.MutationObserver = previousMutationObserver
})

afterEach(() => {
  releaseAllOverlays()
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
  frames = []
})

describe('EventClusters — visibility', () => {
  test('an undeclared dump leaves the Library exactly as it was', async () => {
    const shell = stub({ get_raw_dump_status: { configured: false } })
    const { container } = mountSection({ bridge: shell.bridge })
    await settle()
    expect(container.innerHTML).toBe('')
    // Not even a probe at the timeline: the contract forbids the scan.
    expect(shell.commands()).toEqual(['get_raw_dump_status'])
  })

  test('a shell with no raw-dump commands shows nothing at all', async () => {
    // An older build answers no object; that is not a user with a folder to
    // declare, and invariant 7 says we do not show them an empty promise.
    const { container } = mountSection({ bridge: stub().bridge })
    await settle()
    expect(container.innerHTML).toBe('')
  })

  test('the plain web runtime shows no control it cannot persist', async () => {
    const shell = stub({
      get_raw_dump_status: statusFor(),
      scan_raw_dump_events: { clusters: [singleDayCluster], screenshotCount: 0, rootPath: ROOT },
    })
    const { container } = mountSection({ native: false, bridge: shell.bridge })
    await settle()
    expect(container.innerHTML).toBe('')
    expect(shell.commands()).toEqual([])
  })

  test('a declared dump with nothing in it says so in one quiet line', async () => {
    const shell = stub({
      get_raw_dump_status: statusFor({ eventCount: 0 }),
      scan_raw_dump_events: { clusters: [], screenshotCount: 12, rootPath: ROOT },
    })
    const { container } = mountSection({ bridge: shell.bridge })
    await settle()
    expect(container.textContent).toContain('No events in Photos Backup yet')
    expect(container.querySelector('.lib-compact-card')).toBeNull()
  })
})

describe('EventClusters — the cards', () => {
  const readyShell = () =>
    stub({
      get_raw_dump_status: statusFor(),
      scan_raw_dump_events: {
        clusters: [singleDayCluster, tripCluster],
        screenshotCount: 611,
        rootPath: ROOT,
      },
    })

  test('one card per event, titled by its span and counted by its frames', async () => {
    const { container } = mountSection({ bridge: readyShell().bridge })
    await settle()
    const cards = [...container.querySelectorAll('[data-event-card]')]
    expect(cards.map((card) => card.getAttribute('data-event-card'))).toEqual([
      singleDayCluster.id,
      tripCluster.id,
    ])
    expect(cards[0].textContent).toContain('12 Mar 2026')
    expect(cards[0].textContent).toContain('3 photographs')
    expect(cards[1].textContent).toContain('1–3 Jun 2026')
    expect(cards[1].textContent).toContain('4 photographs')
  })

  test('the multi-day badge is on the trip and not on the single day', async () => {
    const { container } = mountSection({ bridge: readyShell().bridge })
    await settle()
    const single = container.querySelector(`[data-event-card="${singleDayCluster.id}"]`)
    const trip = container.querySelector(`[data-event-card="${tripCluster.id}"]`)
    expect(single?.querySelector('[data-event-multiday]')).toBeNull()
    expect(trip?.querySelector('[data-event-multiday]')?.textContent).toBe('3 days')
  })

  test('a cover is asked for at its own path, with no resize in it', async () => {
    const { container } = mountSection({ bridge: readyShell().bridge })
    await settle()
    const img = container.querySelector<HTMLImageElement>('img')
    // The joined dump path, handed to the asset protocol unchanged: nothing
    // here may request a rendition, a crop or a re-encode.
    expect(img?.getAttribute('src')).toBe(srcFor(`${ROOT}/2026/03/IMG_4821.jpg`))
    expect(img?.getAttribute('srcset')).toBeNull()
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  test('a multi-day card carries one line per day, in the order they happened', async () => {
    const { container } = mountSection({ bridge: readyShell().bridge })
    await settle()
    const trip = container.querySelector(`[data-event-card="${tripCluster.id}"]`)
    const group = trip?.querySelector('[role="group"]')
    expect(group?.getAttribute('aria-label')).toBe('Days in 1–3 Jun 2026')
    const days = [...(group?.querySelectorAll('[data-event-day]') ?? [])]
    expect(days.map((day) => day.textContent)).toEqual(['1 Jun', '2 Jun', '3 Jun'])
    expect(days.map((day) => day.getAttribute('data-event-day'))).toEqual(['2026-06-01', '2026-06-02', '2026-06-03'])
    // The single-day event gets no control at all.
    const single = container.querySelector(`[data-event-card="${singleDayCluster.id}"]`)
    expect(single?.querySelector('[role="group"]')).toBeNull()
  })

  test('a card opens the existing viewer at the event’s first frame', async () => {
    const { container, opened } = mountSection({ bridge: readyShell().bridge })
    await settle()
    click(byText(container, '12 Mar 2026'))
    expect(opened).toHaveLength(1)
    expect(opened[0]?.index).toBe(0)
    expect(opened[0]?.rootPath).toBe(ROOT)
    expect(opened[0]?.cluster.id).toBe(singleDayCluster.id)
  })

  test('a day opens the event at that day’s first frame, in one gesture', async () => {
    const { container, opened } = mountSection({ bridge: readyShell().bridge })
    await settle()
    const trip = container.querySelector(`[data-event-card="${tripCluster.id}"]`)
    const days = [...(trip?.querySelectorAll('[data-event-day]') ?? [])]
    click(days[1])
    // '2 Jun' holds the event's second and third frames; it opens on the
    // second, and the last day lands on the fourth.
    expect(opened.map((entry) => entry.index)).toEqual([1])
    click(days[2])
    expect(opened.map((entry) => entry.index)).toEqual([1, 3])
    // The title is still the way into the whole event.
    click(byText(container, '1–3 Jun 2026'))
    expect(opened[2]?.index).toBe(0)
    expect(opened).toHaveLength(3)
  })

  test('a dump that went away mid-read is reported, not rendered empty', async () => {
    const shell = stub({
      get_raw_dump_status: statusFor(),
      scan_raw_dump_events: new Error('the folder could not be reached'),
    })
    const { container } = mountSection({ bridge: shell.bridge })
    await settle()
    expect(container.textContent).toContain('could not be read')
    expect(container.textContent).not.toContain('No events')
    // The owner is handed the one action that can help.
    expect(byText(container, 'Try again')).toBeDefined()
  })

  test('a shell event offers the re-scan, and taking it re-reads the index', async () => {
    const shell = readyShell()
    const { container } = mountSection({ bridge: shell.bridge })
    await settle()
    expect(byText(container, 'Re-scan')).toBeUndefined()
    shell.emitChanged()
    await settle()
    expect(container.textContent).toContain('changed since this was indexed')
    click(byText(container, 'Re-scan'))
    await settle()
    expect(shell.commands().filter((command) => command === 'scan_raw_dump_events')).toHaveLength(2)
    // The offer is gone once the re-scan has landed.
    expect(byText(container, 'Re-scan')).toBeUndefined()
  })
})

describe('RawDumpSettings', () => {
  test('nothing is offered when the runtime cannot keep the declaration', async () => {
    const shell = stub({ get_raw_dump_status: statusFor() })
    const { container } = mountSettings({ native: false, bridge: shell.bridge })
    await settle()
    expect(container.innerHTML).toBe('')
    expect(shell.commands()).toEqual([])
  })

  test('a shell with no answer leaves no control behind', async () => {
    const { container } = mountSettings({ bridge: stub().bridge })
    await settle()
    expect(container.innerHTML).toBe('')
  })

  test('undeclared: one row, and choosing a folder indexes it in the same gesture', async () => {
    const shell = stub({
      get_raw_dump_status: { configured: false },
      pick_raw_dump_root: { label: 'Google Photos', itemCount: 12480, rootPath: '/dump' },
      scan_raw_dump_events: { clusters: [], screenshotCount: 0, rootPath: '/dump' },
    })
    const { container, changed } = mountSettings({ bridge: shell.bridge })
    await settle()
    expect(row(container, 'Choose a folder')).toBeDefined()
    click(row(container, 'Choose a folder'))
    await settle()
    expect(shell.commands()).toEqual([
      'get_raw_dump_status',
      'pick_raw_dump_root',
      'scan_raw_dump_events',
      'get_raw_dump_status',
    ])
    // The Library section is told to re-read, so the cards arrive without a
    // round trip back into Settings.
    expect(changed).toHaveLength(1)
  })

  test('a cancelled chooser changes nothing', async () => {
    const shell = stub({ get_raw_dump_status: { configured: false }, pick_raw_dump_root: null })
    const { container, changed } = mountSettings({ bridge: shell.bridge })
    await settle()
    click(row(container, 'Choose a folder'))
    await settle()
    expect(shell.commands()).toEqual(['get_raw_dump_status', 'pick_raw_dump_root'])
    expect(changed).toHaveLength(0)
  })

  test('declared: the label, the ageing indexed-at line and the event count', async () => {
    const shell = stub({ get_raw_dump_status: statusFor({ lastIndexedAt: at(2026, 11, 20, 9) }) })
    const { container } = mountSettings({
      bridge: shell.bridge,
      now: () => at(2026, 11, 23, 9),
    })
    await settle()
    expect(row(container, 'Folder')?.textContent).toContain('Photos Backup')
    expect(row(container, 'Last indexed')?.textContent).toContain('Indexed 20 Nov 2026')
    expect(row(container, 'Events')?.textContent).toContain('2 events')
    expect(row(container, 'Re-index')).toBeDefined()
    expect(row(container, 'Stop using this folder')).toBeDefined()
  })

  test('declared but unreachable: it says so and will not offer a scan', async () => {
    const shell = stub({
      get_raw_dump_status: statusFor({ isAvailable: false }),
      scan_raw_dump_events: { clusters: [], screenshotCount: 0, rootPath: null },
    })
    const { container } = mountSettings({ bridge: shell.bridge })
    await settle()
    expect(container.textContent).toContain('Not reachable right now')
    const reindex = row(container, 'Re-index')
    expect(reindex?.tagName).toBe('BUTTON')
    expect(reindex?.hasAttribute('disabled')).toBe(true)
    expect(shell.commands()).toEqual(['get_raw_dump_status'])
  })

  test('re-index forces the read and re-pulls the status', async () => {
    const shell = stub({
      get_raw_dump_status: statusFor(),
      scan_raw_dump_events: { clusters: [singleDayCluster], screenshotCount: 0, rootPath: ROOT },
    })
    const { container, changed } = mountSettings({ bridge: shell.bridge })
    await settle()
    click(row(container, 'Re-index'))
    await settle()
    expect(shell.commands().filter((command) => command === 'scan_raw_dump_events')).toHaveLength(1)
    expect(shell.commands().filter((command) => command === 'get_raw_dump_status')).toHaveLength(2)
    expect(changed).toHaveLength(1)
  })

  test('removing the declaration asks the shell to let go, then shows the chooser again', async () => {
    const declared = statusFor()
    const shell = stub({
      get_raw_dump_status: declared,
      clear_raw_dump_root: null,
    })
    // The second status read must answer "not configured" — the stub hands
    // back the same object every time, so swap it after the clear.
    let cleared = false
    const bridge: RawDumpBridge = {
      invoke: async (command) => {
        await shell.bridge.invoke(command)
        if (command === 'clear_raw_dump_root') {
          cleared = true
          return null
        }
        return cleared ? { configured: false } : declared
      },
    }
    const { container, changed } = mountSettings({ bridge })
    await settle()
    expect(row(container, 'Folder')?.textContent).toContain('Photos Backup')
    click(row(container, 'Stop using this folder'))
    await settle()
    expect(cleared).toBe(true)
    expect(row(container, 'Choose a folder')).toBeDefined()
    expect(changed).toHaveLength(1)
  })

  test('a folder this Mac could not take on is reported as not taken', async () => {
    const shell = stub({
      get_raw_dump_status: { configured: false },
      pick_raw_dump_root: new Error('the bookmark could not be written'),
    })
    const { container, changed } = mountSettings({ bridge: shell.bridge })
    await settle()
    click(row(container, 'Choose a folder'))
    await settle()
    expect(container.textContent).toContain('could not take on that folder')
    expect(changed).toHaveLength(0)
  })
})
