import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { render } from 'hono/jsx/dom'
import GlobalView from './GlobalView'
import { offlineGalleryId } from '../lib/offline-gallery'
import type {
  GallerySelection,
  OfflineGridFrame,
  OfflineGridGallery,
  OfflineObjectUrlProvider,
} from '../lib/offline-gallery'

/**
 * Same mounted-island discipline as the vault-settings tests: async
 * boundaries are queued animation frames, stepped deliberately.
 * happy-dom has no IntersectionObserver — cells take the eager materialization
 * path, which is the fallback the island ships anyway.
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
const settle = async () => {
  for (let round = 0; round < 8; round++) {
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

const frame = (id: string, index: number): OfflineGridFrame => ({
  id,
  entryId: `thumb-${id}`,
  mimeType: 'image/jpeg',
  width: 800,
  height: 600,
  alt: `${id} alt`,
  index,
})

const grid = (overrides: Partial<OfflineGridGallery> = {}): OfflineGridGallery => ({
  galleryId: 'gallery-a',
  owner: 'photographer',
  slug: 'quiet-light',
  title: 'Quiet light',
  frames: [frame('one', 0), frame('two', 1)],
  ...overrides,
})

const objectUrls = (): OfflineObjectUrlProvider & { created: string[] } => {
  const created: string[] = []
  return {
    created,
    create() {
      const url = `blob:gv-${created.length}`
      created.push(url)
      return url
    },
    revoke() {},
  }
}

const makeStore = (grids: OfflineGridGallery[]) => {
  const calls = { gridGallery: [] as string[], listGridGalleries: 0, readThumbnail: 0 }
  return {
    calls,
    async gridGallery(galleryId: string) {
      calls.gridGallery.push(galleryId)
      return grids.find((g) => g.galleryId === galleryId)
    },
    async listGridGalleries() {
      calls.listGridGalleries++
      return grids
    },
    async readThumbnail() {
      calls.readThumbnail++
      return new Uint8Array([1, 2, 3])
    },
  }
}

const mount = (ui: Parameters<typeof render>[0]) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  render(ui, container as unknown as HTMLElement)
  return container
}

const click = (el: Element | null) => el?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }) as unknown as Event)

describe('GlobalView', () => {
  test('opens directly with the current gallery and has no in-view preference box', async () => {
    const current = { owner: 'photographer', slug: 'quiet-light' }
    const store = makeStore([grid({ galleryId: await offlineGalleryId(current) })])
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={current}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(container.querySelector('.native-global-explainer')).toBeNull()
    expect(container.querySelector('.native-global-toggle')).toBeNull()
    expect(container.querySelectorAll('[data-grid-frame]')).toHaveLength(2)
    expect(store.calls.gridGallery).toEqual([await offlineGalleryId(current)])
    container.remove()
  })

  test('free tier shows only the current gallery', async () => {
    const current = { owner: 'photographer', slug: 'quiet-light' }
    const store = makeStore([grid({ galleryId: await offlineGalleryId(current) })])
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={current}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(store.calls.listGridGalleries).toBe(0)
    expect(store.calls.gridGallery).toEqual([await offlineGalleryId(current)])
    expect(container.querySelectorAll('[data-grid-frame]')).toHaveLength(2)
    expect(container.textContent).toContain('Quiet light')
    expect(container.textContent).not.toContain('Pro includes every saved gallery')
    container.remove()
  })

  test('free tier with no open gallery says what it needs', async () => {
    const store = makeStore([grid()])
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={null}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(container.querySelectorAll('[data-grid-frame]')).toHaveLength(0)
    expect(container.textContent).toContain('Open a gallery first')
    container.remove()
  })

  test('pro tier shows every saved gallery on the device', async () => {
    const store = makeStore([
      grid(),
      grid({ galleryId: 'gallery-b', slug: 'second-album', title: 'Second album', frames: [frame('three', 0)] }),
    ])
    const container = mount(
      <GlobalView
        store={store}
        tier="pro"
        current={null}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(store.calls.listGridGalleries).toBe(1)
    expect(store.calls.gridGallery).toEqual([])
    expect(container.querySelectorAll('.native-global-gallery')).toHaveLength(2)
    expect(container.querySelectorAll('[data-grid-frame]')).toHaveLength(3)
    expect(container.textContent).toContain('Second album')
    container.remove()
  })

  test('tapping a cell opens the stage on that frame', async () => {
    const current = { owner: 'photographer', slug: 'quiet-light' }
    const store = makeStore([grid({ galleryId: await offlineGalleryId(current) })])
    const opened: { owner: string; slug: string; index: number }[] = []
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={current}
        objectUrls={objectUrls()}
        onOpenFrame={(selection: GallerySelection, index: number) => {
          opened.push({ ...selection, index })
        }}
        onClose={() => {}}
      />,
    )
    await settle()

    click(container.querySelectorAll('[data-grid-frame]')[1])
    expect(opened).toEqual([{ owner: 'photographer', slug: 'quiet-light', index: 1 }])
    container.remove()
  })

  test('materializes thumbnails through the vault read, not the network', async () => {
    const current = { owner: 'photographer', slug: 'quiet-light' }
    const store = makeStore([grid({ galleryId: await offlineGalleryId(current) })])
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={current}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(store.calls.readThumbnail).toBe(2)
    const images = [...container.querySelectorAll('[data-grid-frame] img')] as HTMLImageElement[]
    expect(images.map((img) => img.getAttribute('src'))).toEqual(['blob:gv-0', 'blob:gv-1'])
    container.remove()
  })

  test('does not expose a preference toggle inside the gallery surface', async () => {
    const current = { owner: 'photographer', slug: 'quiet-light' }
    const store = makeStore([grid({ galleryId: await offlineGalleryId(current) })])
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={current}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => {}}
      />,
    )
    await settle()

    expect(container.querySelectorAll('[data-grid-frame]')).toHaveLength(2)
    expect(container.querySelector('.native-global-toggle')).toBeNull()
    expect(container.querySelector('.native-global-enable')).toBeNull()
    container.remove()
  })

  test('escape closes the view', async () => {
    const store = makeStore([grid()])
    let closed = 0
    const container = mount(
      <GlobalView
        store={store}
        tier="free"
        current={null}
        objectUrls={objectUrls()}
        onOpenFrame={() => {}}
        onClose={() => { closed += 1 }}
      />,
    )
    await settle()

    dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(closed).toBe(1)
    container.remove()
  })
})
