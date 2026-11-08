import { render } from 'hono/jsx/dom'
import Viewer from '../app/islands/Viewer'
import GalleryShell from '../app/components/GalleryShell'
import { defaultGallerySettings, type GallerySettings } from '../app/lib/gallery-settings'
import type { GalleryMediaItem } from '../packages/core/imagesource'
import '../app/styles.css'

/**
 * The viewer-only surface.
 *
 * This bundle mounts ONE island — the shared Viewer — and nothing else. No
 * rail, no catalogue, no drawer, no account pane. The native shell owns the
 * chrome; the browser surface owns exactly the thing AGENTS.md §1 calls the
 * product.
 *
 * The two halves talk over a narrow bridge:
 *
 *   native → page   `window.manoramaNative.open({...})` mounts a gallery,
 *                    `window.manoramaNative.goTo(n)` moves the stage.
 *   page → native   `window.webkit.messageHandlers.manorama.postMessage(...)`
 *                    reports position, escape, and failures.
 *
 * The bridge is deliberately thin. Anything that needs a native capability
 * (folder access, Keychain, the file picker) is a native action the shell
 * owns; the page asks for it and the shell answers.
 */

type BridgeMessage =
  | { type: 'ready' }
  | { type: 'position'; index: number; imageId: string; total: number }
  | { type: 'escape' }
  | { type: 'error'; message: string }

type OpenPayload = {
  slug: string
  title?: string
  images: readonly GalleryMediaItem[]
  settings?: Partial<GallerySettings>
  initialIndex?: number
}

const post = (message: BridgeMessage) => {
  const handler = (window as unknown as {
    webkit?: { messageHandlers?: { manorama?: { postMessage(payload: unknown): void } } }
  }).webkit?.messageHandlers?.manorama
  handler?.postMessage(message)
}

/**
 * The command the native menu sends to move the stage.
 *
 * The Viewer owns its index; the native shell does not get to set it
 * directly. So the shell's "go to photograph N" is expressed as the same
 * key sequence a person would press — the page synthesises the keystrokes
 * and the Viewer's own handler moves the stage. That keeps ONE owner of the
 * index, and it means the native path cannot drift from the keyboard path.
 */
const moveTo = (index: number) => {
  const dispatch = (key: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    }))
  }
  // Home lands on the first photograph; then ArrowRight steps forward.
  dispatch('Home')
  let steps = 0
  const step = () => {
    if (steps >= index) return
    steps += 1
    dispatch('ArrowRight')
    // The strip advances by viewport, not by one, so a single ArrowRight
    // may skip frames. Re-issue until the page reports the target index.
    if (steps < index) window.setTimeout(step, 60)
  }
  if (index > 0) window.setTimeout(step, 60)
}

const root = document.getElementById('app')
if (!root) throw new Error('viewer root is missing')

/** The gallery currently on the stage, for the shell's status line. */
let current: OpenPayload | null = null

const mount = (payload: OpenPayload) => {
  current = payload
  const settings = { ...defaultGallerySettings({
    slug: payload.slug,
    title: payload.title ?? '',
    caption: '',
    date: '',
    images: payload.images,
  }), ...(payload.settings ?? {}) }

  render(
    <GalleryShell settings={settings} mediaCount={{ stills: payload.images.length, videos: 0 }}>
      <Viewer
        key={payload.slug}
        slug={payload.slug}
        galleryTitle={payload.title}
        images={payload.images}
        settings={settings}
        initialIndex={payload.initialIndex ?? 0}
        // The native window owns fullscreen — a web Fullscreen API request
        // would put the whole WKWebView into its own space, which is not what
        // a Mac user means by "fullscreen" for an app with a sidebar.
        allowFullscreen={false}
        onPositionChange={(position) => {
          post({
            type: 'position',
            index: position.index,
            imageId: position.imageId,
            total: payload.images.length,
          })
        }}
        onReturnToGalleries={() => post({ type: 'escape' })}
      />
    </GalleryShell>,
    root,
  )
  document.documentElement.setAttribute('data-manorama-viewer-ready', 'true')
  post({ type: 'ready' })
}

// Escape leaves the gallery and returns to the native library list.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  // The Viewer's own Escape handling (closing a sheet) runs first; the
  // bridge only hears the event that bubbles to the document, so a sheet
  // that consumed it never reaches here.
  post({ type: 'escape' })
})

// The shell drives these. Assigned on `window` so the native side can call
// them without knowing the bundle's internals.
Object.assign(window, {
  manoramaNative: {
    open: (payload: OpenPayload) => mount(payload),
    goTo: (index: number) => moveTo(index),
    setTheme: (theme: 'light' | 'dark') => {
      document.documentElement.classList.toggle('light', theme === 'light')
    },
    currentGallery: () => current?.slug ?? null,
  },
})

// A bare page load (no open() yet) still reports ready so the shell can
// show its own empty state instead of a blank webview.
document.documentElement.setAttribute('data-manorama-viewer-ready', 'true')
post({ type: 'ready' })
