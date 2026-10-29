import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import { WebReorderView, type WebReorderImage } from './WebReorderView'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

const photos = (): WebReorderImage[] => [
  { id: 'a', orderKey: 'ref-a', width: 400, height: 300, src: '/a.jpg', label: 'a.jpg' },
  { id: 'b', orderKey: 'b.jpg', width: 300, height: 400, src: '/b.jpg', label: 'b.jpg' },
  { id: 'c', orderKey: 'ref-c', width: 200, height: 200, src: '/c.jpg', label: 'c.jpg' },
]

const keys = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-order-key]')].map((node) => node.dataset.orderKey)

const named = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === label)

beforeAll(() => {
  prev = { window: globals.window, document: globals.document, raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame }
  dom = new Window({ width: 1440, height: 900, url: 'http://localhost/' })
  globals.window = dom
  globals.document = dom.document
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
})

afterAll(() => {
  globals.window = prev.window
  globals.document = prev.document
  globals.requestAnimationFrame = prev.raf
  globals.cancelAnimationFrame = prev.caf
})

describe('web reorder draft', () => {
  test('Save stays disabled until the order differs, and Cancel writes nothing', () => {
    const saved: string[][] = []
    let cancelled = 0
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    flushSync(() => {
      render(<WebReorderView title="Kashmir" images={photos()} onCancel={() => { cancelled += 1 }} onSave={(order) => { saved.push([...order]) }} />, container as unknown as HTMLElement)
    })
    const root = container as unknown as HTMLElement
    const save = named(root, 'Save')
    const cancel = named(root, 'Cancel')
    expect(save?.disabled).toBe(true)
    cancel?.click()
    expect(cancelled).toBe(1)
    expect(saved).toEqual([])
    expect(keys(root)).toEqual(['ref-a', 'b.jpg', 'ref-c'])
  })

  test('a pick and place is local until Save, which sends order keys not presentation ids', () => {
    const saved: string[][] = []
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    flushSync(() => {
      render(<WebReorderView title="Kashmir" images={photos()} onCancel={() => {}} onSave={(order) => { saved.push([...order]) }} />, container as unknown as HTMLElement)
    })
    const root = container as unknown as HTMLElement
    const cells = () => [...root.querySelectorAll<HTMLElement>('.web-reorder-cell')]
    flushSync(() => { cells()[2]?.click() })
    flushSync(() => { cells()[0]?.click() })
    const save = named(root, 'Save')
    expect(save?.disabled).toBe(false)
    expect(saved).toEqual([])
    expect(keys(root)).toEqual(['ref-c', 'ref-a', 'b.jpg'])
    save?.click()
    expect(saved).toEqual([['ref-c', 'ref-a', 'b.jpg']])
  })

  test('a failed Save shows its message beside the status line', () => {
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    flushSync(() => {
      render(<WebReorderView title="Kashmir" images={photos()} note="That order could not be saved" onCancel={() => {}} onSave={() => {}} />, container as unknown as HTMLElement)
    })
    const root = container as unknown as HTMLElement
    const status = root.querySelector('#web-reorder-status')
    const note = status?.querySelector('.web-reorder-note')
    expect(note?.textContent).toBe('That order could not be saved')
    expect(note?.getAttribute('role')).toBe('alert')
  })
})
