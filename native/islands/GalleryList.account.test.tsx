import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx'
import GalleryList from './GalleryList'
import type { AdFrame } from '../../packages/core/adframe'
import type { AdPolicyInput } from '../lib/ads'
import type { BillingState, RevenueCatBilling } from '../lib/billing'
import { offlineGalleryId, type OfflineGalleryStore, type OfflineGridGallery } from '../lib/offline-gallery'

/**
 * The account slot is a lifecycle feature — entitlement flips and slow
 * resolutions happen between renders — so it is exercised through a mounted
 * island, not a stringified function. `requestAnimationFrame` is queued by
 * hand (hono flushes effects inside it), which makes every async boundary in
 * these tests a deliberate step instead of a sleep.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousGetComputedStyle: unknown

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

let dom: Window
beforeAll(() => {
  dom = new Window({ width: 375, height: 812, url: 'http://localhost/' })
  previousWindow = globals.window
  previousDocument = globals.document
  previousGetComputedStyle = globals.getComputedStyle
  globals.window = dom
  globals.document = dom.document
  // Bare `getComputedStyle` (fold.ts reads the root style) needs the
  // happy-dom window's copy — it is not global by default.
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  // hono's JSX renderer checks `instanceof SVGElement` for the provider
  // glyphs — another global happy-dom keeps on the window.
  globals.SVGElement = dom.SVGElement
  // The overlay stack checks `instanceof HTMLElement` when it inerts a
  // sheet's sibling chain — the card menu opens one.
  globals.HTMLElement = dom.HTMLElement
  // Sheets also observe their host leaving the document.
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
  // SVGElement stays installed on purpose: once a test in this process renders
  // an <svg>, hono keeps its namespace Context and evaluates `instanceof
  // SVGElement` for every element in every later file — removing it breaks
  // the suites that follow. The rAF pair stays for the same reason: async
  // fetches resolved by clearing the DOM (afterEach wipes innerHTML without
  // running effect cleanup) still schedule hono's post-effect pass, and a
  // restored-to-undefined rAF turns those stray renders into TypeErrors.
})

type Loader = (input: AdPolicyInput) => Promise<AdFrame | null>

const houseFrame = (overrides: Partial<AdFrame> = {}): AdFrame => ({
  id: 'manorama-house-plate',
  advertiser: 'manorama',
  headline: 'More photographs, quietly shared.',
  badge: 'Advertisement',
  provider: 'manorama-house',
  ...overrides,
})

const entitlement = (tier: 'free' | 'pro'): BillingState => ({
  tier,
  isPro: tier === 'pro',
  customerInfo: {} as BillingState['customerInfo'],
})

type Controls = {
  setBilling: (next: BillingState | undefined) => void
  setSurface: (visible: boolean) => void
}

/** Mounts the real island under a harness the test can flip: tier changes and
 *  an unmount are driven from outside, exactly as RevenueCat and navigation
 *  would drive them in the app. */
const mount = (options: { billing?: BillingState; loader?: Loader } = {}) => {
  const controls: Controls = { setBilling: () => {}, setSurface: () => {} }
  const Harness = () => {
    const [billingState, setBillingState] = useState<BillingState | undefined>(options.billing)
    const [visible, setVisible] = useState(true)
    controls.setBilling = setBillingState
    controls.setSurface = setVisible
    return visible ? (
      <GalleryList
        apiBase="https://manorama.xyz"
        billingState={billingState}
        accountAdLoader={options.loader}
        onSignIn={() => {}}
        billing={{} as RevenueCatBilling}
      />
    ) : null
  }
  const container = dom.document.createElement('div') as unknown as HTMLElement
  // happy-dom and the DOM lib each ship a Node type; the runtime object is the
  // same, so cross the boundary at the call site instead of retyping the dom.
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  render(<Harness />, container)
  return { container, controls }
}

const slots = (container: HTMLElement) => container.querySelectorAll('[data-account-ad]')

