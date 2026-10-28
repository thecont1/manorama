import 'hono/jsx/dom'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { pushOverlay } from './overlay-stack'

const globals = globalThis as Record<string, unknown>
let dom: Window
let previousDocument: unknown
beforeAll(() => {
  dom = new Window({ url: 'http://localhost/' })
  previousDocument = globals.document
  globals.document = dom.document
  globals.window = dom
  globals.KeyboardEvent = dom.KeyboardEvent
  globals.MouseEvent = dom.MouseEvent
  globals.HTMLElement = dom.HTMLElement
  globals.Element = dom.Element
})
afterAll(() => {
  globals.document = previousDocument
  globals.window = undefined
})

const key = (keyName: string, opts: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, ...opts }))

const el = (tag = 'div') => {
  const node = document.createElement(tag)
  document.body.appendChild(node)
  return node
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('overlay-stack', () => {
  test('push inerts every sibling but the host; release restores them', () => {
    const page = el()
    const other = el()
    const host = el()
    const release = pushOverlay({ host })
    expect(page.inert).toBe(true)
    expect(other.inert).toBe(true)
    expect(host.inert).toBe(false)
    release()
    expect(page.inert).toBe(false)
    expect(other.inert).toBe(false)
  })

  test('a second overlay re-inerts the first host, not just page content', () => {
    const hostA = el()
    const hostB = el()
    const releaseA = pushOverlay({ host: hostA })
    const releaseB = pushOverlay({ host: hostB })
    expect(hostA.inert).toBe(true)
    expect(hostB.inert).toBe(false)
    releaseB()
    expect(hostA.inert).toBe(false)
    releaseA()
  })

  test('Escape reaches only the topmost overlay', () => {
    const calls: string[] = []
    const releaseA = pushOverlay({ host: el(), onEscape: () => calls.push('a') })
    const releaseB = pushOverlay({ host: el(), onEscape: () => calls.push('b') })
    key('Escape')
    expect(calls).toEqual(['b'])
    releaseB()
    key('Escape')
    expect(calls).toEqual(['b', 'a'])
    releaseA()
  })

  test('Escape is a no-op for an overlay without onEscape', () => {
    const calls: string[] = []
    const release = pushOverlay({ host: el(), onEscape: () => calls.push('top') })
    // Re-push a bare overlay on top: Escape goes to it (and does nothing),
    // never down to the callback underneath.
    const releaseTop = pushOverlay({ host: el() })
    key('Escape')
    expect(calls).toEqual([])
    releaseTop()
    release()
  })

  test('out-of-order release is safe', () => {
    const page = el()
    const hostA = el()
    const hostB = el()
    const releaseA = pushOverlay({ host: hostA })
    const releaseB = pushOverlay({ host: hostB })
    releaseA() // bottom released while still buried — the top overlay keeps it inert
    expect(hostA.inert).toBe(true)
    releaseB()
    expect(page.inert).toBe(false)
    expect(hostA.inert).toBe(false)
  })

  test('focus returns to the remembered element when it is still connected', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const release = pushOverlay({ host: el() })
    release()
    expect(document.activeElement).toBe(opener)
  })

  test('Tab wraps inside the host; Shift+Tab wraps backwards', () => {
    const host = el()
    const first = document.createElement('button')
    first.id = 'first-btn'
    const second = document.createElement('button')
    second.id = 'second-btn'
    host.appendChild(first)
    host.appendChild(second)
    const release = pushOverlay({ host })
    // happy-dom provides no default Tab order, so the assertions cover the
    // part the stack owns: wrapping at both ends.
    second.focus()
    key('Tab')
    expect(document.activeElement?.id).toBe('first-btn')
    key('Tab', { shiftKey: true })
    expect(document.activeElement?.id).toBe('second-btn')
    first.focus()
    key('Tab', { shiftKey: true })
    expect(document.activeElement?.id).toBe('second-btn')
    release()
  })
})
