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
  for (let round = 0; round < 6; round++) {
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
  badge: 'Sponsored',
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
    expect(slot.getAttribute('aria-label')).toBe('Sponsored: manorama')
    expect(slot.getAttribute('class')).toContain('native-account-ad')
    expect(slot.textContent).toContain('More photographs, quietly shared.')
    // The label is visible, not only announced.
    expect(slot.textContent).toContain('Sponsored')
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
    expect(slots(container)).toHaveLength(0)

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
    expect(html.indexOf('native-account-header')).toBeLessThan(slotAt)
    expect(html.indexOf('signin-icons')).toBeGreaterThan(slotAt)
    // The opening screen is the sign-in door alone — the manual form and the
    // gallery shortcuts wait behind sign-in.
    expect(container.querySelector('form')).toBeNull()
    expect(container.innerHTML).not.toContain('Global view')
    expect(container.innerHTML).not.toContain('View subscription options')
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
    galleries?: Response
    deviceGalleries?: Response
    visibility?: Response
    suppressions?: Response
    fallback?: (url: string, init?: RequestInit) => Response
  }
  const stubFetch = (stubs: ApiStubs = {}) => {
    calls = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      calls.push({ url, init })
      if (url.includes('/api/device-galleries')) return stubs.deviceGalleries ?? json({ galleries: [] })
      if (url.includes('/api/galleries')) return stubs.galleries ?? json({ galleries: [] })
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

  const mountAccount = (options: { billing?: BillingState; client?: RevenueCatBilling } = {}) => {
    const Harness = () => {
      const [billingState] = useState<BillingState | undefined>(options.billing)
      return (
        <GalleryList
          apiBase="https://manorama.xyz"
          billingState={billingState}
          onSignIn={() => {}}
          billing={options.client}
        />
      )
    }
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<Harness />, container)
    return { container }
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
    expect(html).toContain('Your galleries')
    // The address lives in the greeting's editable URL field — the same
    // `manorama.xyz/` + slug the web dashboard renders.
    expect(html).toContain('manorama.xyz/')
    expect((container.querySelector('.admin-owner-slug-input') as HTMLInputElement)?.value).toBe('quiet-owner')
    expect(html).toContain('Kashmir')
    expect(html).toContain('A winter album')
    expect(html).toContain('manorama.xyz/quiet-owner/kashmir')
    expect(html).toContain('kashmir')
    expect(html).toContain('12 items')
    expect(html).toContain('Hello Free quiet-owner, Welcome to manorama.xyz. You have used 1 of your 3 gallery limit.')
    expect(container.querySelectorAll('.native-gallery-thumb img')).toHaveLength(1)
    expect(html).not.toContain('sequence only')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'sign out')).toBe(true)
    // Signed-in home replaces the provider row, but keeps the manual path.
    expect(html).not.toContain('Sign in with Apple')
    expect(html).toContain('Open another gallery')
    expect(html).toContain('Photo picker')
    expect(html).toContain('Keep photos from this device ready to choose in galleries')
    expect(html).not.toContain('Open photo picker')

    // The account list asked with the stored bearer token.
    const listCall = calls.find((call) => call.url === 'https://manorama.xyz/api/galleries')
    expect((listCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')

    const row = container.querySelector('.native-gallery-list button') as HTMLButtonElement | null
    expect(row).not.toBeNull()
    // The single cover takes a row of its own ahead of the copy. The second
    // fixture image proves mobile does not render the web's sequencing strip.
    const cover = row!.querySelector(':scope > .native-gallery-cover-row')
    expect(cover).not.toBeNull()
    expect(cover!.querySelectorAll('.native-gallery-thumb img')).toHaveLength(1)
    expect(cover!.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/first.jpg')
    expect([...cover!.querySelectorAll('.native-gallery-thumb')].map((thumb) => thumb.className)).toEqual([
      'native-gallery-thumb is-active',
    ])
    // Then title with its count, subtitle and address, each on its own line.
    expect([...(row!.children as unknown as Element[])].map((child) => child.className)).toEqual([
      'native-gallery-cover-row',
      'native-gallery-heading',
      'native-gallery-subtitle',
      'native-gallery-link',
    ])
    expect(row?.querySelector('.native-gallery-heading .native-gallery-meta')?.textContent).toBe('(12 items)')
    expect(row?.querySelector(':scope > .native-gallery-link')?.textContent).toBe('manorama.xyz/quiet-owner/kashmir')
    row!.click()
    await settle()

    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/quiet-owner/kashmir')).toBe(true)
  })

  test('greets by the provider name and PATCHes an edited URL name', async () => {
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
    expect(html).toContain('Hello Free Mahesh Shantaram, Welcome to manorama.xyz. You have used 1 of your 3 gallery limit.')
    expect(html).toContain('Mahesh Shantaram')
    expect(html).not.toContain('This is your manoramic world')
    expect(html).toContain('Privacy Policy')
    expect(html).toContain('© 2026 Mahesh Shantaram')

    const input = container.querySelector('.admin-owner-slug-input') as HTMLInputElement | null
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

    const html = container.innerHTML
    expect(html).toContain('This device')
    // The web dashboard's "Mac" is the wrong word in an iOS app, and the list
    // is whatever device the account last published from.
    expect(html).not.toContain('On your Mac')
    expect(html).toContain('Living room folder')
    expect(html).toContain('Field card')
    expect(html).toContain('Published selects')
    // Raw device metadata never reaches the DOM.
    expect(html).not.toContain('87654321')
    expect(html).not.toContain('fedcba98')

    const items = [...container.querySelectorAll('.native-device-list li')]
    const rowsFor = (title: string) => items.find((item) => item.textContent?.includes(title))
    expect(rowsFor('Living room folder')?.textContent).toContain("34 items · folder · on Mahesh's Mac Studio")
    expect(rowsFor('Field card')?.textContent).toContain("9 items · card · on Mahesh's Mac Studio")
    expect(rowsFor('Living room folder')?.querySelector('button')).toBeNull()
    expect(rowsFor('Field card')?.querySelector('button')).toBeNull()
    const tappable = rowsFor('Published selects')?.querySelector('button') as HTMLButtonElement | null
    expect(tappable).not.toBeNull()

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

    // Each preference is its own headed question rather than one undifferentiated
    // list running from the device down to the load policy.
    expect(
      [...container.querySelectorAll('.native-house-cards h2, .native-load-policy h2, .native-global-setting h2')]
        .map((heading) => heading.textContent),
    ).toEqual(['House cards', 'How galleries load', 'Photo picker'])

    // The switch reports what it governs, and the buttons say what they hide.
    expect(container.querySelector('.native-house-cards-status')?.textContent)
      .toBe('House cards shown · 2026-10-01 · India')
    expect(
      [...container.querySelectorAll('.native-house-cards-actions button')]
        .map((button) => button.textContent),
    ).toEqual(['Show again today', 'Hide in India'])

    // The internal vocabulary the owner flagged never reaches the screen.
    const html = container.innerHTML
    expect(html).toContain('the photo picker can then show photographs already saved here')
    expect(html).not.toContain('the gallery picker')
    expect(html).not.toContain('Plates')
    expect(html).not.toContain('Hide today')
    expect(html).not.toContain('Gallery loading')
  })

  test('names pipeline galleries without a shortened internal label', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ galleries: [accountSummary({ retention: 'pipeline' })] }) })
    const { container } = mountAccount()
    await settle()
    expect(container.querySelector('.native-temporary-galleries h2')?.textContent).toBe('Temporary galleries')
    expect(container.innerHTML).not.toContain('Temp Galleries')
  })

  test('a failed account list shows a quiet retry and never blocks the manual form', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch({ galleries: json({ error: 'The gallery list is temporarily unavailable' }, 503) })
    const { container } = mountAccount()
    await settle()

    const html = container.innerHTML
    expect(html).toContain('Your galleries could not be loaded.')
    expect(html).toContain('Try again')
    // The manual path survives a dead list.
    expect(html).toContain('Open another gallery')
    expect(container.querySelector('details form')).not.toBeNull()

    const listCalls = () => calls.filter((call) => call.url === 'https://manorama.xyz/api/galleries').length
    expect(listCalls()).toBe(1)
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again') as HTMLButtonElement
    retry.click()
    await settle()
    expect(listCalls()).toBe(2)
    expect(container.innerHTML).toContain('Your galleries could not be loaded.')
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

    const signOut = [...container.querySelectorAll('button')].find((button) => button.textContent === 'sign out') as HTMLButtonElement
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

    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    expect(entry).toBeDefined()
    entry.click()
    await settle()

    expect(container.innerHTML).toContain('Nothing in your Dropbox')
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

    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Delete account') as HTMLButtonElement
    entry.click()
    await settle()

    // The recovered slug is persisted before the confirm opens — the delete
    // itself will clear it again along with the token.
    expect(storage.get(SLUG_KEY)).toBe('quiet-owner')
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

  test('the manual form still opens another owner\u2019s gallery while signed in', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const { container } = mountAccount()
    await settle()

    const form = container.querySelector('form') as HTMLFormElement | null
    expect(form).not.toBeNull()
    const inputs = [...form!.querySelectorAll('input')] as HTMLInputElement[]
    inputs[0].value = 'other-owner'
    inputs[0].dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    inputs[1].value = 'elsewhere'
    inputs[1].dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
    form!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    await settle()

    expect(galleryCalls().some((call) => call.url === 'https://manorama.xyz/api/gallery/other-owner/elsewhere')).toBe(true)
  })

  test('an empty offering answers honestly instead of opening a dead paywall', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const client = {
      offerings: async () => null,
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'View subscription options') as HTMLButtonElement
    expect(entry).toBeDefined()
    entry.click()
    await settle()

    expect(container.innerHTML).toContain('Subscriptions are unavailable right now. Please try again shortly.')
    expect(container.querySelector('.native-paywall-card')).toBeNull()
  })

  test('an unreachable offering answers the same honest note', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const client = {
      offerings: async () => {
        throw new Error('StoreKit unavailable')
      },
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'View subscription options') as HTMLButtonElement
    entry.click()
    await settle()

    expect(container.innerHTML).toContain('Subscriptions are unavailable right now. Please try again shortly.')
    expect(container.querySelector('.native-paywall-card')).toBeNull()
  })

  test('a real offering still opens the paywall', async () => {
    installLocalStorage()
    signInStorage()
    stubFetch()
    const info = {} as BillingState['customerInfo']
    const client = {
      currentState: { tier: 'free', isPro: false, customerInfo: info },
      offerings: async () => ({ availablePackages: [{}] }),
      presentPaywallIfNeeded: async () => ({ result: 'NOT_PRESENTED', state: { tier: 'free', isPro: false, customerInfo: info } }),
      presentCustomerCenter: async () => ({ tier: 'free', isPro: false, customerInfo: info }),
    } as unknown as RevenueCatBilling
    const { container } = mountAccount({ billing: entitlement('free'), client })
    await settle()

    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'View subscription options') as HTMLButtonElement
    entry.click()
    await settle()

    expect(container.querySelector('.native-paywall-card')).not.toBeNull()
    expect(container.innerHTML).not.toContain('Subscriptions are unavailable right now. Please try again shortly.')
  })

})

describe('native-only placement', () => {
  test('the web dashboard carries no account slot', () => {
    const appDir = fileURLToPath(new URL('../../app', import.meta.url))
    const sources = (readdirSync(appDir, { recursive: true }) as string[]).filter((file) =>
      /\.(ts|tsx|css)$/.test(file),
    )
    expect(sources.length).toBeGreaterThan(0)
    const withSlot = sources.filter((file) =>
      readFileSync(join(appDir, file), 'utf8').includes('account-ad'),
    )
    expect(withSlot).toHaveLength(0)
  })
})
