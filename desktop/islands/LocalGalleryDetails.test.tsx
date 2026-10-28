import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import LocalGalleryDetails from './LocalGalleryDetails'
import type { GalleryAvailability, LocalGalleryRecord } from '../lib/catalogue'

/**
 * LocalGalleryDetails is a presentational surface: it owns sheets, busy and
 * error states, and reports intent through callbacks. Because the confirmation
 * and edit sheets are lifecycle features, it is exercised through a mounted
 * island, not a stringified render. `requestAnimationFrame` is queued by hand
 * (hono flushes effects inside it), so every async boundary is a deliberate
 * step instead of a sleep.
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
/** Drain effects, microtask state flushes and any creative they resolve. */
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const GALLERY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TITLE = 'italy, amore mio'
const ROOT_PATH = '/Users/home/Pictures/italy, amore mio'
const ITEM_NAME = 'MS201810-Italy0005.jpg'

const item = (id: string, name: string, width: number, height: number) => ({
  id,
  name,
  path: `${ROOT_PATH}/${name}`,
  width,
  height,
})

const record = (overrides: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
  id: GALLERY_ID,
  title: TITLE,
  rootPath: ROOT_PATH,
  sourceKind: 'folder',
  itemCount: 2,
  items: [
    item('image-1', ITEM_NAME, 4000, 3000),
    item('image-2', 'MS201810-Italy0100.jpg', 3000, 4000),
  ],
  addedAt: '2026-10-11T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
  ...overrides,
})

const deferred = () => {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Props = Parameters<typeof LocalGalleryDetails>[0]

const mount = (overrides: Partial<Props> = {}) => {
  const calls = {
    back: 0,
    open: 0,
    share: 0,
    rescan: 0,
    rename: [] as string[],
    remove: 0,
  }
  const props: Props = {
    record: overrides.record ?? record(),
    availability: overrides.availability ?? 'available',
    onBack: overrides.onBack ?? (() => { calls.back += 1 }),
    onOpen: overrides.onOpen ?? (() => { calls.open += 1 }),
    onShare: overrides.onShare ?? (() => { calls.share += 1 }),
    onRescan: overrides.onRescan
      ? async () => { calls.rescan += 1; await overrides.onRescan?.() }
      : () => { calls.rescan += 1 },
    onRename: overrides.onRename
      ? async (title) => { calls.rename.push(title); await overrides.onRename?.(title) }
      : (title) => { calls.rename.push(title) },
    onRemove: overrides.onRemove
      ? async () => { calls.remove += 1; await overrides.onRemove?.() }
      : () => { calls.remove += 1 },
  }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(<LocalGalleryDetails {...props} />, container)
  return { container, calls }
}

const byText = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)

/** An action row's clickable element, found by its visible label. */
const row = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('.m-actionrow-label')]
    .find((el) => el.textContent === label)
    ?.closest<HTMLElement>('.m-actionrow')

const setInput = (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/** The shared edit sheet submits on Enter — the real user path, since
 *  happy-dom does not run form submission for type="submit" buttons. */
const pressEnter = (input: HTMLInputElement) => {
  input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as KeyboardEvent)
}

/** A button inside the currently open sheet, by visible text. */
const sheetButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.m-sheet button')].find((button) => button.textContent?.trim() === text)

let dom: Window
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown

