import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { flushSync, render } from 'hono/jsx/dom'
import PickerEditor, { loadGalleryItems, PickerEditButton, type PickerEditActions, type PickerEditItem } from './PickerEditor'

const globals = globalThis as Record<string, unknown>
let dom: Window
let prev: Record<string, unknown>

type Call = { url: string; init?: RequestInit }
let calls: Call[] = []
let replaced: string[] = []
let assigned: string[] = []

beforeAll(() => {
  prev = {
    window: globals.window, document: globals.document,
    raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame,
    svg: globals.SVGElement, fetch: globals.fetch, HTMLElement: globals.HTMLElement,
  }
  dom = new Window({ url: 'http://localhost/thecontrarian/mixed' })
  globals.window = dom
  globals.document = dom.document
  globals.HTMLElement = dom.HTMLElement
  globals.SVGElement = dom.SVGElement
  globals.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1 }) as unknown as typeof requestAnimationFrame
  globals.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame
  globals.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as unknown as typeof fetch
  ;(dom.location as unknown as { replace: (u: string) => void }).replace = (u: string) => { replaced.push(u) }
  ;(dom.location as unknown as { assign: (u: string) => void }).assign = (u: string) => { assigned.push(u) }
})

afterAll(() => {
  for (const key of Object.keys(prev)) globals[key] = prev[key]
})

const item = (id: string, over: Partial<PickerEditItem> = {}): PickerEditItem => ({
  id, orderKey: `ref-${id}`, width: 4, height: 3, src: `/${id}.jpg`, preview: `/${id}-t.jpg`,
  filename: `${id}.jpg`, label: `${id}.jpg`, ...over,
})
const items = [item('a'), item('b', { hidden: true }), item('c'), item('d')]

let actions: { current: PickerEditActions | null }
let exited: number
let dones: number

const mounted = (over: { items?: PickerEditItem[]; selIndex?: number; doneHref?: string } = {}) => {
  actions = { current: null }
  exited = 0
  dones = 0
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  flushSync(() => {
    render(
      <PickerEditor
        slug="mixed"
        items={over.items ?? items}
        selIndex={over.selIndex ?? 0}
        frameRef={{ current: null }}
        pan={{ onPointerDown: () => {}, onPointerMove: () => {}, onPointerUp: () => {}, onPointerCancel: () => {}, onWheel: () => {} }}
        suppressClickRef={{ current: false }}
        actionsRef={actions}
        currentPhotoId={() => 'a'}
        itemHeight={12}
        onItemHeight={() => {}}
        onExit={() => { exited += 1 }}
        onDone={() => { dones += 1 }}
        doneHref={over.doneHref}
      />,
      container as unknown as HTMLElement,
    )
  })
  return container as unknown as HTMLElement
}

const cells = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.viewer-edit-cell')]
const order = (root: HTMLElement) => cells(root).map((cell) => cell.querySelector('[data-image-id]')?.getAttribute('data-image-id'))
const key = (value: string) => {
  let result = false
  flushSync(() => { result = actions.current!.onKey(new dom.window.KeyboardEvent('keydown', { key: value }) as unknown as KeyboardEvent) })
  return result
}
const saveButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Save' || b.textContent === 'Saving…')!
const cancelButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); flushSync(() => {}) }