describe('account slot entitlement', () => {
  test('free renders exactly one labelled house slot from the default policy', async () => {
    const { container } = mount({ billing: entitlement('free') })
    await settle()

    const found = slots(container)
    expect(found).toHaveLength(1)
    const slot = found[0]
    expect(slot.getAttribute('aria-label')).toBe('Advertisement: manorama')
    expect(slot.getAttribute('class')).toContain('native-account-ad')
    expect(slot.textContent).toContain('More photographs, quietly shared.')
    // The label is visible, not only announced.
    expect(slot.textContent).toContain('Advertisement')
    // The house creative's CTA renders like the viewer's plate does: an
    // external, rel-guarded link, never an in-webview navigation.
    const cta = slot.querySelector('a.native-account-ad-cta')
    expect(cta).not.toBeNull()
    expect(cta?.getAttribute('href')).toBe('https://manorama.xyz')
    expect(cta?.getAttribute('target')).toBe('_blank')
    expect(cta?.getAttribute('rel')).toContain('noopener')
    expect(cta?.textContent).toContain('Explore manorama')
  })

  test('pro renders the slot under its own tier — the loader sees pro', async () => {
    const inputs: AdPolicyInput[] = []
    const loader: Loader = async (input) => {
      inputs.push(input)
      return houseFrame()
    }
    const { container } = mount({ billing: entitlement('pro'), loader })
    await settle()

    // House plates are for every tier; Pro's promise is only that no
    // third-party network is ever consulted, which lives in the policy.
    expect(slots(container)).toHaveLength(1)
    expect(inputs).toHaveLength(1)
    expect(inputs[0].tier).toBe('pro')
  })

  test('the master switch hides the slot for a resolved free tier', async () => {
    const inputs: AdPolicyInput[] = []
    const loader: Loader = async (input) => {
      inputs.push(input)
      return houseFrame()
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/api/ads/visibility')) {
        return new Response(JSON.stringify({ show: false, day: '2026-10-01' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch
    try {
      const { container } = mount({ billing: entitlement('free'), loader })
      await settle()

      // The loader is asked with the suppression in effect and resolves to
      // nothing; the render gate independently refuses a stale slot.
      expect(inputs.at(-1)?.visible).toBe(false)
      expect(slots(container)).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('unresolved entitlement renders no slot and never asks for a creative', async () => {
    let requests = 0
    const loader: Loader = async () => {
      requests += 1
      return houseFrame()
    }
    const { container } = mount({ loader })
    await settle()

    expect(slots(container)).toHaveLength(0)
    expect(requests).toBe(0)
  })

  test('free to pro keeps the slot while re-resolving under the new tier', async () => {
    const inputs: AdPolicyInput[] = []
    const loader: Loader = async (input) => {
      inputs.push(input)
      return houseFrame()
    }
    const { container, controls } = mount({ billing: entitlement('free'), loader })
    await settle()
    expect(slots(container)).toHaveLength(1)

    flushSync(() => controls.setBilling(entitlement('pro')))

    // House plates span tiers: the paint that learns Pro keeps the slot —
    // no gap opens in the header where it used to be.
    expect(slots(container)).toHaveLength(1)

    await settle()
    expect(slots(container)).toHaveLength(1)
    expect(inputs.at(-1)?.tier).toBe('pro')
  })
})

describe('account slot resolution lifecycle', () => {
  test('a creative resolved after the tier changed cannot overwrite the new one', async () => {
    const pending: { resolve?: (frame: AdFrame | null) => void }[] = []
    const loader: Loader = () =>
      new Promise((resolve) => {
        pending.push({ resolve })
      })
    const { container, controls } = mount({ billing: entitlement('free'), loader })
    await settle()
    // The request went out while free and is still in flight.
    expect(pending).toHaveLength(1)
    // The plate is reserved from the moment the tier is known, because the
    // live rectangle is positioned from this element's own rect; it carries
    // the house creative until a fill arrives.
    expect(slots(container)).toHaveLength(1)
    expect(container.innerHTML).toContain('More photographs')

    flushSync(() => controls.setBilling(entitlement('pro')))
    await settle()
    // The tier change issues a fresh request under the new tier.
    expect(pending).toHaveLength(2)
    pending[1].resolve?.(houseFrame({ id: 'pro-creative', headline: 'Pro creative' }))
    await settle()

    // The stale free-tier resolution lands after and must not overwrite it.
    pending[0].resolve?.(houseFrame({ id: 'late-creative', headline: 'Late creative' }))
    await settle()
    expect(slots(container)).toHaveLength(1)
    expect(container.innerHTML).toContain('Pro creative')
    expect(container.innerHTML).not.toContain('Late creative')
  })

  test('a creative resolved after unmount cannot resurrect the slot', async () => {
    const pending: { resolve?: (frame: AdFrame | null) => void } = {}
    const loader: Loader = () =>
      new Promise((resolve) => {
        pending.resolve = resolve
      })
    const { container, controls } = mount({ billing: entitlement('free'), loader })
    await settle()
    expect(pending.resolve).toBeDefined()

    flushSync(() => controls.setSurface(false))
    expect(container.innerHTML).toBe('')

    pending.resolve?.(houseFrame({ id: 'post-unmount', headline: 'Post unmount' }))
    await settle()
    expect(container.innerHTML).toBe('')
  })

  test('re-renders do not rotate the creative', async () => {
    let requests = 0
    const loader: Loader = async () => {
      requests += 1
      return houseFrame({ id: `creative-${requests}`, headline: `Creative ${requests}` })
    }
    const { container, controls } = mount({ billing: entitlement('free'), loader })
    await settle()
    expect(slots(container)).toHaveLength(1)
    expect(container.innerHTML).toContain('Creative 1')
    expect(requests).toBe(1)

    // A same-tier billing refresh re-renders the island without changing
    // entitlement...
    flushSync(() => controls.setBilling(entitlement('free')))
    await settle()
    // ...and so does another same-tier billing refresh, the ordinary
    // re-render this page sees while RevenueCat warms up.
    flushSync(() => controls.setBilling(entitlement('free')))
    await settle()

    expect(requests).toBe(1)
    expect(slots(container)).toHaveLength(1)
    expect(container.innerHTML).toContain('Creative 1')
    expect(container.innerHTML).not.toContain('Creative 2')
  })
})

describe('account slot layout contract', () => {
  const accountCss = readFileSync(new URL('../styles/account-ad.css', import.meta.url), 'utf8')

  test('the redesigned Library never hands a live ad adapter to its policy', () => {
    const source = readFileSync(new URL('./GalleryList.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('void accountAdLoader({')
    const end = source.indexOf('}).then', start)
    expect(start).toBeGreaterThan(-1)
    expect(source.slice(start, end)).not.toContain('adapter:')
  })

  test('the card title and menu keep finger-sized targets', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    const titleStart = css.indexOf('.native-gallery-list .lib-card .lib-card-title,')
    const titleRule = css.slice(titleStart, css.indexOf('}', titleStart))
    const menuStart = css.indexOf('.native-gallery-list .lib-card .lib-card-menu,')
    const menuRule = css.slice(menuStart, css.indexOf('}', menuStart))
    expect(titleRule).toContain('min-height: 44px')
    expect(menuRule).toContain('height: 44px')
  })

  test('narrow headers wrap instead of covering the controls', () => {
    // The header wraps when the card is narrow, the slot stays in normal flow
    // (no absolute/fixed positioning that could sit over sign-in, subscription
    // or open-gallery controls), and it is width-bounded by the card.
    expect(accountCss).toContain('flex-wrap: wrap')
    expect(accountCss).not.toContain('position: absolute')
    expect(accountCss).not.toContain('position: fixed')
    const start = accountCss.indexOf('.native-account-ad {')
    expect(start).toBeGreaterThan(-1)
    const end = accountCss.indexOf('}', start)
    const slotRule = accountCss.slice(start, end)
    expect(slotRule).toContain('max-width')
    expect(slotRule).not.toContain('position')
  })

  test('the slot sits in the header, before the provider row it must not cover', async () => {
    const { container } = mount({ billing: entitlement('free') })
    await settle()
    expect(slots(container)).toHaveLength(1)

    const html = container.innerHTML
    const slotAt = html.indexOf('data-account-ad')
    expect(slotAt).toBeGreaterThanOrEqual(0)
    expect(html).toContain('Continue with Apple')
    expect(html).toContain('Continue with Google')
    expect(html).toContain('Continue with Dropbox')
    expect(html.indexOf('Continue with Apple')).toBeLessThan(html.indexOf('Continue with Dropbox'))
    expect(html.indexOf('native-welcome')).toBeLessThan(slotAt)
    expect(html.indexOf('native-welcome-provider')).toBeGreaterThan(slotAt)
    // The opening screen is the sign-in door alone — the manual form and the
    // gallery shortcuts wait behind sign-in.
    expect(container.querySelector('form')).toBeNull()
    expect(container.innerHTML).not.toContain('Global view')
    expect(container.innerHTML).not.toContain('See price in the App Store')
  })
})

describe('signed-in account area', () => {
  const TOKEN_KEY = 'capacitor-storage_manorama.session-token'
  const SLUG_KEY = 'capacitor-storage_manorama.owner-slug'
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalFetch = globalThis.fetch
  let storage: Map<string, string>
  let calls: { url: string; init?: RequestInit }[] = []

  /** SecureStorage's web fallback reads prefixed localStorage keys — the
   *  same shape the browser preview produces, so the island cannot tell the
   *  difference. */
  const installLocalStorage = () => {
    storage = new Map<string, string>()
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
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
    } else {
      delete (globalThis as Record<string, unknown>).localStorage
    }
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  type ApiStubs = {
    galleries?: Response | Promise<Response>
    deviceGalleries?: Response
    import?: () => Response
    mutation?: (url: string, init?: RequestInit) => Response | undefined
    visibility?: Response
    suppressions?: Response
    fallback?: (url: string, init?: RequestInit) => Response
  }
  const stubFetch = (stubs: ApiStubs = {}) => {
    calls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      calls.push({ url, init })
      if (url.includes('/api/galleries') && init?.method === 'POST' && stubs.import) return stubs.import()
      if (init?.method && init.method !== 'GET' && stubs.mutation) {
        const response = stubs.mutation(url, init)
        if (response) return response
      }
      if (url.includes('/api/device-galleries')) return stubs.deviceGalleries ?? json({ galleries: [] })
      if (url.includes('/api/galleries')) return (await stubs.galleries)?.clone() ?? json({ galleries: [] })
      if (url.includes('/api/ads/visibility')) return stubs.visibility ?? json({ show: true, day: '2026-10-01' })
      // The suppression list is session-gated: an unanswered list leaves the
      // switch unrendered, which is the state every other test runs in.
      if (url.includes('/api/ads/suppressions')) return stubs.suppressions ?? new Response('{}', { status: 404 })
      if (stubs.fallback) return stubs.fallback(url, init)
      return new Response('{}', { status: 404 })
    }) as typeof fetch
  }

  const accountSummary = (overrides: Record<string, unknown> = {}) => ({
    slug: 'kashmir',
    title: 'Kashmir',
    caption: '',
    date: '',
    imageCount: 12,
    sourceUrl: null,
    createdAt: null,
    retention: 'retained',
    expiresAt: null,
    images: [],
    ...overrides,
  })

  const deviceGallery = (overrides: Record<string, unknown> = {}) => ({
    id: '12345678-1234-1234-1234-1234567890ab',
    title: 'Living room folder',
    sourceKind: 'folder',
    itemCount: 34,
    deviceId: '87654321-4321-4321-4321-ba0987654321',
    deviceLabel: "Mahesh's Mac Studio",
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  })

  const mountAccount = (options: { billing?: BillingState; client?: RevenueCatBilling; store?: OfflineGalleryStore; linkConflict?: string; onClearLinkConflict?: () => void } = {}) => {
    const Harness = () => {
      const [billingState] = useState<BillingState | undefined>(options.billing)
      return (
        <GalleryList
          apiBase="https://manorama.xyz"
          billingState={billingState}
          onSignIn={() => {}}
          billing={options.client}
          offlineStore={options.store}
          linkConflict={options.linkConflict}
          onClearLinkConflict={options.onClearLinkConflict}
        />
      )
    }
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<Harness />, container)
    return { container }
  }

  const openAddForm = async (container: HTMLElement) => {
    const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add') as HTMLButtonElement
    trigger.click()
    await settle()
    return container.querySelector('#m-add-gallery-form') as HTMLFormElement
  }

  /** The topbar gear is the only account affordance — one tap opens the full
   *  Settings screen; the drawer and its second door are gone. */
  const openSettings = async (container: HTMLElement) => {
    const gear = container.querySelector('[aria-label="Settings"]') as HTMLButtonElement
    expect(gear).not.toBeNull()
    gear.click()
    await settle()
  }

  const signInStorage = () => {
    storage.set(TOKEN_KEY, 'session-token-1')
    storage.set(SLUG_KEY, 'quiet-owner')
  }

  const galleryCalls = () => calls.filter((call) => call.url.includes('/api/gallery/'))

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreLocalStorage()
    dom.document.body.innerHTML = ''
  })

  test('lists the account galleries and tapping one opens it under the owner slug', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({
      caption: 'A winter album',
      images: [
        { id: 'first', ref: 'first', filename: 'first.jpg', src: 'https://cdn.example/first.jpg', width: 1200, height: 800 },
        { id: 'second', ref: 'second', filename: 'second.jpg', src: 'https://cdn.example/second.jpg', width: 800, height: 1200 },
      ],
    })] }) })
    const { container } = mountAccount()
    await settle()

    const html = container.innerHTML
    expect(html).toContain('Library')
    // The account workbench is gone: no overview, no inline address field —
    // Settings › Account owns the URL, the quiet foot line owns the plan.
    expect(container.querySelector('.native-account-overview')).toBeNull()
    expect(container.querySelector('.native-account-left')).toBeNull()
    expect(container.querySelector('.admin-owner-slug-input')).toBeNull()
    expect(container.querySelector('.native-list-card')).not.toBeNull()
    expect(html).not.toContain('Hello,')
    expect(html).not.toContain('You are a Free User')
    // The status line under the heading reports vault state first — kept
    // means a complete committed copy, and nothing is saved yet.
    expect(container.querySelector('.native-library-finding')?.textContent).toBe('1 gallery, 0 kept on this iPhone.')
    expect(html).toContain('Kashmir')
    expect(html).toContain('A winter album')
    expect(html).toContain('kashmir')
    expect(html).toContain('12 photographs')
    // The topbar gear is the only account affordance — the drawer is gone.
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('aria-label="Account menu"')
    expect(html).not.toContain('data-account-drawer')
    // Both fixture images ride the rail — every photograph, not a cover.
    expect(container.querySelectorAll('.lib-rail .lib-th')).toHaveLength(2)
    expect(html).not.toContain('sequence only')
    // Sign out waits inside Settings, reached by the gear directly.
    await openSettings(container)
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Sign out')).toBe(true)
    ;(container.querySelector('[aria-label="Back to the library"]') as HTMLButtonElement).click()
    await settle()
    // Signed-in home replaces the provider row; Settings never shows a
    // manual open form — deep links cover shared galleries.
    expect(html).not.toContain('Sign in with Apple')
    expect(container.querySelector('main')?.textContent).not.toContain('Open another gallery')

    // The account list asked with the stored bearer token.
    const listCall = calls.find((call) => call.url === 'https://manorama.xyz/api/galleries')
    expect((listCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')

    // The rail is the card's opener: every thumbnail leads to the viewer at
    // its own position. The vault is absent in this DOM, so the cells fall
    // back to the provider previews the summary already carries.
    const rail = container.querySelector('.lib-rail') as HTMLElement | null
    expect(rail).not.toBeNull()
    const thumbs = [...rail!.querySelectorAll<HTMLButtonElement>('.lib-th')]
    expect(thumbs.map((thumb) => thumb.querySelector('img')?.getAttribute('src')))
      .toEqual(['https://cdn.example/first.jpg', 'https://cdn.example/second.jpg'])
    // One article per gallery: rail, title row, metadata, caption. The card
    // carries no address — the sub line ends on the device word.
    const card = rail!.closest('.lib-card') as HTMLElement
    const order = [...card.children].map((child) => child.className.split(' ')[0])
    expect(order).toEqual(['lib-rail', 'lib-card-head', 'lib-card-sub', 'native-gallery-caption'])
    expect(card.querySelector('.lib-card-sub')?.textContent).toContain('12 photographs')
    expect(card.querySelector('.lib-card-sub')?.textContent).toContain('gallery')
    expect(card.querySelector('.native-gallery-caption')?.textContent).toBe('A winter album')
    expect(card.querySelector('.native-gallery-link')).toBeNull()

    // Reorder lives in the card's ··· menu now, behind its own sheet.
    ;(container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    await settle()
    const menu = [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
    ;(menu.find((item) => item.textContent === 'Reorder photographs'))!.click()
    await settle()
    expect(container.querySelector('[data-gallery-editor]')).not.toBeNull()
    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir')).toBe(true)
    ;(container.querySelector('[data-gallery-editor] .native-editor-cancel') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('[data-gallery-editor]')).toBeNull()

    // The title opens the gallery on the stage — the card's most obvious
    // affordance has to lead to the viewer. It cannot be exercised afterwards
    // because the stage replaces the list.
    ;(card.querySelector('.lib-card-title') as HTMLButtonElement).click()
    await settle()
    expect(galleryCalls().filter((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir').length)
      .toBeGreaterThanOrEqual(2)

    // The account controls live in Settings behind the topbar gear.
    await openSettings(container)
    const settingsHtml = container.innerHTML
    expect(settingsHtml).toContain('Photo picker')
    expect(settingsHtml).toContain('Let galleries show photographs already saved on this iPhone')
    // The picker opens from Settings only when the expanded mode is on.
    expect(settingsHtml).not.toContain('Open photo picker')
  })

  test('PATCHes an edited address from Settings', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary()] }),
      fallback: (url, init) => {
        if (url === 'https://manorama.xyz/api/account/identities') {
          return json({ identities: [{ provider: 'dropbox', displayName: 'Mahesh Shantaram' }] })
        }
        if (url === 'https://manorama.xyz/api/account' && init?.method === 'PATCH') {
          return json({ ownerSlug: 'fieldnotes' })
        }
        if (url === 'https://manorama.xyz/api/account') return json({ ownerSlug: 'quiet-owner' })
        return new Response('{}', { status: 404 })
      },
    })
    const { container } = mountAccount()
    await settle()

    const html = container.innerHTML
    // The greeting is gone from the Library — account copy lives in Settings.
    expect(html).not.toContain('Hello,')
    expect(html).not.toContain('You are a Free User')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('aria-label="Account menu"')
    expect(html).not.toContain('data-account-drawer')
    expect(html).not.toContain('This is your manoramic world')

    await openSettings(container)
    expect(container.querySelector('[data-account-drawer]')).toBeNull()
    expect(container.innerHTML).toContain('Privacy Policy')
    const input = container.querySelector('#settings-owner-address') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.value).toBe('quiet-owner')
    input!.value = 'fieldnotes'
    input!.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    // The blur handler reads ownerSlugDraft; let the input's setState re-render
    // rebind the listener with the fresh closure before dispatching blur.
    await settle()
    input!.dispatchEvent(new dom.Event('blur') as unknown as Event)
    await settle()

    const patch = calls.find((call) => call.url === 'https://manorama.xyz/api/account' && call.init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ ownerSlug: 'fieldnotes' })
    expect(storage.get(SLUG_KEY)).toBe('fieldnotes')
    expect(container.innerHTML).toContain('Your address is now manorama.xyz/fieldnotes')
  })

  test('renders the device catalogue; only a public slug is tappable', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      deviceGalleries: json({
        galleries: [
          deviceGallery(),
          deviceGallery({
            id: 'abcdefab-1234-1234-1234-1234567890ab',
            title: 'Field card',
            sourceKind: 'card',
            itemCount: 9,
            deviceId: 'fedcba98-4321-4321-4321-ba0987654321',
          }),
          deviceGallery({
            id: 'aaaabbbb-1234-1234-1234-1234567890ab',
            title: 'Published selects',
            sourceKind: 'folder',
            itemCount: 21,
            deviceId: 'bbbbaaaa-4321-4321-4321-ba0987654321',
            publicGallerySlug: 'mac-light',
          }),
        ],
      }),
    })
    const { container } = mountAccount()
    await settle()

    await openSettings(container)
    const html = container.innerHTML
    expect(html).toContain('This iPhone')
    // The web dashboard's "Mac" is the wrong word in an iOS app, and the list
    // is whatever device the account last published from.
    expect(html).not.toContain('On your Mac')
    expect(html).toContain('Living room folder')
    expect(html).toContain('Field card')
    expect(html).toContain('Published selects')
    // Raw device metadata never reaches the DOM.
    expect(html).not.toContain('87654321')
    expect(html).not.toContain('fedcba98')

    const items = [...container.querySelectorAll('.m-actionrow')]
    const rowsFor = (title: string) => items.find((item) => item.textContent?.includes(title))
    expect(rowsFor('Living room folder')?.textContent).toContain('34 photographs')
    expect(rowsFor('Field card')?.textContent).toContain('9 photographs')
    // Naked rows stay static; a published slug turns the row itself into the
    // button that opens the gallery.
    expect(rowsFor('Living room folder')?.tagName).not.toBe('BUTTON')
    expect(rowsFor('Field card')?.tagName).not.toBe('BUTTON')
    const tappable = rowsFor('Published selects') as HTMLElement | null
    expect(tappable?.tagName).toBe('BUTTON')

    tappable!.click()
    await settle()
    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/mac-light')).toBe(true)
  })

  test('groups the account preferences and names what each switch hides', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary()] }),
      // The visibility answer carries the ISO country code the Worker reads.
      visibility: json({ show: true, day: '2026-10-01', region: 'IN' }),
      suppressions: json({ suppressions: [{ kind: 'day', value: '2026-10-01' }] }),
    })
    const { container } = mountAccount()
    await settle()

    expect(container.querySelector('main .native-load-policy')).toBeNull()
    expect(container.textContent).not.toContain('How galleries load')
    await openSettings(container)
    // Each preference is its own headed question rather than one undifferentiated
    // list running from the device down to the load policy.
    const headings = [...container.querySelectorAll('.m-actiongroup-label')].map((heading) => heading.textContent)
    expect(headings).toContain('House cards')
    expect(headings).toContain('This iPhone')

    // The new-galleries segment names what it governs.
    const policy = container.querySelector('[role="radiogroup"][aria-label="New galleries"]') as HTMLElement
    expect(policy).not.toBeNull()
    const policyOptions = [...policy.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]
    expect(policyOptions.map((option) => option.textContent)).toEqual([
      'Keep a copy',
      'Stream only',
    ])
    expect(policyOptions.map((option) => option.getAttribute('aria-checked'))).toEqual(['true', 'false'])

    // The picker switch carries its plain-language description.
    const pickerRow = [...container.querySelectorAll('.m-actionrow')]
      .find((row) => row.textContent?.includes('Photo picker')) as HTMLElement
    const picker = pickerRow?.querySelector('[role="switch"]') as HTMLButtonElement
    expect(picker).not.toBeNull()
    expect(picker.textContent).toContain('Let galleries show photographs already saved on this iPhone')

    // The house-card status and the buttons say what they hide.
    const houseCards = [...container.querySelectorAll('.m-actiongroup-label')]
      .find((heading) => heading.textContent === 'House cards')?.closest('section') as HTMLElement
    expect(houseCards.querySelector('.m-note')?.textContent).toBe('House cards shown · 2026-10-01 · India')
    expect([...houseCards.querySelectorAll('.m-actionrow')].map((row) => row.textContent))
      .toEqual(['Show again today', 'Hide in India'])

    // The internal vocabulary the owner flagged never reaches the screen.
    const html = container.innerHTML
    expect(html).toContain('Everything stays encrypted and on the device.')
    expect(html).not.toContain('the gallery picker')
    expect(html).not.toContain('Plates')
    expect(html).not.toContain('Hide today')
    expect(html).not.toContain('Gallery loading')
  })

  test('a gallery card reads in one column, in the order it is managed', async () => {
    installLocalStorage()
    signInStorage()
    const cover = [
      { id: 'first', ref: 'first', filename: 'first.jpg', src: 'https://cdn.example/first.jpg', width: 1200, height: 800 },
    ]
    stubFetch({ galleries: json({ galleries: [
      accountSummary({ slug: 'kashmir', title: 'Kashmir', images: cover }),
      accountSummary({ slug: 'italy', title: 'Italy', images: cover }),
    ] }) })
    const { container } = mountAccount()
    await settle()
    const cards = [...container.querySelectorAll('.native-gallery-list > li .lib-card')]
    expect(cards.length).toBe(2)
    for (const card of cards) {
      // The photographs lead, then the title row with its ··· menu, then the
      // count·source·device metadata and the caption — one column, top-down.
      const order = [...card.children].map((child) => child.className.split(' ')[0])
      const at = (needle: string) => order.findIndex((name) => name === needle || name.startsWith(needle))
      expect(at('lib-rail')).toBe(0)
      expect(at('lib-card-head')).toBeGreaterThan(at('lib-rail'))
      expect(at('lib-card-sub')).toBeGreaterThan(at('lib-card-head'))
      expect(at('native-gallery-link')).toBe(-1)
      // Every photograph rides the rail — not a single cover.
      expect(card.querySelectorAll('.lib-rail .lib-th')).toHaveLength(1)
      // One menu button per card; the per-action buttons live in its sheet.
      expect(card.querySelectorAll('.lib-card-menu')).toHaveLength(1)
      expect(card.querySelector('.native-gallery-actions')).toBeNull()
    }
  })

  test('gallery actions live in the card menu and deletion waits for confirmation', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ sourceUrl: 'https://dropbox.com/scl/fo/example' })] }) })
    const { container } = mountAccount()
    await settle()
    // The card shows no action row — only the ··· affordance.
    expect(container.querySelector('.native-gallery-actions')).toBeNull()
    expect(container.querySelector('[role="menuitem"]')).toBeNull()
    ;(container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    await settle()
    const items = [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
    expect(items.map((item) => item.textContent)).toEqual([
      'Share link', 'Gallery details', 'Reorder photographs', 'Read the folder again', 'Remove gallery',
    ])
    ;(items.find((item) => item.textContent === 'Remove gallery'))!.click()
    await settle()
    expect(container.textContent).toContain('This cannot be undone')
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
    const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel') as HTMLButtonElement
    cancel.click()
    await settle()
    expect(container.querySelector('.native-gallery-remove-confirm')).toBeNull()
  })

  test('confirmed gallery delete and refresh use owner-authenticated API routes', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ sourceUrl: 'https://dropbox.com/scl/fo/example' })] }),
      fallback: (url) => url.includes('/api/galleries/kashmir') ? json({ ok: true }) : new Response('{}', { status: 404 }) })
    const { container } = mountAccount()
    await settle()
    const openMenu = () => {
      (container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    }
    const menuItem = (label: string) =>
      [...container.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === label) as HTMLButtonElement
    openMenu()
    await settle()
    menuItem('Read the folder again').click()
    await settle()
    const refresh = calls.find((call) => call.url.endsWith('/api/galleries/kashmir/refresh'))
    expect(refresh?.init?.method).toBe('POST')
    expect((refresh?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    openMenu()
    await settle()
    menuItem('Remove gallery').click()
    await settle()
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Remove gallery') as HTMLButtonElement
    confirm.click()
    await settle()
    const deletion = calls.find((call) => call.url.endsWith('/api/galleries/kashmir') && call.init?.method === 'DELETE')
    expect(deletion).toBeDefined()
    expect((deletion?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    expect(calls.some((call) => call.url.startsWith('https://dropbox.com'))).toBe(false)
  })

  test('Free owners can see every retained gallery even above their editing limit', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: Array.from({ length: 5 }, (_, index) => accountSummary({ slug: `album-${index}`, title: `Album ${index}` })) }) })
    const { container } = mountAccount({ billing: entitlement('free') })
    await settle()
    expect(container.querySelectorAll('.native-gallery-list > li')).toHaveLength(5)
    // The plan line at the foot is the warning now — every gallery still lists.
    const foot = container.querySelector('.native-lib-foot')
    expect(foot?.textContent).toContain('All 5 of 3 free galleries used.')
    expect(foot?.textContent).toContain('Go Visionary')
    expect(container.querySelectorAll('.lib-th.is-active')).toHaveLength(0)
    expect(container.querySelector('main .native-account-delete')).toBeNull()
  })

  test('names pipeline galleries without a shortened internal label', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ retention: 'pipeline' })] }) })
    const { container } = mountAccount()
    await settle()
    expect(container.querySelector('.native-gallery-list')?.textContent).toContain('Temporary gallery')
    expect(container.innerHTML).not.toContain('Temp Galleries')
  })

  test('a failed account list shows a quiet retry', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ error: 'The gallery list is temporarily unavailable' }, 503) })
    const { container } = mountAccount()
    await settle()

    const html = container.innerHTML
    expect(html).toContain('Your galleries could not be loaded.')
    expect(html).toContain('Try again')
    // Settings carries no open form even when the list is dead.
    expect(container.querySelector('main')?.textContent).not.toContain('Open another gallery')

    const listCalls = () => calls.filter((call) => call.url === 'https://manorama.xyz/api/galleries').length
    expect(listCalls()).toBe(1)
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again') as HTMLButtonElement
    retry.click()
    await settle()
    expect(listCalls()).toBe(2)
    expect(container.innerHTML).toContain('Your galleries could not be loaded.')

    await openSettings(container)
    expect(container.querySelector('#settings-owner-address')).not.toBeNull()
  })

  test('cached galleries paint before the account list resolves', async () => {
    installLocalStorage()
    signInStorage()
    let resolveAccount!: (response: Response) => void
    const accountResponse = new Promise<Response>((resolve) => { resolveAccount = resolve })
    stubFetch({ galleries: accountResponse })
    const grid: OfflineGridGallery = {
      galleryId: 'offline-gallery:v1:cached',
      owner: 'quiet-owner',
      slug: 'saved-album',
      title: 'Saved Album',
      frames: [{ id: 'cached-one', entryId: 'thumb:cached-one', mimeType: 'image/jpeg', width: 1200, height: 800, alt: 'Cached photograph', index: 0 }],
    }
    const store = {
      listGalleries: async () => [{ status: 'cached', galleryId: grid.galleryId, owner: grid.owner, slug: grid.slug, title: grid.title, images: 1 }],
      listGridGalleries: async () => [grid],
      readThumbnail: async () => undefined,
    } as unknown as OfflineGalleryStore
    const { container } = mountAccount({ store })
    await settle()

    const card = container.querySelector('[data-cached-gallery="saved-album"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Offline copy complete')
    expect(card?.textContent).toContain('account list pending')
    expect(calls.some((call) => call.url.includes('cdn.example') || call.url.includes('/api/dropbox/file'))).toBe(false)

    resolveAccount(json({ galleries: [] }))
    await settle()
    expect(container.querySelector('[data-cached-gallery="saved-album"]')?.textContent).toContain('not in the online account list')
  })

  test('the kept count follows committed copies, not the stream-only flag', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ slug: 'kashmir' })] }) })
    // A committed vault copy: status cached, images meeting the list's count.
    const kashmirId = await offlineGalleryId({ owner: 'quiet-owner', slug: 'kashmir' })
    const store = {
      listGalleries: async () => [
        { status: 'cached', galleryId: kashmirId, owner: 'quiet-owner', slug: 'kashmir', title: 'Kashmir', images: 12 },
      ],
      listGridGalleries: async () => [],
      readThumbnail: async () => undefined,
    } as unknown as OfflineGalleryStore
    const { container } = mountAccount({ store })
    await settle()

    expect(container.querySelector('.native-library-finding')?.textContent).toBe('1 gallery, 1 kept on this iPhone.')
    // The card agrees — the same predicate drives its device word.
    expect(container.querySelector('.lib-card-sub')?.textContent).toContain('On this iPhone')
  })

  test('sign out clears the session, the owner slug, and billing', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    let billingSignedOut = false
    const client = {
      signOut: async () => {
        billingSignedOut = true
      },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ client })
    await settle()

    await openSettings(container)
    const signOut = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Sign out') as HTMLButtonElement
    expect(signOut).toBeDefined()
    signOut.click()
    await settle()

    // window.location.reload is a no-op in happy-dom; the storage teardown is
    // the contract that matters here.
    expect(billingSignedOut).toBe(true)
    expect(storage.has(TOKEN_KEY)).toBe(false)
    expect(storage.has(SLUG_KEY)).toBe(false)
  })

  test('delete account asks once, then clears the session and billing', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      fallback: (url) => url === 'https://manorama.xyz/api/account'
        ? json({ ok: true })
        : new Response('{}', { status: 404 }),
    })
    let billingSignedOut = false
    const client = {
      signOut: async () => {
        billingSignedOut = true
      },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ client })
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    expect(entry).toBeDefined()
    entry.click()
    await settle()

    expect(container.innerHTML).toContain('Nothing at the source is touched')
    expect(container.innerHTML).toContain('Settings › Subscriptions')
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently') as HTMLButtonElement
    expect(confirm).toBeDefined()
    confirm.click()
    await settle()

    const deletion = calls.find((call) => call.url === 'https://manorama.xyz/api/account')
    expect(deletion).toBeDefined()
    expect(deletion?.init?.method).toBe('DELETE')
    expect(JSON.parse(String(deletion?.init?.body))).toEqual({ confirm: 'quiet-owner' })
    expect((deletion?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')

    // window.location.reload is a no-op in happy-dom; the storage teardown is
    // the contract that matters here.
    expect(billingSignedOut).toBe(true)
    expect(storage.has(TOKEN_KEY)).toBe(false)
    expect(storage.has(SLUG_KEY)).toBe(false)
  })

  test('the delete confirmation can be dismissed without a request', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const { container } = mountAccount()
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()
    expect(container.innerHTML).toContain('Delete permanently')

    const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Cancel') as HTMLButtonElement
    cancel.click()
    await settle()

    expect(calls.some((call) => call.url === 'https://manorama.xyz/api/account')).toBe(false)
    expect(container.innerHTML).not.toContain('Delete permanently')
    expect(storage.has(TOKEN_KEY)).toBe(true)
  })

  test('a failed deletion keeps the session and says so', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      fallback: (url) => url === 'https://manorama.xyz/api/account'
        ? json({ error: 'Your account could not be deleted right now' }, 503)
        : new Response('{}', { status: 404 }),
    })
    const { container } = mountAccount()
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently') as HTMLButtonElement
    confirm.click()
    await settle()

    expect(container.innerHTML).toContain('Your account could not be deleted right now')
    expect(storage.has(TOKEN_KEY)).toBe(true)
    expect(storage.has(SLUG_KEY)).toBe(true)
  })

  test('a missing URL name is recovered before the delete runs', async () => {
    installLocalStorage()
    // Token but no stored slug — the session predates slug persistence.
    storage.set(TOKEN_KEY, 'session-token-1')
    stubFetch({
      fallback: (url, init) => {
        if (url !== 'https://manorama.xyz/api/account') return new Response('{}', { status: 404 })
        return init?.method === 'DELETE' ? json({ ok: true }) : json({ ownerSlug: 'quiet-owner' })
      },
    })
    const { container } = mountAccount()
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()

    // The recovered slug is persisted before the confirm opens — the delete
    // itself will clear it again along with the token.
    expect(storage.get(SLUG_KEY)).toBe('quiet-owner')
    // Recovery fills both the stored address and the editable draft, so the
    // owner is never stranded with a permanently disabled confirmation.
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await settle()

    const deletion = calls.find((call) => call.url === 'https://manorama.xyz/api/account' && call.init?.method === 'DELETE')
    expect(JSON.parse(String(deletion?.init?.body))).toEqual({ confirm: 'quiet-owner' })
  })

  test('an unrecoverable URL name keeps deletion disabled and says why', async () => {
    installLocalStorage()
    storage.set(TOKEN_KEY, 'session-token-1')
    stubFetch({
      fallback: (url) => url === 'https://manorama.xyz/api/account'
        ? json({})
        : new Response('{}', { status: 404 }),
    })
    const { container } = mountAccount()
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()

    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(container.innerHTML).toContain('could not be recovered')
    expect(calls.some((call) => call.url === 'https://manorama.xyz/api/account' && call.init?.method === 'DELETE')).toBe(false)
  })

  test('a failed billing sign-out after deletion is reported and retriable', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      fallback: (url) => url === 'https://manorama.xyz/api/account'
        ? json({ ok: true })
        : new Response('{}', { status: 404 }),
    })
    let attempts = 0
    const client = {
      signOut: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('revenuecat offline')
      },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ client })
    await settle()

    await openSettings(container)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete permanently') as HTMLButtonElement
    confirm.click()
    await settle()

    // The account row is gone and the local session is torn down — but the
    // unfinished billing cleanup is reported rather than reloaded over.
    expect(container.innerHTML).toContain('billing sign-out did not finish')
    expect(storage.has(TOKEN_KEY)).toBe(false)

    // A retry owes only the billing cleanup, not a second delete.
    confirm.click()
    await settle()
    expect(attempts).toBe(2)
    const deletes = calls.filter((call) => call.url === 'https://manorama.xyz/api/account' && call.init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
  })

  test('a link conflict surfaces on the Library and clears when linking again', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    let cleared = 0
    const { container } = mountAccount({
      linkConflict: 'That identity is linked to a different account',
      onClearLinkConflict: () => { cleared += 1 },
    })
    await settle()

    // A cold-start conflict lands on the Library — Settings may never mount.
    expect(container.textContent).toContain('That identity is linked to a different account')

    await openSettings(container)
    expect(container.textContent).toContain('That identity is linked to a different account')
    const linkButtons = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Link')
    if (linkButtons.length > 0) {
      linkButtons[0].click()
      await settle()
      expect(cleared).toBe(1)
    }
  })

  test('the gear opens Settings directly in one tap', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const { container } = mountAccount()
    await settle()

    // No drawer, no intermediate menu: the topbar gear is the only affordance
    // and it lands on the full Settings screen.
    expect(container.querySelector('[aria-label="Account menu"]')).toBeNull()
    await openSettings(container)
    expect(container.querySelector('#settings-owner-address')).not.toBeNull()
    expect(container.textContent).toContain('Privacy Policy')
    expect(container.textContent).toContain('Sign out')
    // Shared galleries arrive by deep link — Settings carries no open form.
    expect(container.textContent).not.toContain('Open another gallery')
  })

  for (const status of [200, 409]) {
    test(`the visible cloud-link form opens the ${status === 409 ? 'existing' : 'created'} gallery without duplicate POSTs`, async () => {
      installLocalStorage()
      signInStorage()
      stubFetch({ import: () => json({ galleryUrl: '/quiet-owner/imported' }, status) })
      const { container } = mountAccount()
      await settle()
      const form = await openAddForm(container)
      const input = form.querySelector('input[type="url"]') as HTMLInputElement
      expect(input.type).toBe('url')
      expect(input.required).toBe(true)
      expect(input.getAttribute('autocapitalize')).toBe('none')
      input.value = ' https://mega.nz/folder/example#keep-the-key '
      input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
      const name = form.querySelector('input[type="text"]') as HTMLInputElement
      name.value = 'Named Album'
      name.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
      await settle()
      form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
      form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
      await settle()
      const imports = calls.filter((call) => call.init?.method === 'POST' && call.url.endsWith('/api/galleries'))
      expect(imports).toHaveLength(1)
      expect(JSON.parse(String(imports[0].init?.body))).toEqual({ url: 'https://mega.nz/folder/example#keep-the-key', title: 'Named Album' })
      expect((imports[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
      expect(galleryCalls().some((call) => call.url.endsWith('/quiet-owner/imported'))).toBe(true)
    })
  }

  test('a rejected cloud link remains editable with one actionable error', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ import: () => json({ error: 'Share a public folder first.' }, 422) })
    const { container } = mountAccount()
    await settle()
    const form = await openAddForm(container)
    const input = form.querySelector('input[type="url"]') as HTMLInputElement
    input.value = 'https://drive.google.com/drive/folders/private'
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
    form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    await settle()
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Share a public folder first.')
    expect(input.value).toBe('https://drive.google.com/drive/folders/private')
    expect(input.disabled).toBe(false)
    expect((container.querySelector('.m-sheet-foot button[type="submit"]') as HTMLButtonElement).disabled).toBe(false)
  })

  test('an empty offering answers honestly instead of opening a dead paywall', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    let presented = 0
    const client = {
      offerings: async () => null,
      presentPaywallIfNeeded: async () => { presented += 1; return { state: { tier: 'free', isPro: false, customerInfo: {} } } },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    await openSettings(container)
    const learn = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Go Visionary') as HTMLButtonElement
    expect(learn).toBeDefined()
    learn.click()
    await settle()
    // Visiting the Visionary introduction never touches the store.
    expect(presented).toBe(0)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'See price in the App Store') as HTMLButtonElement
    expect(entry).toBeDefined()
    entry.click()
    await settle()

    expect(container.innerHTML).toContain('Subscriptions are unavailable right now. Please try again shortly.')
    // No offering means no store handoff, ever.
    expect(presented).toBe(0)
  })

  test('an unreachable offering answers the same honest note', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    let presented = 0
    const client = {
      offerings: async () => {
        throw new Error('StoreKit unavailable')
      },
      presentPaywallIfNeeded: async () => { presented += 1; return { state: { tier: 'free', isPro: false, customerInfo: {} } } },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    await openSettings(container)
    const learn = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Go Visionary') as HTMLButtonElement
    learn.click()
    await settle()
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'See price in the App Store') as HTMLButtonElement
    entry.click()
    await settle()

    // The reason surfaces honestly, and the store is never handed off.
    expect(container.innerHTML).toContain('StoreKit unavailable')
    expect(presented).toBe(0)
  })

  test('a real offering still opens the paywall', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const info = {} as BillingState['customerInfo']
    let presented = 0
    const client = {
      currentState: { tier: 'free', isPro: false, customerInfo: info },
      offerings: async () => ({ availablePackages: [{}] }),
      presentPaywallIfNeeded: async () => { presented += 1; return { result: 'NOT_PRESENTED', state: { tier: 'free', isPro: false, customerInfo: info } } },
      presentCustomerCenter: async () => ({ tier: 'free', isPro: false, customerInfo: info }),
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    await openSettings(container)
    const learn = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Go Visionary') as HTMLButtonElement
    learn.click()
    await settle()
    // The store stays closed until the explicit CTA inside Visionary.
    expect(presented).toBe(0)
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'See price in the App Store') as HTMLButtonElement
    entry.click()
    await settle()

    expect(presented).toBe(1)
    expect(container.innerHTML).toContain('You can review the options in the store whenever you are ready.')
    expect(container.innerHTML).not.toContain('Subscriptions are unavailable right now. Please try again shortly.')
  })

  test('Details rescans with a session-only timestamp', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary({ sourceUrl: 'https://www.dropbox.com/sh/example', createdAt: '2026-01-01T00:00:00Z' })] }),
      mutation: (url, init) => url === 'https://manorama.xyz/api/galleries/kashmir/refresh' && init?.method === 'POST'
        ? json({ gallery: accountSummary({ sourceUrl: 'https://www.dropbox.com/sh/example' }) })
        : undefined,
    })
    const { container } = mountAccount()
    await settle()
    ;(container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    await settle()
    ;([...container.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Gallery details') as HTMLButtonElement).click()
    await settle()
    const refresh = [...container.querySelectorAll('.m-actionrow')].find((row) => row.textContent === 'Read the folder again') as HTMLButtonElement
    refresh.click()
    await settle()
    const call = calls.find((entry) => entry.url === 'https://manorama.xyz/api/galleries/kashmir/refresh')
    expect(call?.init?.method).toBe('POST')
    expect((call?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    expect(container.querySelector('[data-screen="details"]')?.textContent).toContain('Read just now')
    expect(container.querySelector('[data-screen="details"]')?.textContent).not.toContain('2026-01-01')
  })

  test('Details keeps the positive download switch and provider-neutral removal', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary({ sourceUrl: 'https://www.icloud.com/sharedalbum/#TOKEN' })] }),
      mutation: (url, init) => url === 'https://manorama.xyz/api/galleries/kashmir' && init?.method === 'DELETE'
        ? json({ ok: true })
        : undefined,
    })
    const { container } = mountAccount()
    await settle()
    ;(container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    await settle()
    ;([...container.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Gallery details') as HTMLButtonElement).click()
    await settle()
    const keep = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(keep.getAttribute('aria-checked')).toBe('true')
    keep.click()
    await settle()
    expect(keep.getAttribute('aria-checked')).toBe('false')
    ;([...container.querySelectorAll('.m-actionrow')].find((row) => row.textContent?.includes('Remove gallery')) as HTMLButtonElement).click()
    await settle()
    const confirmation = container.querySelector('.m-sheet') as HTMLElement
    expect(confirmation.textContent).toContain('Originals remain at their source')
    expect(confirmation.textContent).not.toContain('Dropbox')
    ;(confirmation.querySelector('.m-btn--destructive') as HTMLButtonElement).click()
    await settle()
    const deletion = calls.find((entry) => entry.url === 'https://manorama.xyz/api/galleries/kashmir' && entry.init?.method === 'DELETE')
    expect(deletion).toBeDefined()
    expect(container.querySelector('[data-screen="details"]')).toBeNull()
  })

  test('Details edits and stores a gallery caption', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({
      galleries: json({ galleries: [accountSummary({ caption: '' })] }),
      mutation: (url, init) => url === 'https://manorama.xyz/api/galleries/kashmir' && init?.method === 'PATCH'
        ? json({ gallery: accountSummary({ caption: 'Morning in the valley' }) })
        : undefined,
    })
    const { container } = mountAccount()
    await settle()

    ;(container.querySelector('[aria-label="Kashmir actions"]') as HTMLButtonElement).click()
    await settle()
    ;([...container.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Gallery details') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('[data-screen="details"]')).not.toBeNull()
    const captionRow = [...container.querySelectorAll('.m-actionrow')].find((row) => row.textContent?.includes('None')) as HTMLButtonElement
    captionRow.click()
    await settle()
    const form = container.querySelector('#m-gallery-metadata-form') as HTMLFormElement
    const input = form.querySelector('textarea') as HTMLTextAreaElement
    input.value = 'Morning in the valley'
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
    form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    await settle()

    const patch = calls.find((call) => call.url === 'https://manorama.xyz/api/galleries/kashmir' && call.init?.method === 'PATCH')
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ caption: 'Morning in the valley' })
    expect((patch?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    expect(container.querySelector('[data-screen="details"]')?.textContent).toContain('Morning in the valley')
    expect(container.querySelector('#m-gallery-metadata-form')).toBeNull()
  })

  test('the card menu reads in the contract order, with pipeline items disabled', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [
      accountSummary({ slug: 'kashmir', title: 'Kashmir', sourceUrl: 'https://www.dropbox.com/sh/example' }),
      accountSummary({ slug: 'temp', title: 'Temp', retention: 'pipeline', expiresAt: '2026-10-30T00:00:00Z' }),
    ] }) })
    const { container } = mountAccount()
    await settle()

    // One menu per card; nothing else exposes actions.
    expect(container.querySelectorAll('.lib-card-menu')).toHaveLength(2)
    expect(container.querySelector('.native-gallery-actions')).toBeNull()

    ;([...container.querySelectorAll('.lib-card-menu')] as HTMLButtonElement[])[0].click()
    await settle()
    const items = [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
    expect(items.map((item) => item.textContent)).toEqual([
      'Share link', 'Gallery details', 'Reorder photographs', 'Read the folder again', 'Remove gallery',
    ])
    // Words, not drawings — the sheet is a list of sentences.
    expect(items.every((item) => item.querySelector('svg') === null)).toBe(true)
    ;(container.querySelector('.m-scrim') as HTMLElement).click()
    await settle()

    // A pipeline gallery cannot be reordered or refreshed — both menuitems
    // are disabled with the plan's reason on them.
    ;([...container.querySelectorAll('.lib-card-menu')] as HTMLButtonElement[])[1].click()
    await settle()
    const pipelineItems = [...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]
    const reorder = pipelineItems.find((item) => item.textContent === 'Reorder photographs')!
    const refresh = pipelineItems.find((item) => item.textContent === 'Read the folder again')!
    expect(reorder.disabled).toBe(true)
    expect(refresh.disabled).toBe(true)
    expect(reorder.title).toBe('Temporary galleries cannot be edited on this plan')
    expect(pipelineItems.find((item) => item.textContent === 'Share link')!.disabled).toBe(false)
  })

  test('Add is a deliberate sheet and the gear returns to the Library', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary()] }) })
    const { container } = mountAccount()
    await settle()

    // Add is a deliberate sheet with a labelled provider field, not another
    // always-on workbench form.
    const addForm = await openAddForm(container)
    expect(addForm.querySelector('input[type="url"]')?.getAttribute('aria-label'))
      .toBe('Shared folder or album link — Dropbox, Google Drive, iCloud or MEGA')
    ;(container.querySelector('.m-sheet [aria-label="Close"]') as HTMLButtonElement).click()
    await settle()

    // The topbar gear is the sole account affordance — one tap to Settings.
    await openSettings(container)
    expect(container.querySelector('[data-account-drawer]')).toBeNull()
    expect(container.querySelector('#settings-owner-address')).not.toBeNull()
    ;(container.querySelector('[aria-label="Back to the library"]') as HTMLButtonElement).click()
    await settle()
    expect(container.querySelector('.native-library-heading')).not.toBeNull()
  })

})

describe('native-only placement', () => {
  /* The web dashboard carries the same house-creative slot as the native
     account surface, but rented frames stay native-only — no AdMob markup
     or native ad classes may appear in the web bundle. */
  test('the web dashboard carries only the house creative', () => {
    const appDir = fileURLToPath(new URL('../../app', import.meta.url))
    const sources = (readdirSync(appDir, { recursive: true }) as string[]).filter((file) =>
      /\.(ts|tsx|css)$/.test(file) && !file.includes('app-ads.txt'),
    )
    expect(sources.length).toBeGreaterThan(0)
    const withRented = sources.filter((file) => {
      const source = readFileSync(join(appDir, file), 'utf8')
      return source.includes('native-account-ad') || source.toLowerCase().includes('admob')
    })
    expect(withRented).toHaveLength(0)
  })
})