beforeAll(() => {
  dom = new Window({ width: 1280, height: 840, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  // hono's JSX renderer checks `instanceof SVGElement` for svg elements.
  globals.SVGElement = dom.SVGElement
  // The overlay stack checks `instanceof HTMLElement` when it inerts a
  // sheet's sibling chain, and sheets observe their host leaving the DOM.
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
  // SVGElement and the rAF pair stay installed: hono keeps its namespace
  // context once an <svg> has rendered, and clearing the DOM does not run
  // effect cleanup, so a later post-effect pass would call the bare globals.
})

afterEach(() => {
  releaseAllOverlays()
  dom.document.body.innerHTML = ''
  frames = []
})

describe('local gallery details (desktop)', () => {
  test('renders the shared full-screen owner surface with a Back that fires', async () => {
    const { container, calls } = mount()
    const main = container.querySelector('main.m-owner.m-screen.m-screen--fixed')
    expect(main).not.toBeNull()
    expect(main?.getAttribute('data-screen')).toBe('local-details')
    expect(main?.querySelector('.m-owner-content')).not.toBeNull()

    const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')
    expect(back).not.toBeNull()
    back?.click()
    await settle()
    expect(calls.back).toBe(1)
  })

  test('shows the gallery title in the top bar and heading, with count and source', async () => {
    const { container } = mount()
    expect(container.querySelector('.m-topbar-title')?.textContent).toBe(TITLE)
    expect(container.querySelector('.m-owner-heading h1')?.textContent).toBe(TITLE)
    expect(container.querySelector('.m-owner-heading')?.textContent).toContain('2 photographs · Folder on this Mac')
    expect(container.querySelector('.m-owner-heading')?.textContent).not.toContain('photograph · Folder')
  })

  test('a mounted card source reads "Memory card"', async () => {
    const { container } = mount({
      record: record({ sourceKind: 'card', mountPoint: '/Volumes/CARD' }),
    })
    expect(container.querySelector('.m-owner-heading')?.textContent).toContain('Memory card')
  })

  test('renders exactly the four action verbs and no banned surfaces', async () => {
    const { container } = mount()
    for (const label of ['Open', 'Publish/Share', 'Read folder again', 'Remove from Library']) {
      expect(row(container, label)).not.toBeNull()
    }
    // Five rows: the editable Name row plus exactly the four action verbs.
    expect(container.querySelectorAll('.m-actionrow')).toHaveLength(5)
    // Remove is destructive.
    expect(row(container, 'Remove from Library')?.classList.contains('m-actionrow--destructive')).toBe(true)

    const html = container.innerHTML
    // Paths, mount points, and filenames never surface — they are local-only.
    expect(html).not.toContain(ROOT_PATH)
    expect(html).not.toContain('/Volumes/')
    expect(html).not.toContain(ITEM_NAME)
    // No public address, no provider metadata, no vault/offline/copy/reorder UI.
    expect(html).not.toContain('manorama.xyz')
    expect(html).not.toContain('Dropbox')
    expect(html).not.toContain('Google Drive')
    expect(html).not.toContain('iCloud')
    expect(html).not.toContain('MEGA')
    expect(html).not.toContain('Keep a copy')
    expect(html).not.toContain('Offline')
    expect(html).not.toContain('Vault')
    expect(html).not.toContain('Reorder')
  })

  test('when the source is unavailable, Open and Share are disabled and the state shows', async () => {
    const { container, calls } = mount({ availability: 'unavailable' })
    const openRow = row(container, 'Open') as HTMLButtonElement
    const shareRow = row(container, 'Publish/Share') as HTMLButtonElement
    const rescanRow = row(container, 'Read folder again') as HTMLButtonElement
    expect(openRow.disabled).toBe(true)
    expect(shareRow.disabled).toBe(true)
    // Rescan is the recovery path and stays enabled.
    expect(rescanRow.disabled).toBe(false)

    const status = container.querySelector('[data-availability="unavailable"]')
    expect(status?.textContent).toBe('Unavailable — reconnect the source, then rescan.')

    openRow.click()
    shareRow.click()
    await settle()
    expect(calls.open).toBe(0)
    expect(calls.share).toBe(0)
  })

  test('when available, Open and Share are enabled and fire', async () => {
    const { container, calls } = mount()
    expect((row(container, 'Open') as HTMLButtonElement).disabled).toBe(false)
    expect((row(container, 'Publish/Share') as HTMLButtonElement).disabled).toBe(false)
    expect(container.querySelector('[data-availability="available"]')?.textContent).toBe('Source available')

    ;(row(container, 'Open') as HTMLButtonElement).click()
    ;(row(container, 'Publish/Share') as HTMLButtonElement).click()
    await settle()
    expect(calls.open).toBe(1)
    expect(calls.share).toBe(1)
  })

  test('renaming opens the shared edit sheet and submits the trimmed title', async () => {
    const { container, calls } = mount()
    ;(row(container, 'Name') as HTMLButtonElement).click()
    await settle()

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')
    expect(input).not.toBeNull()
    expect(input?.value).toBe(TITLE)
    expect(container.textContent).toContain('Edit name')

    setInput(input!, `  ${TITLE}  `)
    await settle()
    expect(byText(container, 'Save')).not.toBeNull()
    pressEnter(input!)
    await settle()

    expect(calls.rename).toEqual([TITLE])
    expect(container.textContent).not.toContain('Edit name')
    expect(container.textContent).toContain('Name saved')
  })

  test('a failed rename keeps the sheet open, keeps the draft, and reports', async () => {
    const renameGate = deferred()
    const { container, calls } = mount({
      onRename: () => renameGate.promise,
    })
    ;(row(container, 'Name') as HTMLButtonElement).click()
    await settle()
    setInput(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, 'vernazza')
    await settle()
    pressEnter(container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!)
    await settle()

    // Busy: the sheet is not dismissible and saving shows progress.
    expect(calls.rename).toHaveLength(1)
    expect(byText(container, 'Saving…')).not.toBeNull()
    expect(container.querySelector('[aria-label="Close"]')).toBeNull()

    renameGate.reject(new Error('The disk is busy'))
    await settle()

    expect(container.textContent).toContain('Edit name')
    expect(container.querySelector('input[aria-label="Name"]')?.getAttribute('value')).toBe('vernazza')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The disk is busy')
    expect(byText(container, 'Save')).not.toBeNull()
  })

  test('remove asks for confirmation with copy that originals are untouched', async () => {
    const { container, calls } = mount()
    ;(row(container, 'Remove from Library') as HTMLButtonElement).click()
    await settle()

    expect(container.textContent).toContain(`Remove “${TITLE}”?`)
    const body = container.textContent
    expect(body).toContain('catalogue entry')
    expect(body).toContain('untouched')
    expect(body).not.toContain('deleted from the folder')

    // Cancel dismisses without removing.
    sheetButton(container, 'Cancel')?.click()
    await settle()
    expect(container.textContent).not.toContain(`Remove “${TITLE}”?`)
    expect(calls.remove).toBe(0)
  })

  test('confirming remove calls onRemove once and shows progress while it runs', async () => {
    const removeGate = deferred()
    const { container, calls } = mount({
      onRemove: () => removeGate.promise,
    })
    ;(row(container, 'Remove from Library') as HTMLButtonElement).click()
    await settle()
    sheetButton(container, 'Remove from Library')?.click()
    await settle()

    expect(calls.remove).toBe(1)
    expect(byText(container, 'Removing…')).not.toBeNull()
    expect(sheetButton(container, 'Remove from Library')).toBeUndefined()
    expect((sheetButton(container, 'Cancel') as HTMLButtonElement | undefined)?.disabled).toBe(true)

    removeGate.resolve()
    await settle()
    expect(container.textContent).not.toContain(`Remove “${TITLE}”?`)
  })

  test('a failed remove reports and leaves the confirmation open for retry', async () => {
    const removeGate = deferred()
    const { container, calls } = mount({
      onRemove: () => removeGate.promise,
    })
    ;(row(container, 'Remove from Library') as HTMLButtonElement).click()
    await settle()
    sheetButton(container, 'Remove from Library')?.click()
    await settle()
    removeGate.reject(new Error('The catalogue is locked'))
    await settle()

    expect(calls.remove).toBe(1)
    expect(container.textContent).toContain('The catalogue is locked')
    expect(container.textContent).toContain(`Remove “${TITLE}”?`)
    expect(sheetButton(container, 'Remove from Library')).not.toBeUndefined()
  })

  test('a rescan calls back and reports success and failure', async () => {
    const rescanGate = deferred()
    const { container, calls } = mount({ onRescan: () => rescanGate.promise })
    ;(row(container, 'Read folder again') as HTMLButtonElement).click()
    await settle()
    expect(calls.rescan).toBe(1)
    rescanGate.resolve()
    await settle()
    expect(container.textContent).toContain('Read just now')

    const failGate = deferred()
    const failing = mount({ onRescan: () => failGate.promise })
    ;(row(failing.container, 'Read folder again') as HTMLButtonElement).click()
    await settle()
    failGate.reject(new Error('The card is not mounted'))
    await settle()
    expect(failing.container.textContent).toContain('The card is not mounted')
  })
})
