import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
    // ...and so does typing into the owner field, the ordinary interaction
    // this page exists for.
    const owner = container.querySelector('input') as HTMLInputElement | null
    expect(owner).not.toBeNull()
    if (owner) {
      owner.value = 'mahesh'
      owner.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
    }
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

  test('the slot sits in the header, before every control it must not cover', async () => {
    const { container } = mount({ billing: entitlement('free') })
    await settle()
    expect(slots(container)).toHaveLength(1)

    const html = container.innerHTML
    const slotAt = html.indexOf('data-account-ad')
    expect(slotAt).toBeGreaterThanOrEqual(0)
    expect(html).toContain('Sign in with Dropbox')
    expect(html).toContain('View subscription options')
    expect(html.indexOf('native-account-header')).toBeLessThan(slotAt)
    expect(html.indexOf('<form')).toBeGreaterThan(slotAt)
    expect(html.indexOf('Sign in with Dropbox')).toBeGreaterThan(slotAt)
    expect(html.indexOf('View subscription options')).toBeGreaterThan(slotAt)
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
