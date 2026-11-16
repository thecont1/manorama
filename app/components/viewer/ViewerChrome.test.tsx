import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import ViewerChrome from './ViewerChrome'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

beforeAll(() => {
  prev = { window: globals.window, document: globals.document, SVGElement: globals.SVGElement }
  dom = new Window({ url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  globals.SVGElement = dom.SVGElement
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.SVGElement = prev.SVGElement
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

const topPills = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-chrome-top] .m-chrome-pill')].map((node) => node.textContent?.trim())

describe('the viewer chrome bars', () => {
  // Settings is the single popover for every role — the role-bound rows
  // (owner management, member adopt, visitor sign-in) live inside it, so
  // the bottom bar no longer varies by viewer. The position pill joined
  // it so the count reads as the picker's button.
  test('the bottom row is position, Settings, Info', () => {
    expect(pills(mounted({}))).toEqual(['1 of 4', 'Gallery Settings', 'Info'])
  })

  test('the top bar carries only the Library exit', () => {
    const root = mounted({ libraryHref: '/thecontrarian' })
    const pills = root.querySelectorAll('[data-chrome-top] .m-chrome-pill')
    expect(pills).toHaveLength(1)
    expect(pills[0].hasAttribute('data-chrome-library')).toBe(true)
    expect(root.querySelector('[data-chrome-top] [data-chrome-position]')).toBeNull()
    // No exit for a visitor → the top bar is empty.
    expect(topPills(mounted({}))).toEqual([])
  })

  test('the position pill opens the picker and keeps its ref slot', () => {
    let opened = 0
    let pill: HTMLButtonElement | null = null
    const root = mounted({ onOpenPicker: () => { opened += 1 }, positionRef: (el) => { pill = el } })
    const position = root.querySelector<HTMLButtonElement>('[data-chrome-bottom] [data-chrome-position]')!
    expect(position.getAttribute('aria-label')).toBe('Photograph 1 of 4 — open gallery')
    position.click()
    expect(opened).toBe(1)
    expect(pill).toBe(position)
  })

  test('the Settings pill reports through the shared handler and ref slot', () => {
    let opened = 0
    let pill: HTMLButtonElement | null = null
    const root = mounted({ onOpenSettings: () => { opened += 1 }, settingsRef: (el) => { pill = el } })
    const settings = [...root.querySelectorAll<HTMLButtonElement>('[data-chrome-bottom] .m-chrome-pill')]
      .find((node) => node.textContent === 'Gallery Settings')!
    settings.click()
    expect(opened).toBe(1)
    expect(pill).toBe(settings)
  })

  for (const edge of ['leading', 'trailing'] as const) {
    test(`vertical system bars put every control in one ${edge} side column`, () => {
      const root = mounted({ verticalBarEdge: edge, libraryHref: '/thecontrarian' })
      const columns = root.querySelectorAll('.m-chrome--side')
      expect(columns).toHaveLength(1)
      const column = columns[0] as HTMLElement
      expect(column.classList.contains(`m-chrome--side-${edge}`)).toBe(true)
      expect(column.hasAttribute('data-chrome-top')).toBe(true)
      expect(column.hasAttribute('data-chrome-bottom')).toBe(true)
      expect(column.querySelector('[data-chrome-library]')).not.toBeNull()
      expect(column.querySelector('[data-chrome-position]')).not.toBeNull()
      expect([...column.querySelectorAll('.m-chrome-pill')].map((pill) => pill.getAttribute('aria-label'))).toEqual(['Library', base.pickerAriaLabel, 'Gallery Settings', 'Info'])
      expect(column.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3)
      expect(column.querySelector('[data-chrome-position]')?.textContent).toBe('1of 4')
    })
  }
})
