import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import EncryptedGallery from './EncryptedGallery'
import { defaultGallerySettings } from '../../packages/core/gallery-settings'
import type { GalleryManifest } from '../../packages/core/imagesource'

/**
 * A Proton-backed gallery is a special surface: Proton's API answers CORS
 * to drive.proton.me alone, so a real browser can never open the source —
 * the island gates on protonTransportAvailable() up front and renders the
 * add-to-Library guidance instead of a paste form that could not work.
 * The same gallery inside a shell (tauri marker present) proceeds to the
 * normal key-resolution flow.
 */

const globals = globalThis as Record<string, unknown>
let dom: Window
let previousWindow: unknown
let previousDocument: unknown
let previousLocalStorage: unknown
let previousSessionStorage: unknown
let previousHTMLElement: unknown
let previousMutationObserver: unknown
let previousRaf: unknown
let previousCaf: unknown

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
  for (let round = 0; round < 8; round++) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const MANIFEST = { slug: 'guinea', title: 'guinea', caption: '', date: '', images: [] } as GalleryManifest
const keyStore = { get: async () => null, put: async () => undefined, remove: async () => undefined }

const mount = async (sourceUrl: string) => {
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(
    <EncryptedGallery
      galleryId="2b5dee85-7a75-4c48-93ec-ea1869361480"
      sourceUrl={sourceUrl}
      slug="guinea"
      images={MANIFEST.images}
      settings={defaultGallerySettings(MANIFEST)}
      keyStore={keyStore}
    />,
    container,
  )
  await settle()
  return container
}

beforeAll(() => {
  previousWindow = globals.window
  previousDocument = globals.document
  previousLocalStorage = globals.localStorage
  previousSessionStorage = globals.sessionStorage
  previousHTMLElement = globals.HTMLElement
  previousMutationObserver = globals.MutationObserver
  previousRaf = globals.requestAnimationFrame
  previousCaf = globals.cancelAnimationFrame
})

afterAll(() => {
  globals.window = previousWindow
  globals.document = previousDocument
  globals.localStorage = previousLocalStorage
  globals.sessionStorage = previousSessionStorage
  globals.HTMLElement = previousHTMLElement
  globals.MutationObserver = previousMutationObserver
  globals.requestAnimationFrame = previousRaf
  globals.cancelAnimationFrame = previousCaf
})

const freshDom = () => {
  dom = new Window()
  globals.window = dom
  globals.document = dom.document
  globals.localStorage = dom.localStorage
  globals.sessionStorage = dom.sessionStorage
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
  globals.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.push({ id, callback })
    return id
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => {
    frames = frames.filter((frame) => frame.id !== id)
  }) as unknown as typeof cancelAnimationFrame
}

describe('EncryptedGallery proton surface', () => {
  test('a Proton source in a real browser shows app guidance, never a paste form', async () => {
    freshDom()
    const container = await mount('https://drive.proton.me/urls/15C18NM2P0')
    const panel = container.querySelector('.encrypted-locked')
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('h1')?.textContent).toBe('This gallery opens in the manorama app')
    expect(panel?.textContent).toContain('Proton Drive')
    expect(panel?.textContent).toContain('A shared cloud link')
    expect(container.querySelector('#encrypted-unlock-url')).toBeNull()
  })

  test('a MEGA source in the same browser still earns the unlock form', async () => {
    freshDom()
    const container = await mount('https://mega.nz/folder/AbCdEfGh')
    // The keystore is empty and there is no fragment — the generic locked
    // state with its working paste form is the honest surface for MEGA.
    expect(container.querySelector('.encrypted-locked h1')?.textContent).toBe('This gallery is locked on this device')
    expect(container.querySelector('#encrypted-unlock-url')).not.toBeNull()
  })

  test('a Proton source inside a tauri shell proceeds past the gate', async () => {
    freshDom()
    ;(dom as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async () => null }
    const container = await mount('https://drive.proton.me/urls/15C18NM2P0')
    // Transport exists, so the normal flow runs: no key in custody → the
    // unlock form, which inside the shell can actually open a pasted link.
    expect(container.querySelector('.encrypted-locked h1')?.textContent).toBe('This gallery is locked on this device')
    expect(container.querySelector('#encrypted-unlock-url')).not.toBeNull()
  })
})
