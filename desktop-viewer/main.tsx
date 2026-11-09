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
 * directly. So a "go to photograph N" arrives as a serialised navigation
 * request prop — each serial is consumed exactly once through the Viewer's
 * own `goTo`, with no synthesised keystrokes and no timers two commands
 * could interleave.
 */
let navSerial = 0
let navRequest: { index: number; serial: number } | null = null

const root = document.getElementById('app')
if (!root) throw new Error('viewer root is missing')

/** The gallery currently on the stage, with the settings resolved at open. */
let current: { payload: OpenPayload; settings: GallerySettings } | null = null

/** Paint the mounted gallery with its resolved settings — used by both
 *  `open` and `goTo`, and deliberately silent: only `open` may announce
 *  `ready`, since the shell reads it as a fresh mount. */
const renderStage = () => {
  if (!current) return
  const { payload, settings } = current

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
        navigationRequest={navRequest}
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
}

/** Mount a new gallery: resolve its settings once, drop any navigation
 *  request issued against the previous gallery, then paint and announce
 *  readiness to the shell. */
const open = (payload: OpenPayload) => {
  // A pending request belongs to the gallery it was issued against — a new
  // mount must not consume it as its first move.
  navRequest = null
  current = {
    payload,
    settings: { ...defaultGallerySettings({
      slug: payload.slug,
      title: payload.title ?? '',
      caption: '',
      date: '',
      images: payload.images,
    }), ...(payload.settings ?? {}) },
  }
  renderStage()
  document.documentElement.setAttribute('data-manorama-viewer-ready', 'true')
  post({ type: 'ready' })
}

// Escape leaves the gallery and returns to the native library list.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  // This listener registered before the Viewer's own key handlers, so
  // defaultPrevented is not yet set — check it after dispatch completes.
  // A sheet that consumed the Escape must not also close the gallery.
  queueMicrotask(() => {
    if (!event.defaultPrevented) post({ type: 'escape' })
  })
})

// The shell drives these. Assigned on `window` so the native side can call
// them without knowing the bundle's internals.
Object.assign(window, {
  manoramaNative: {
    open,
    goTo: (index: number) => {
      navSerial += 1
      navRequest = { index, serial: navSerial }
      // A navigation only re-renders the mounted gallery — the serial makes
      // even a repeated index a distinct request the Viewer consumes once.
      // Re-rendering rather than re-opening keeps the settings object and
      // skips the ready post the shell reads as a fresh mount.
      renderStage()
    },
    setTheme: (theme: 'light' | 'dark') => {
      document.documentElement.classList.toggle('light', theme === 'light')
    },
    currentGallery: () => current?.payload.slug ?? null,
  },
})

// A bare page load (no open() yet) still reports ready so the shell can
// show its own empty state instead of a blank webview.
document.documentElement.setAttribute('data-manorama-viewer-ready', 'true')
post({ type: 'ready' })
