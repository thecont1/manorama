// Screen 06 capture-only entry. It mounts the production GlobalView island, not
// a visual imitation, against the owner's public Italy manifest and unchanged
// originals served from the local capture harness. Nothing here ships with the
// app, and no vault or account data is written to the server.
import { render } from 'hono/jsx/dom'
import GlobalView from '../native/islands/GlobalView'
import type { OfflineGridFrame, OfflineGridGallery } from '../native/lib/offline-gallery'
import '../native/styles.css'

document.body.classList.add('manorama-native')

const root = document.getElementById('app')
if (!root) throw new Error('The Screen 06 capture root is missing')

const json = await fetch('/__capture/gallery-fixture').then((response) => response.json()) as {
  manifest: { slug: string; title: string; images: Array<{ id: string; filename: string; width: number; height: number; alt: string }> }
}
const { manifest } = json
const frames: OfflineGridFrame[] = manifest.images.map((image, index) => ({
  id: image.id,
  entryId: image.filename,
  mimeType: 'image/jpeg',
  width: image.width,
  height: image.height,
  alt: image.alt,
  index,
}))
const gallery: OfflineGridGallery = {
  galleryId: 'capture-italy',
  owner: 'thecontrarian',
  slug: manifest.slug,
  title: manifest.title,
  frames,
}

// GlobalView's normal GridThumbLoader receives the actual unchanged JPEG bytes
// and materializes them lazily in the WebView. This is only an in-memory stand-in
// for the encrypted vault, whose keys are intentionally unavailable to a capture
// harness; it preserves the real island's layout and loading behaviour.
const store = {
  async gridGallery() { return gallery },
  async listGridGalleries() { return [gallery] },
  async readThumbnail(_galleryId: string, entryId: string) {
    const response = await fetch(`/__capture/photo/${encodeURIComponent(entryId)}`)
    if (!response.ok) return undefined
    return new Uint8Array(await response.arrayBuffer())
  },
}

render(
  <GlobalView
    store={store}
    tier="free"
    current={{ owner: gallery.owner, slug: gallery.slug }}
    active={{ selection: { owner: gallery.owner, slug: gallery.slug }, index: 0 }}
    onOpenFrame={() => {}}
    onClose={() => {}}
  />,
  root,
)

// The screenshot script waits for the first visible rows' actual image loads,
// rather than taking a picture of placeholders.
const started = Date.now()
const wait = () => {
  const cells = [...document.querySelectorAll<HTMLElement>('[data-grid-frame]')]
  const visible = cells.filter((cell) => {
    const rect = cell.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight - 92
  })
  const images = [...document.querySelectorAll<HTMLImageElement>('[data-grid-frame] img')]
  const decoded = images.filter((image) => image.complete && image.naturalWidth > 0).length
  const visibleReady = visible.length > 0 && visible.every((cell) => {
    const image = cell.querySelector('img')
    return image?.complete && image.naturalWidth > 0
  })
  if ((cells.length === frames.length && visibleReady) || Date.now() - started > 45000) {
    const ready = cells.length === frames.length && visibleReady
    console.log('[capture] global view ready:', ready, 'cells:', cells.length, 'visible:', visible.length, 'decoded:', decoded)
    void fetch('/__capture/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 4, generation: (window as unknown as { __captureGeneration: number }).__captureGeneration,
        ready, frames: cells.length, visible: visible.length, decoded }),
    })
    return
  }
  setTimeout(wait, 250)
}
setTimeout(wait, 250)
