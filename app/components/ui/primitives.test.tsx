import 'hono/jsx/dom'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import { useState } from 'hono/jsx/dom'
import { Button } from './Button'
import { TopBar } from './TopBar'
import { ActionGroup, ActionRow } from './ActionRow'
import { Switch } from './Switch'
import { Segmented } from './Segmented'
import { Meter } from './Meter'
import { Sheet } from './Sheet'
import { announce } from '../../lib/announce'
import { overlayDepth, releaseAllOverlays } from '../../lib/overlay-stack'

const globals = globalThis as Record<string, unknown>
let dom: Window
let previousDocument: unknown
let container: HTMLDivElement
beforeAll(() => {
  dom = new Window({ url: 'http://localhost/' })
  previousDocument = globals.document
  globals.document = dom.document
  globals.window = dom
  globals.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)
  globals.cancelAnimationFrame = (id: number) => clearTimeout(id)
  globals.KeyboardEvent = dom.KeyboardEvent
  globals.MouseEvent = dom.MouseEvent
  globals.HTMLElement = dom.HTMLElement
  globals.Element = dom.Element
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterAll(() => {
  globals.document = previousDocument
  globals.window = undefined
})

afterEach(async () => {
  // Unmount through the renderer so component effects release their
  // overlays; the cleanups are deferred, so settle before stripping nodes.
  render(<></>, container)
  await settle()
  document.querySelectorAll('.m-sheet-host').forEach((n) => n.remove())
  releaseAllOverlays()
})

const keydown = (target: Element | Document, key: string, opts: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }

describe('Button / TopBar / ActionRow SSR', () => {
  test('Button variants render as real buttons with m- classes', () => {
    expect(String(<Button variant="primary">Add</Button>)).toContain('m-btn--primary')
    expect(String(<Button variant="destructive">Remove</Button>)).toContain('m-btn--destructive')
    expect(String(<Button block>Go</Button>)).toContain('m-btn--block')
  })

  test('TopBar centre is the 140x47 logo box, or the title when given', () => {
    const html = String(<TopBar />)
    expect(html).toContain('m-topbar-logo')
    expect(html).toContain('width="140"')
    expect(html).toContain('height="47"')
    const titled = String(<TopBar title="Reorder" logo={false} />)
    expect(titled).toContain('m-topbar-title')
    expect(titled).not.toContain('m-topbar-logo')
  })

  test('ActionRow: button with onClick, anchor with href, div for control rows', () => {
    expect(String(<ActionRow label="Open" onClick={() => {}} />)).toContain('<button')
    const link = String(<ActionRow label="Site" href="/x" />)
    expect(link).toContain('<a')
    expect(link).toContain('href="/x"')
    const row = String(<ActionGroup label="g"><ActionRow label="Keep" control={<i />} /></ActionGroup>)
    expect(row).toContain('m-actionrow-control')
    expect(row).not.toContain('m-actionrow-chevron')
    expect(String(<ActionRow label="Del" tone="destructive" />)).toContain('m-actionrow--destructive')
  })

  test('Meter carries meter semantics', () => {
    const html = String(<Meter label="Saving" value={9} max={13} valueText="9 of 13" />)
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuenow="9"')
    expect(html).toContain('aria-valuemax="13"')
    expect(html).toContain('aria-valuetext="9 of 13"')
  })
})

describe('Switch', () => {
  test('toggles aria-checked and reports the next value', async () => {
    let seen: boolean[] = []
    render(<Switch checked={false} label="Keep a copy" onChange={(v) => seen.push(v)} />, container)
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    sw.click()
    await tick()
    expect(seen).toEqual([true])
  })
})

describe('Segmented', () => {
  test('arrow keys move and select with a roving tabindex', async () => {
    const opts = [
      { value: 'a', label: 'Strip' },
      { value: 'b', label: 'Scroll' },
      { value: 'c', label: 'One by one' },
    ] as const
    const Demo = () => {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a')
      return <Segmented label="Layout" options={[...opts]} value={v} onChange={setV} />
    }
    render(<Demo />, container)
    const group = container.querySelector('[role="radiogroup"]')!
    const radios = container.querySelectorAll('[role="radio"]')
    expect(radios[0].getAttribute('tabindex')).toBe('0')
    expect(radios[1].getAttribute('tabindex')).toBe('-1')
    keydown(group, 'ArrowRight')
    await tick()
    const second = container.querySelectorAll('[role="radio"]')[1]
    expect(second.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(second)
    keydown(group, 'End')
    await tick()
    const last = container.querySelectorAll('[role="radio"]')[2]
    expect(last.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(last)
    keydown(group, 'Home')
    await tick()
    const first = container.querySelectorAll('[role="radio"]')[0]
    expect(first.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(first)
  })
})

describe('Sheet', () => {
  test('closed renders nothing', () => {
    render(<Sheet open={false} onClose={() => {}} title="Nope" />, container)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  test('open renders a labelled modal dialog in document.body', async () => {
    render(<Sheet open onClose={() => {}} title="Display" />, container)
    await tick()
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const heading = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(heading?.textContent).toBe('Display')
  })

  test('non-dismissible ignores Escape and scrim', async () => {
    let closed = 0
    render(<Sheet open dismissible={false} onClose={() => closed++} title="Wait" />, container)
    await tick()
    keydown(document, 'Escape')
    document.querySelector('.m-scrim')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(closed).toBe(0)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})

describe('announce', () => {
  test('repeats are re-announced through one live region', async () => {
    const seen: string[] = []
    const observer = new MutationObserver(() => {
      const region = document.querySelector('.m-sr-only[aria-live]')
      if (region) seen.push(region.textContent ?? '')
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    announce('Saved')
    announce('Saved')
    await new Promise((r) => setTimeout(r, 30))
    observer.disconnect()
    const regions = document.querySelectorAll('.m-sr-only[aria-live]')
    expect(regions.length).toBe(1)
    expect(regions[0].textContent).toBe('Saved')
    // A repeated message is only re-announced because the region is cleared
    // and refilled — the mutation trail must show the empty beat.
    expect(seen).toContain('')
    expect(seen[seen.length - 1]).toBe('Saved')
    announce('Saved', 'assertive')
    await new Promise((r) => setTimeout(r, 30))
    expect(regions[0].getAttribute('aria-live')).toBe('assertive')
  })
})

describe('Sheet stability under parent re-renders', () => {
  test('typing in a parent-state input keeps the sheet stable; Escape drains the stack', async () => {
    const Demo = () => {
      const [open, setOpen] = useState(false)
      const [v, setV] = useState('')
      return (
        <>
          <button id="opener-btn" onClick={() => setOpen(true)}>open</button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Add" size="half">
            <input
              id="field"
              value={v}
              onInput={(e: Event) => setV((e.target as HTMLInputElement).value)}
            />
          </Sheet>
        </>
      )
    }
    render(<Demo />, container)
    const base = overlayDepth()
    const opener = container.querySelector('#opener-btn') as HTMLButtonElement
    opener.focus()
    opener.click()
    await tick()
    const input = document.getElementById('field') as HTMLInputElement
    expect(input).not.toBeNull()
    input.focus()
    for (const ch of 'hello world') {
      input.value += ch
      input.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event('input', { bubbles: true }))
      await tick()
      // The parent re-renders on every keystroke with a fresh inline
      // onClose; the sheet must neither remount the input nor duplicate
      // its overlay. (happy-dom's activeElement bookkeeping cannot express
      // focus persistence — the Playwright spec asserts it in a browser.)
      expect(document.getElementById('field')).toBe(input)
      expect(document.querySelectorAll('.m-sheet-host').length).toBe(1)
    }
    expect(input.value).toBe('hello world')
    keydown(document, 'Escape')
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // The sheet's own entry drained; any residual entries belong to earlier
    // tests' unmounted fixtures (drained in afterEach).
    expect(overlayDepth()).toBe(base)
  })
})
