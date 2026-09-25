import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import VaultSettings from './VaultSettings'
import { FREE_VAULT_CAP_BYTES } from '../lib/vault-settings'
import type { VaultCapPreference, VaultSettingsController, VaultSettingsSnapshot } from '../lib/vault-settings'
import type { OfflineGallerySummary } from '../lib/offline-gallery'
import type { VaultUsage } from '../lib/vault'

/**
 * Same mounted-island discipline as the account-slot tests: every async
 * boundary is a queued animation frame, stepped deliberately rather than
 * slept through.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousAnimationFrame: unknown
let previousCancelAnimationFrame: unknown

type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}
const settle = async () => {
  for (let round = 0; round < 8; round++) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

let dom: Window
beforeAll(() => {
  dom = new Window({ width: 375, height: 812, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousAnimationFrame = globals.requestAnimationFrame
  previousCancelAnimationFrame = globals.cancelAnimationFrame
  globals.window = dom
  globals.document = dom.document
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
  globals.requestAnimationFrame = previousAnimationFrame
  globals.cancelAnimationFrame = previousCancelAnimationFrame
})

const MIB = 1024 * 1024

const usage = (overrides: Partial<VaultUsage> = {}): VaultUsage => ({
  measuredBytes: 90 * MIB,
  indexedBytes: 80 * MIB,
  entryBytes: 80 * MIB,
  indexBytes: 4 * 1024,
  tempBytes: 2 * MIB,
  orphanBytes: 8 * MIB,
  galleries: [
    { galleryId: 'gid-quiet', entries: 3, indexedBytes: 50 * MIB, measuredBytes: 55 * MIB },
    { galleryId: 'gid-second', entries: 2, indexedBytes: 30 * MIB, measuredBytes: 35 * MIB },
  ],
  ...overrides,
})

const summaries: OfflineGallerySummary[] = [
  { status: 'cached', galleryId: 'gid-quiet', owner: 'photographer', slug: 'quiet-light', title: 'Quiet light', images: 3 },
  { status: 'cached', galleryId: 'gid-second', owner: 'photographer', slug: 'second-album', title: 'Second album', images: 2 },
]

type FakeController = VaultSettingsController & {
  calls: { selectCap: VaultCapPreference[]; purgeGallery: string[]; purgeAll: number }
  failNextPurge: boolean
  snapshotValue: VaultSettingsSnapshot
}

const makeController = (snapshot?: Partial<VaultSettingsSnapshot>): FakeController => {
  const calls = { selectCap: [] as VaultCapPreference[], purgeGallery: [] as string[], purgeAll: 0 }
  return {
    calls,
    failNextPurge: false,
    snapshotValue: {
      cap: FREE_VAULT_CAP_BYTES,
      preference: undefined,
      usage: usage(),
      galleries: [...summaries],
      ...snapshot,
    },
    async snapshot() { return this.snapshotValue },
    async selectCap(preference) {
      calls.selectCap.push(preference)
      this.snapshotValue = { ...this.snapshotValue, cap: preference === null ? null : preference, preference }
      return { evictedBytes: 0 }
    },
    async purgeGallery(galleryId) {
      if (this.failNextPurge) {
        this.failNextPurge = false
        throw new Error('Vault cleanup could not verify 1 removal')
      }
      calls.purgeGallery.push(galleryId)
      this.snapshotValue = {
        ...this.snapshotValue,
        galleries: this.snapshotValue.galleries.filter((gallery) => gallery.galleryId !== galleryId),
      }
    },
    async forgetEverything() {
      calls.purgeAll += 1
      this.snapshotValue = { ...this.snapshotValue, galleries: [] }
    },
  }
}

const mount = (controller: FakeController, tier?: 'free' | 'pro') => {
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(<VaultSettings controller={controller} tier={tier} />, container)
  return container
}

const click = (element: Element | null | undefined) => {
  element?.dispatchEvent(new dom.Event('click', { bubbles: true }) as unknown as Event)
}

describe('VaultSettings island', () => {
  test('renders honest usage and the cached gallery list', async () => {
    const controller = makeController()
    const container = mount(controller, 'free')
    await settle()

    const html = container.innerHTML
    expect(html).toContain('Total on this device')
    expect(html).toContain('90.0 MiB')
    expect(html).toContain('Quiet light')
    expect(html).toContain('3 photographs')
    expect(html).toContain('Second album')
    // The bound is described honestly — an upper bound, never reserved space.
    expect(html).toContain('upper bound')
    expect(html).toContain('not reserved space')
  })

  test('free tier caps at 256 MiB with no unlimited option; pro offers it', async () => {
    const free = mount(makeController(), 'free')
    await settle()
    const freeOptions = [...free.querySelectorAll('option')].map((option) => option.getAttribute('value'))
    expect(freeOptions).not.toContain('unlimited')
    expect(freeOptions).toContain(String(FREE_VAULT_CAP_BYTES))

    const pro = mount(makeController({ cap: null, preference: null }), 'pro')
    await settle()
    const proOptions = [...pro.querySelectorAll('option')].map((option) => option.getAttribute('value'))
    expect(proOptions).toContain('unlimited')
    const select = pro.querySelector('select') as HTMLSelectElement | null
    expect(select?.value).toBe('unlimited')
  })

  test('choosing a limit persists and applies through the controller', async () => {
    const controller = makeController()
    const container = mount(controller, 'free')
    await settle()

    const select = container.querySelector('select') as HTMLSelectElement
    select.value = String(64 * MIB)
    // hono/jsx/dom aliases onChange to the input event.
    select.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    await settle()

    expect(controller.calls.selectCap).toEqual([64 * MIB])
  })

  test('a gallery purge needs two taps and removes the row', async () => {
    const controller = makeController()
    const container = mount(controller, 'free')
    await settle()

    const row = container.querySelector('[data-vault-gallery="gid-quiet"]')
    const button = row?.querySelector('button')
    expect(button?.textContent).toBe('Remove')

    click(button)
    await settle()
    // First tap only arms — nothing was deleted.
    expect(controller.calls.purgeGallery).toEqual([])
    expect(button?.textContent).toBe('Tap again to remove')

    click(container.querySelector('[data-vault-gallery="gid-quiet"] button'))
    await settle()
    expect(controller.calls.purgeGallery).toEqual(['gid-quiet'])
    expect(container.querySelector('[data-vault-gallery="gid-quiet"]')).toBeNull()
  })

  test('a failed purge reports honestly and retries with the same tap', async () => {
    const controller = makeController()
    controller.failNextPurge = true
    const container = mount(controller, 'free')
    await settle()

    const row = () => container.querySelector('[data-vault-gallery="gid-quiet"]')
    click(row()?.querySelector('button'))
    await settle()
    click(row()?.querySelector('button'))
    await settle()

    expect(controller.calls.purgeGallery).toEqual([])
    expect(container.innerHTML).toContain('could not verify')
    expect(container.innerHTML).toContain('try again')

    // Retry: the button is still armed, one more tap succeeds.
    click(row()?.querySelector('button'))
    await settle()
    expect(controller.calls.purgeGallery).toEqual(['gid-quiet'])
    expect(row()).toBeNull()
  })

  test('forget everything needs two taps and clears every gallery', async () => {
    const controller = makeController()
    const container = mount(controller, 'free')
    await settle()

    const forget = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Forget everything')
    expect(forget).toBeDefined()
    click(forget!)
    await settle()
    expect(controller.calls.purgeAll).toBe(0)

    const armedButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Tap again to erase everything')
    click(armedButton!)
    await settle()
    expect(controller.calls.purgeAll).toBe(1)
    expect(container.innerHTML).toContain('No galleries are stored')
  })

  test('a corrupt gallery is labelled and still purgeable', async () => {
    const controller = makeController({
      galleries: [{ status: 'corrupt', galleryId: 'gid-broken' }],
    })
    const container = mount(controller, 'free')
    await settle()

    const row = container.querySelector('[data-vault-gallery="gid-broken"]')
    expect(row?.textContent).toContain('Unreadable cache')
    const button = row?.querySelector('button')
    click(button!)
    await settle()
    click(container.querySelector('[data-vault-gallery="gid-broken"] button')!)
    await settle()
    expect(controller.calls.purgeGallery).toEqual(['gid-broken'])
  })

  test('flushSync renders do not fire destructive actions', async () => {
    const controller = makeController()
    const container = mount(controller, 'free')
    await settle()

    // Ordinary re-renders never arm or fire: only deliberate taps do.
    flushSync(() => {})
    await settle()
    expect(controller.calls.purgeAll).toBe(0)
    expect(controller.calls.purgeGallery).toEqual([])
  })
})
