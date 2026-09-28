import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import Paywall from './Paywall'
import type { RevenueCatBilling } from '../lib/billing'

/**
 * Minimal happy-dom mount — Paywall's only async boundary is the paywall
 * presentation on mount, so a few macrotask flushes settle it. Browser.open
 * falls back to window.open outside the Capacitor shell, so the test stubs
 * the window, same as native/lib/session.test.ts.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown
let previousDocument: unknown
let previousAnimationFrame: unknown
let previousCancelAnimationFrame: unknown
let dom: Window

// hono/jsx/dom schedules effects through rAF; step the queue deliberately
// rather than sleeping through it.
type Frame = { id: number; callback: FrameRequestCallback }
let frames: Frame[] = []
let nextFrameId = 0
const runFrames = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame.callback(0)
}

beforeAll(() => {
  dom = new Window({ url: 'http://localhost/' })
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

const settle = async () => {
  for (let round = 0; round < 8; round += 1) {
    runFrames()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const billing = {
  presentPaywallIfNeeded: async () => ({
    result: 'NOT_PRESENTED',
    state: { tier: 'free', isPro: false, customerInfo: {} },
  }),
  presentCustomerCenter: async () => ({ tier: 'free', isPro: false, customerInfo: {} }),
} as unknown as RevenueCatBilling

describe('paywall legal links', () => {
  test('Terms of Use and Privacy Policy open through the in-app browser', async () => {
    const opened: string[] = []
    dom.open = ((url: string) => {
      opened.push(url)
      return null
    }) as typeof dom.open
    const container = dom.document.createElement('div') as unknown as HTMLElement
    dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
    render(<Paywall billing={billing} onClose={() => {}} />, container)
    await settle()

    const terms = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Terms of Use')
    const privacy = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Privacy Policy')
    expect(terms).toBeDefined()
    expect(privacy).toBeDefined()
    ;(terms as HTMLButtonElement).click()
    ;(privacy as HTMLButtonElement).click()
    await settle()

    // Guideline 3.1.2: the standard EULA and the privacy policy must be
    // reachable in-app wherever a subscription is offered.
    expect(opened).toEqual([
      'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
      'https://manorama.xyz/privacy',
    ])
  })
})
