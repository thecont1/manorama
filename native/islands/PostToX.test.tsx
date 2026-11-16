import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import PostToX from './PostToX'
import { releaseAllOverlays } from '../../app/lib/overlay-stack'
import type { PostToXPhoto } from '../lib/post-to-x'
import type { PostExportOptions, PostExportReport } from '../lib/post-export'

/**
 * The picker's whole contract is a tap that picks, a ceiling that holds, and
 * an order that is the gallery's however the photographs were tapped — so it
 * is exercised through the mounted island, with the same rAF-by-hand harness
 * the account tests use.
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
  globals.getComputedStyle = dom.getComputedStyle.bind(dom)
  globals.SVGElement = dom.SVGElement
  globals.HTMLElement = dom.HTMLElement
  globals.MutationObserver = dom.MutationObserver
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
})

const photo = (id: string): Record<string, unknown> => ({
  id,
  filename: `${id}.jpg`,
  src: `/api/dropbox/file?filename=${id}.jpg`,
  variants: [{ width: 256, src: `/api/dropbox/thumbnail?filename=${id}.jpg&size=w256h256`, format: 'jpeg' }],
  width: 3000,
  height: 2000,
  alt: `Photograph ${id}`,
  c2pa: false,
  placeholder: 'data:image/svg+xml,svg',
})

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const originalFetch = globalThis.fetch
const stubGallery = (count: number) => {
  globalThis.fetch = (async () => {
    const images = Array.from({ length: count }, (_, index) => photo(`p${index}`))
    return json({ manifest: { slug: 'kashmir', title: 'Kashmir', caption: '', date: '', images }, settings: {} })
  }) as typeof fetch
}

type ExportCall = { photos: readonly PostToXPhoto[]; text: string }
let exportCalls: ExportCall[] = []

const mount = async (options: { photos?: number } = {}) => {
  exportCalls = []
  stubGallery(options.photos ?? 3)
  const container = dom.document.createElement('div') as unknown as HTMLElement
  dom.document.body.appendChild(container as unknown as Parameters<typeof dom.document.body.appendChild>[0])
  const posted: string[] = []
  const exportPhotos = (async (exportOptions: PostExportOptions): Promise<PostExportReport> => {
    exportCalls.push({ photos: exportOptions.photos, text: exportOptions.text })
    return { outcome: 'shared', posted: exportOptions.photos.length, skipped: 0, note: `${exportOptions.photos.length} photographs are ready to post.` }
  }) as unknown as typeof import('../lib/post-export').exportPhotosForShare

  render(
    <PostToX
      apiBase="https://manorama.xyz"
      owner="quiet-owner"
      slug="kashmir"
      title="Kashmir"
      galleryUrl="https://manorama.xyz/quiet-owner/kashmir"
      onClose={() => {}}
      onPosted={(note) => { posted.push(note) }}
      read={async () => undefined}
      exportPhotos={exportPhotos}
    />,
    container,
  )
  await settle()
  return { container, posted }
}

const cellsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('.native-global-cell')] as HTMLButtonElement[]

const noteOf = (container: HTMLElement) => container.querySelector('.native-postto-note')?.textContent ?? ''

const submitOf = (container: HTMLElement) =>
  container.querySelector('.native-postto-submit') as HTMLButtonElement

afterAll(() => {
  globalThis.fetch = originalFetch
  releaseAllOverlays()
})

describe('the Post to X picker', () => {
  test('shows the gallery photographs as the picker matrix, in order', async () => {
    const { container } = await mount()
    const cells = cellsOf(container)
    expect(cells).toHaveLength(3)
    expect(cells[0].querySelector('img')?.getAttribute('src')).toContain('p0.jpg')
    expect(cells[2].querySelector('img')?.getAttribute('src')).toContain('p2.jpg')
    // The picker runs in the gallery's own order.
    expect(container.textContent).toContain('0 of 20 photographs')
  })

  test('a tap picks the photograph — the pink and the pressed state', async () => {
    const { container } = await mount()
    const cells = cellsOf(container)
    cells[1].click()
    await settle()
    expect(cells[1].className).toContain('is-active')
    expect(cells[1].getAttribute('aria-pressed')).toBe('true')
    expect(cells[0].getAttribute('aria-pressed')).toBe('false')
    expect(container.textContent).toContain('1 of 20 photographs')
  })

  test('a second tap puts the photograph back', async () => {
    const { container } = await mount()
    const cells = cellsOf(container)
    cells[1].click()
    await settle()
    cells[1].click()
    await settle()
    expect(cells[1].className).not.toContain('is-active')
    expect(container.textContent).toContain('0 of 20 photographs')
  })

  test('the ceiling is X’s: the twenty-first photograph is refused with a note', async () => {
    const { container } = await mount({ photos: 21 })
    const cells = cellsOf(container)
    for (const cell of cells.slice(0, 20)) {
      cell.click()
      await settle()
    }
    expect(container.textContent).toContain('20 of 20 photographs')
    cells[20].click()
    await settle()
    expect(cells[20].className).not.toContain('is-active')
    expect(container.textContent).toContain('20 of 20 photographs')
    expect(noteOf(container)).toContain('the most X takes in one post')
  })

  test('the post is refused until a photograph is picked', async () => {
    const { container } = await mount()
    expect(submitOf(container).disabled).toBe(true)
    cellsOf(container)[0].click()
    await settle()
    expect(submitOf(container).disabled).toBe(false)
  })

  test('the post carries the caption and the gallery address', async () => {
    const { container } = await mount()
    cellsOf(container)[0].click()
    await settle()
    const field = container.querySelector('textarea') as HTMLTextAreaElement
    field.value = 'Fog over the harbour'
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }) as unknown as Event)
    await settle()
    submitOf(container).click()
    await settle()
    expect(exportCalls).toHaveLength(1)
    expect(exportCalls[0].text).toBe('Fog over the harbour\nhttps://manorama.xyz/quiet-owner/kashmir')
  })

  test('the photographs are posted in the gallery order, whatever order they were tapped', async () => {
    const { container } = await mount()
    const cells = cellsOf(container)
    cells[2].click()
    await settle()
    cells[0].click()
    await settle()
    submitOf(container).click()
    await settle()
    expect(exportCalls).toHaveLength(1)
    expect(exportCalls[0].photos.map((photo) => photo.id)).toEqual(['p0', 'p2'])
  })
})
