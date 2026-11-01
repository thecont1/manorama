import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import ViewerChrome from './ViewerChrome'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

beforeAll(() => {
  prev = { window: globals.window, document: globals.document }
  dom = new Window({ url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
})

const base = {
  visible: true,
  position: { index: 0, total: 4 },
  onOpenSettings: () => {},
  onOpenInfo: () => {},
  onOpenPicker: () => {},
  pickerAriaLabel: 'Photograph 1 of 4 — open gallery',
  onRequestShow: () => {},
  onActivity: () => {},
  onIdle: () => {},
}

const pills = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-chrome-bottom] .m-chrome-pill')].map((node) => node.textContent?.trim())

const mounted = (props: Partial<Parameters<typeof ViewerChrome>[0]>) => {
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    render(<ViewerChrome {...base} {...props} />, container as unknown as HTMLElement)
  })
  return container as unknown as HTMLElement
}

describe('the viewer chrome bottom row', () => {
  // Settings is the single popover for every role — the role-bound rows
  // (owner management, member adopt, visitor sign-in) live inside it, so
  // the bottom bar no longer varies by viewer.
  test('Settings and Info are the whole bottom bar', () => {
    expect(pills(mounted({}))).toEqual(['Settings', 'Info'])
  })

  test('the Settings pill reports through the shared handler and ref slot', () => {
    let opened = 0
    let pill: HTMLButtonElement | null = null
    const root = mounted({ onOpenSettings: () => { opened += 1 }, settingsRef: (el) => { pill = el } })
    const settings = root.querySelector<HTMLButtonElement>('[data-chrome-bottom] .m-chrome-pill')!
    expect(settings.textContent).toBe('Settings')
    settings.click()
    expect(opened).toBe(1)
    expect(pill).toBe(settings)
  })
})