describe('the picker Edit mode', () => {
  test('a HEIC cell carries the format badge', () => {
    const root = mounted({ items: [item('heic-one', { filename: 'heic-one.heic', label: 'heic-one.heic' }), item('jpeg-one')] })
    const badges = [...root.querySelectorAll('.viewer-filmstrip-badge')].map((b) => b.textContent)
    expect(badges).toEqual(['HEIC'])
  })

  test('renders every item including hidden ones, dimmed and marked', () => {
    const root = mounted()
    expect(cells(root)).toHaveLength(4)
    const hiddenCell = cells(root)[1]
    expect(hiddenCell.classList.contains('is-hidden')).toBe(true)
    expect(hiddenCell.querySelector('.viewer-edit-mark')?.getAttribute('aria-label')).toBe('Show b.jpg')
    expect(cells(root)[0].querySelector('.viewer-edit-mark')?.getAttribute('aria-label')).toBe('Hide a.jpg')
    expect(root.textContent).toContain('pick it up')
  })

  test('pick up then tap elsewhere places the photograph', () => {
    const root = mounted()
    const button = (index: number) => cells(root)[index].querySelector('button')!
    flushSync(() => button(0).click())
    expect(cells(root)[0].querySelector('.is-held')).toBeTruthy()
    expect(root.textContent).toContain('Picked up a.jpg')
    flushSync(() => button(2).click())
    expect(order(root)).toEqual(['b', 'c', 'a', 'd'])
    expect(saveButton(root).hasAttribute('disabled')).toBe(false)
  })

  test('tap the held cell to put it back, and hiding the held item puts it down', () => {
    const root = mounted()
    const button = (index: number) => cells(root)[index].querySelector('button')!
    flushSync(() => button(0).click())
    flushSync(() => button(0).click())
    expect(cells(root)[0].querySelector('.is-held')).toBeNull()
    flushSync(() => button(0).click())
    flushSync(() => cells(root)[0].querySelector('.viewer-edit-mark')!.dispatchEvent(new dom.window.Event('click', { bubbles: true }) as unknown as Event))
    expect(cells(root)[0].querySelector('.is-held')).toBeNull()
    expect(cells(root)[0].classList.contains('is-hidden')).toBe(true)
  })

  test('an untouched draft exits through Cancel in the terminal slot; Save takes it over once dirty', () => {
    const root = mounted()
    expect(cancelButton(root)).toBeTruthy()
    flushSync(() => cancelButton(root)!.click())
    expect(dones).toBe(1)
    expect(exited).toBe(0)
    // Dirty the draft: the slot becomes Save, and the draft is still alive.
    const root2 = mounted()
    flushSync(() => cells(root2)[0].querySelector('.viewer-edit-mark')!.dispatchEvent(new dom.window.Event('click', { bubbles: true }) as unknown as Event))
    expect(cancelButton(root2)).toBeUndefined()
    expect(saveButton(root2)).toBeTruthy()
  })

  test('Save stays disabled until the draft is dirty, then PATCHes order and hidden', async () => {
    calls = []; replaced = []
    const root = mounted()
    expect(cancelButton(root)).toBeTruthy()
    // Hide cell 0, move nothing else.
    flushSync(() => cells(root)[0].querySelector('.viewer-edit-mark')!.dispatchEvent(new dom.window.Event('click', { bubbles: true }) as unknown as Event))
    expect(saveButton(root).disabled).toBe(false)
    flushSync(() => saveButton(root).click())
    await settle()
    const patch = calls.find((call) => call.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/galleries/mixed')
    expect(JSON.parse(String(patch.init?.body))).toEqual({ order: ['ref-a', 'ref-b', 'ref-c', 'ref-d'], hidden: ['ref-b', 'ref-a'] })
    expect(replaced).toEqual(['/thecontrarian/mixed'])
  })

  test('a save that keeps the on-stage photo visible returns to it with ?photo=', async () => {
    calls = []; replaced = []
    const root = mounted()
    flushSync(() => cells(root)[2].querySelector('.viewer-edit-mark')!.dispatchEvent(new dom.window.Event('click', { bubbles: true }) as unknown as Event))
    flushSync(() => saveButton(root).click())
    await settle()
    expect(replaced).toEqual(['/thecontrarian/mixed?photo=a'])
  })

  test('Switching to the Photo Picker and the actions-cancel both leave Edit mode', () => {
    const root = mounted()
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Switch to Photo Picker')?.click() })
    expect(exited).toBe(1)
  })

  test('Save lands on doneHref when Edit was entered from outside the gallery; the mode switch only exits Edit', async () => {
    calls = []; replaced = []; assigned = []
    const root = mounted({ doneHref: '/thecontrarian' })
    // The switch is a mode toggle, not an exit — it leaves the draft
    // dead and the browse cells showing, same as the old Cancel.
    flushSync(() => { [...root.querySelectorAll('button')].find((b) => b.textContent === 'Switch to Photo Picker')?.click() })
    expect(exited).toBe(1)
    expect(assigned).toEqual([])
    // Save writes, then lands on the screen the session came from.
    flushSync(() => cells(root)[0].querySelector('.viewer-edit-mark')!.dispatchEvent(new dom.window.Event('click', { bubbles: true }) as unknown as Event))
    flushSync(() => saveButton(root).click())
    await settle()
    expect(calls.find((call) => call.init?.method === 'PATCH')).toBeTruthy()
    expect(assigned).toEqual(['/thecontrarian'])
    expect(replaced).toEqual([])
  })

  test('keyboard: Enter picks up, arrows move the held item, H hides, Escape puts back then exits', () => {
    const root = mounted({ selIndex: 0 })
    expect(key('Enter')).toBe(true)
    expect(cells(root)[0].querySelector('.is-held')).toBeTruthy()
    expect(key('ArrowRight')).toBe(true)
    expect(order(root)).toEqual(['b', 'a', 'c', 'd'])
    // 'b' sits at sel 0 and was already hidden — H toggles it visible.
    expect(key('h')).toBe(true)
    expect(cells(root)[0].classList.contains('is-hidden')).toBe(false)
    expect(cells(root)[0].querySelector('.viewer-edit-mark')?.getAttribute('aria-label')).toBe('Hide b.jpg')
    // The held 'a' is still held: Escape puts it back in place (no move,
    // no exit); the next Escape cancels the edit.
    key('Escape')
    expect(root.querySelector('.is-held')).toBeNull()
    expect(order(root)).toEqual(['b', 'a', 'c', 'd'])
    expect(exited).toBe(0)
    key('Escape')
    expect(exited).toBe(1)
  })

  test('keyboard: Enter and Space on the controls keep their native activation', () => {
    const root = mounted({ selIndex: 0 })
    // Dispatch first so the event carries a real target, the way the
    // dialog's onKeyDown sees it; then run it through the editor.
    const keyOn = (el: Element, value: string) => {
      const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }) as unknown as KeyboardEvent
      el.dispatchEvent(event)
      let handled = false
      flushSync(() => { handled = actions.current!.onKey(event) })
      return { handled, prevented: event.defaultPrevented }
    }
    const mark = cells(root)[0].querySelector('.viewer-edit-mark')!
    const end = cancelButton(root)!
    const cancel = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Switch to Photo Picker')!
    const sizer = root.querySelector('.viewer-edit-sizer input')!
    for (const el of [mark, end, cancel, sizer]) {
      for (const value of ['Enter', ' ']) {
        const result = keyOn(el, value)
        expect(result.handled).toBe(true)
        expect(result.prevented).toBe(false)
      }
    }
    // None of them picked the selected photograph up.
    expect(root.querySelector('.is-held')).toBeNull()
  })

  test('thumbnails mark themselves loaded so they render visible', () => {
    const root = mounted()
    const img = root.querySelector<HTMLElement>('.viewer-edit-cell img')!
    img.dispatchEvent(new dom.window.Event('load', { bubbles: false }) as unknown as Event)
    expect(img.classList.contains('is-loaded')).toBe(true)
  })

  test('ArrowDown moves the held photograph a whole row', () => {
    const root = mounted({ selIndex: 0 })
    // Two rows of two: stub the geometry the frame would report.
    const stubs = [{ top: 0, left: 0 }, { top: 0, left: 110 }, { top: 100, left: 0 }, { top: 100, left: 110 }]
    const stubRects = () => root.querySelectorAll<HTMLElement>('[data-grid-item]').forEach((el, index) => {
      el.getBoundingClientRect = () => stubs[index] as DOMRect
    })
    stubRects()
    key('Enter')
    expect(cells(root)[0].querySelector('.is-held')).toBeTruthy()
    key('ArrowDown')
    expect(order(root)).toEqual(['b', 'c', 'a', 'd'])
    // The elements kept their stubs — restub by the new DOM positions.
    stubRects()
    key('ArrowUp')
    expect(order(root)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('loadGalleryItems', () => {
  test('maps the slug\'s summary, keeping hidden flags and orderKeys from ref ?? filename', async () => {
    globals.fetch = (async (input: string | URL | Request) => new Response(JSON.stringify(
      typeof input === 'string' && input.includes('/api/galleries/mixed')
        ? { gallery: { slug: 'mixed', images: [
            { id: 'p1', ref: 'ref-p1', filename: 'p1.jpg', src: '/p1.jpg', width: 4, height: 3, alt: '', placeholder: '', hidden: true },
            { id: 'v1', filename: 'v1.mp4', src: '/v1.mp4', width: 16, height: 9, alt: '', placeholder: '', type: 'video', durationSeconds: 12, poster: { src: '/v1p.jpg', width: 16, height: 9 } },
            { id: 'm1', ref: 'node-m1', filename: 'm1.jpg', src: '', width: 4, height: 3, alt: '', placeholder: '',
              media: { kind: 'encrypted', provider: 'mega', sourceKind: 'collection', sourceId: 'MzBkCAJQ', nodeId: 'node-m1' },
              variants: [{ width: 320, src: '', format: 'image/jpeg', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'collection', sourceId: 'MzBkCAJQ', nodeId: 'node-m1', previewId: 'prev-m1' } }] },
          ] } }
        : { error: 'missing' },
    ), { status: 200 })) as unknown as typeof fetch
    const loaded = await loadGalleryItems('mixed')
    expect(loaded).toHaveLength(3)
    expect(loaded[0]).toMatchObject({ id: 'p1', orderKey: 'ref-p1', hidden: true })
    expect(loaded[1]).toMatchObject({ orderKey: 'v1.mp4', video: true, src: '/v1p.jpg', durationSeconds: 12 })
    // Encrypted items keep their keyless refs — the cell's HeicImg resolves
    // them through the client's key store; a dropped ref renders blank.
    expect(loaded[2]).toMatchObject({
      orderKey: 'node-m1', src: '',
      media: { kind: 'encrypted', provider: 'mega', nodeId: 'node-m1' },
      previewMedia: { kind: 'encrypted', provider: 'mega', nodeId: 'node-m1', previewId: 'prev-m1' },
    })
  })
})

describe('the Edit affordance', () => {
  test('a temporary gallery shows the lock message instead of a button', () => {
    const container = dom.document.createElement('div')
    dom.document.body.appendChild(container)
    flushSync(() => { render(<PickerEditButton temporary loading={false} onBegin={() => {}} />, container as unknown as HTMLElement) })
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('temporary gallery cannot be edited')
  })
})
