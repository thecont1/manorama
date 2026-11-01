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
  onOpenDisplay: () => {},
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

describe('the role pill in the viewer chrome', () => {
  test('the owner sees Details in the third slot', () => {
    const root = mounted({ onOpenDetails: () => {} })
    expect(pills(root)).toEqual(['Display', 'Info', 'Details'])
  })

  test('a member sees Add to Library — and the request drives the label', () => {
    const root = mounted({ onAddToLibrary: () => {} })
    expect(pills(root)).toEqual(['Display', 'Info', 'Add to Library'])
    const busy = mounted({ onAddToLibrary: () => {}, addToLibraryBusy: true, addToLibraryLabel: 'Adding…' })
    const pill = busy.querySelector<HTMLButtonElement>('[data-chrome-bottom] .m-chrome-pill:last-child')!
    expect(pill.textContent).toBe('Adding…')
    expect(pill.disabled).toBe(true)
  })

  test('Details wins over Add to Library when both are offered', () => {
    const root = mounted({ onOpenDetails: () => {}, onAddToLibrary: () => {}, signInHref: '/' })
    expect(pills(root)).toEqual(['Display', 'Info', 'Details'])
  })

  test('a visitor sees a Sign in link with its return path', () => {
    const root = mounted({ signInHref: '/?next=%2Fowner%2Fgallery' })
    expect(pills(root)).toEqual(['Display', 'Info', 'Sign in'])
    const link = root.querySelector<HTMLAnchorElement>('a.m-chrome-pill')!
    expect(link.getAttribute('href')).toBe('/?next=%2Fowner%2Fgallery')
  })

  test('the slot stays empty when no role pill applies', () => {
    expect(pills(mounted({}))).toEqual(['Display', 'Info'])
  })
})
