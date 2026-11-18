import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { unmountTracker } from '../../test/unmount'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import LocalGalleryDetails from './LocalGalleryDetails'
import type { LocalGalleryRecord } from '../lib/catalogue'

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
    open: 0,
    rename: [] as string[],
    remove: 0,
  }
  const props: Props = {
    record: overrides.record ?? record(),
    availability: overrides.availability ?? 'available',
    onOpen: overrides.onOpen ?? (() => { calls.open += 1 }),
    onRename: overrides.onRename
      ? async (title) => { calls.rename.push(title); await overrides.onRename?.(title) }
      : (title) => { calls.rename.push(title) },
    onRemove: overrides.onRemove
      ? async () => { calls.remove += 1; await overrides.onRemove?.() }
      : () => { calls.remove += 1 },
    onRevealFolder: overrides.onRevealFolder,
  }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  mounts.mount(<LocalGalleryDetails {...props} />, container)
  return { container, calls }
}

// Mounts leave through the tracker: its drop removes the child via a
// flushed state update, so reconciliation runs effect cleanup — a root
// render(null) skips it exactly like wiping innerHTML does.
const mounts = unmountTracker()

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
  mounts.unmountAll()
  dom.document.body.innerHTML = ''
  frames = []
})

describe('local gallery settings panel (desktop)', () => {
  test('renders the owner-panel form an account gallery’s settings shares', async () => {
    const { container } = mount()
    const panel = container.querySelector('.m-owner-panel')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('data-screen')).toBe('local-details')
    // The panel carries no page chrome — the Sheet host owns dismiss/back,
    // matching the account galleries' settings surface.
    expect(container.querySelector('main')).toBeNull()
    expect(container.querySelector('.m-topbar')).toBeNull()
  })

  test('shows the title once in the panel head, with count and source', async () => {
    const { container } = mount()
    expect(container.querySelector('.m-owner-panel-title')?.textContent).toBe(TITLE)
    expect(container.querySelector('.m-owner-panel-meta')?.textContent).toContain('2 photographs · Folder on this Mac')
    expect(container.querySelector('.m-owner-panel-meta')?.textContent).not.toContain('photograph · Folder')
  })

  test('a mounted card source reads "Memory card"', async () => {
    const { container } = mount({
      record: record({ sourceKind: 'card', mountPoint: '/Volumes/CARD' }),
    })
    expect(container.querySelector('.m-owner-panel-meta')?.textContent).toContain('Memory card')
  })

  test('renders exactly the local action verbs and no banned surfaces', async () => {
    const { container } = mount()
    expect([...container.querySelectorAll('.m-actionrow-label')].map((el) => el.textContent)).toEqual([
      'Open gallery', 'Name', 'Remove from Library',
    ])
    for (const label of ['Copy link', 'Share link', 'Publish', 'Reorder photos', 'Reorder photographs', 'Refresh gallery', 'Refresh gallery contents']) {
      expect(row(container, label)).toBeUndefined()
    }
    // Remove is destructive.
    expect(row(container, 'Remove from Library')?.classList.contains('m-actionrow--destructive')).toBe(true)

    // Paths, mount points, and filenames never surface in the copy — they are
    // local-only.
    const html = container.innerHTML
    expect(html).not.toContain('d-rail')
    expect(html).not.toContain(ROOT_PATH)
    expect(html).not.toContain('/Volumes/')
    expect(html).not.toContain(ITEM_NAME)
    // No public address, no provider metadata, no vault/offline/copy UI.
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

  test('Open folder renders and emits when the container wires it', async () => {
    let reveals = 0
    const { container } = mount({ onRevealFolder: () => { reveals += 1 } })
    expect([...container.querySelectorAll('.m-actionrow-label')].map((el) => el.textContent)).toEqual([
      'Open gallery', 'Name', 'Open folder', 'Remove from Library',
    ])
    const folder = row(container, 'Open folder') as HTMLButtonElement
    expect(folder).not.toBeNull()
    expect(folder.disabled).toBe(false)
    folder.click()
    await settle()
    expect(reveals).toBe(1)

    // Unwired, the row is absent — the local counterpart of View source.
    const { container: plain } = mount()
    expect(row(plain, 'Open folder')).toBeUndefined()
  })

  test('when the source is unavailable, Open is disabled and the state shows', async () => {
    const { container, calls } = mount({ availability: 'unavailable', onRevealFolder: () => {} })
    const openRow = row(container, 'Open gallery') as HTMLButtonElement
    expect(openRow.disabled).toBe(true)
    for (const label of ['Name', 'Open folder', 'Remove from Library']) {
      expect((row(container, label) as HTMLButtonElement).disabled).toBe(false)
    }

    const status = container.querySelector('[data-availability="unavailable"]')
    expect(status?.textContent).toBe('Unavailable — reconnect the source, then rescan.')

    openRow.click()
    await settle()
    expect(calls.open).toBe(0)
  })

  test('when available, Open is enabled and fires', async () => {
    const { container, calls } = mount()
    expect((row(container, 'Open gallery') as HTMLButtonElement).disabled).toBe(false)
    // An available source states nothing — the line exists only to warn
    // when the source is gone.
    expect(container.querySelector('[data-availability]')).toBeNull()

    ;(row(container, 'Open gallery') as HTMLButtonElement).click()
    await settle()
    expect(calls.open).toBe(1)
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
      onRevealFolder: () => {},
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
    for (const label of ['Open gallery', 'Name', 'Open folder', 'Remove from Library']) {
      expect((row(container, label) as HTMLButtonElement).disabled).toBe(true)
    }

    renameGate.reject(new Error('The disk is busy'))
    await settle()

    expect(container.textContent).toContain('Edit name')
    expect(container.querySelector('input[aria-label="Name"]')?.getAttribute('value')).toBe('vernazza')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The disk is busy')
    expect(byText(container, 'Save')).not.toBeNull()
    for (const label of ['Open gallery', 'Name', 'Open folder', 'Remove from Library']) {
      expect((row(container, label) as HTMLButtonElement).disabled).toBe(false)
    }
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
      onRevealFolder: () => {},
    })
    ;(row(container, 'Remove from Library') as HTMLButtonElement).click()
    await settle()
    sheetButton(container, 'Remove from Library')?.click()
    await settle()

    expect(calls.remove).toBe(1)
    expect(byText(container, 'Removing…')).not.toBeNull()
    expect(sheetButton(container, 'Remove from Library')).toBeUndefined()
    expect((sheetButton(container, 'Cancel') as HTMLButtonElement | undefined)?.disabled).toBe(true)
    expect(container.querySelector('[aria-label="Close"]')).toBeNull()
    for (const label of ['Open gallery', 'Name', 'Open folder', 'Remove from Library']) {
      expect((row(container, label) as HTMLButtonElement).disabled).toBe(true)
    }

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

})

describe('the details rail stylesheet contract', () => {
  // The rail sizes each item through `height:100%` on the img, which only
  // resolves when the wrapping button is `display:block; height:100%`. That
  // rule shipped scoped to `.lib-card`, so the details rail's buttons stayed
  // unsized and every img fell back to natural size — a cropped slice of the
  // original instead of thumbnails. happy-dom cannot compute styles, so the
  // contract is asserted on the stylesheet itself, canary-style.
  test('the strip-item interactive child rule covers the details rail', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const css = readFileSync(new URL('../../app/styles.css', import.meta.url).pathname, 'utf8')
    expect(css).toMatch(/:is\(\.lib-card, \.d-rail\) \.admin-gallery-strip-item > :is\(a, button\) \{[^}]*height: 100%/)
  })
})
