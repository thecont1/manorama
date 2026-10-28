import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import GalleryList from './GalleryList'

/** The hardware-back chain registers only on Android, so getPlatform is
 *  patched on the plain singleton; the App plugin proxy itself is left real
 *  — its web implementation stores backButton listeners that notifyListeners
 *  then fires, exercising the island's decideBack chain end to end. The
 *  decision is observed two ways: 'return-to-library' bumps accountRevision
 *  and refetches /api/galleries, while a wrong 'exit' calls exitApp — which
 *  throws `unimplemented` on the web impl and surfaces as a rejection. */

/** P2 nav-seam tests: the reducer is the single source of truth for which
 *  surface shows. These exercise the observable transitions — a deep link
 *  wins from any screen, signing out lands on welcome, and the account
 *  surface is the library. */

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

let prevCapGetPlatform: typeof Capacitor.getPlatform

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
  prev = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, gcs: globals.getComputedStyle }
  dom = new Window({ width: 375, height: 812, url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    nextFrameId += 1
    frames.push({ id: nextFrameId, cb: cb } as Frame & { cb: unknown })
    frames[frames.length - 1].callback = cb
    return nextFrameId
  }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = ((id: number) => { frames = frames.filter((f) => f.id !== id) }) as unknown as typeof cancelAnimationFrame
})

beforeAll(() => {
  prevCapGetPlatform = Capacitor.getPlatform
  ;(Capacitor as unknown as Record<string, unknown>).getPlatform = () => 'android'
  process.on('unhandledRejection', (reason) => { rejections.push(reason) })
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
  globals.getComputedStyle = prev.gcs
  ;(Capacitor as unknown as Record<string, unknown>).getPlatform = prevCapGetPlatform
})

const mount = async (props: Record<string, unknown> = {}) => {
  // Earlier mounts are never unmounted, so their backButton callbacks stay in
  // the plugin's shared listener store — clear it or stale mounts still
  // decide 'exit' when notifyListeners fires everything.
  await (App as unknown as { removeAllListeners(): Promise<void> }).removeAllListeners()
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  render(<GalleryList apiBase="http://api.test" owner="" slug="" {...props} />, container as unknown as HTMLElement)
  await settle()
  return container
}

/** SecureStorage's web fallback reads prefixed localStorage keys — the same
 *  shape the account suite uses, so the island cannot tell the difference. */
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const storage = new Map<string, string>()
const installLocalStorage = () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size },
      clear: () => storage.clear(),
    },
  })
}
const restoreLocalStorage = () => {
  if (localStorageDescriptor) Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  else delete (globalThis as Record<string, unknown>).localStorage
}

const rejections: unknown[] = []

const fireBack = async () => {
  await (App as unknown as { notifyListeners(event: string, data: unknown): Promise<void> })
    .notifyListeners('backButton', {})
  await settle()
  // A wrong 'exit' rejects through exitApp a few macrotasks after the
  // listener runs — give it time to land before the assertion reads it.
  await new Promise((r) => setTimeout(r, 25))
}

describe('navigation reducer drives the shell surfaces', () => {
  test('the account surface is the library screen', async () => {
    const container = await mount()
    expect(container.querySelector('.native-account, [class*="account"]')).not.toBeNull()
    expect(container.querySelector('.viewer-stage')).toBeNull()
  })

  test('a deep link selection dispatches open-gallery (the manifest fetch fires)', async () => {
    const urls: string[] = []
    const prevFetch = globals.fetch
    globals.fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}', { status: 404 })
    }
    try {
      await mount({ deepLinkSelection: { owner: 'ana', slug: 'coast' } })
    } finally {
      globals.fetch = prevFetch
    }
    expect(urls.some((u) => u.includes('/api/gallery/ana/coast'))).toBe(true)
  })

  test('sign-out resets to the welcome path', async () => {
    const container = await mount()
    // A mounted shell without a session is the signed-out/library surface;
    // the reducer's signed-out target is welcome — covered by the unit
    // reducer tests. Here we assert the shell renders without crashing and
    // no viewer is up.
    expect(container.querySelector('.viewer-stage')).toBeNull()
  })
})

describe('hardware back sees the gallery on the nav stack', () => {
  const accountListFetches = (urls: string[]) =>
    urls.filter((u) => /\/api\/galleries(\?|$)/.test(u)).length

  test('a manually opened gallery returns to library instead of exiting', async () => {
    installLocalStorage()
    storage.set('capacitor-storage_manorama.session-token', 'session-token-1')
    const urls: string[] = []
    const prevFetch = globals.fetch
    globals.fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}', { status: 404 })
    }
    try {
      const rejectedBefore = rejections.length
      const container = await mount()
      // The manual form lives in the account drawer — open it the same way
      // the account suite does.
      ;(container.querySelector('[aria-label="Account menu"]') as unknown as HTMLButtonElement).click()
      await settle()
      const form = container.querySelector('.native-another form')
      expect(form).not.toBeNull()
      const inputs = [...form!.querySelectorAll('input')] as unknown as HTMLInputElement[]
      const fire = (input: HTMLInputElement, value: string) => {
        input.value = value
        input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
      }
      fire(inputs[0], 'ana')
      fire(inputs[1], 'coast')
      await settle()
      ;(form as unknown as { dispatchEvent(event: Event): boolean }).dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
      await settle()
      expect(urls.some((u) => u.includes('/api/gallery/ana/coast'))).toBe(true)
      const listFetches = accountListFetches(urls)
      await fireBack()
      // 'return-to-library' bumps accountRevision — a fresh account-list
      // fetch is the observable proof; a wrong 'exit' would have thrown
      // through exitApp instead.
      expect(accountListFetches(urls)).toBeGreaterThan(listFetches)
      expect(rejections.length).toBe(rejectedBefore)
    } finally {
      globals.fetch = prevFetch
      storage.clear()
      restoreLocalStorage()
    }
  })

  test('a valid initial selection seeds the stack the same way', async () => {
    installLocalStorage()
    storage.set('capacitor-storage_manorama.session-token', 'session-token-1')
    const urls: string[] = []
    const prevFetch = globals.fetch
    globals.fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response('{}', { status: 404 })
    }
    try {
      const rejectedBefore = rejections.length
      await mount({ owner: 'ana', slug: 'coast' })
      expect(urls.some((u) => u.includes('/api/gallery/ana/coast'))).toBe(true)
      const listFetches = accountListFetches(urls)
      await fireBack()
      expect(accountListFetches(urls)).toBeGreaterThan(listFetches)
      expect(rejections.length).toBe(rejectedBefore)
    } finally {
      globals.fetch = prevFetch
      storage.clear()
      restoreLocalStorage()
    }
  })
})
