/**
 * The iOS shell's chrome channel — the Capacitor-side half of the contract
 * the macOS shell already uses through desktop-shell/bridge.ts.
 *
 * The iOS 26+ glass overlay draws the system's capsules above the WKWebView
 * and asks the page to fire the real pills. Rather than selectors or
 * synthetic pointer events, it calls the same bounded surface:
 *
 *   window.__manoramaShell.activateControl('library'|'position'|'settings'|'info')
 *   window.__manoramaShell.setChromeActive(true|false)  — held-finger/focus keep-alive
 *   window.__manoramaShell.focusStage()                 — Escape hands focus back
 *
 * Outbound, the page posts { type:'focus', control } through the same
 * "manorama" webkit message handler the injected observer already uses, so
 * VoiceOver and the key loop can land on the same capsule.
 *
 * Everything here is a no-op without the data-ios-glass stamp — the stamp
 * only exists on iOS 26+, so Android and the plain web never see the API.
 */

import type { ViewerChromeControl, ViewerChromeHandle } from '../../app/islands/Viewer'

type ShellWindow = {
  __manoramaChrome?: ViewerChromeHandle
  __manoramaShell?: {
    activateControl: (control: ViewerChromeControl) => void
    setChromeActive: (active: boolean) => void
    focusStage: () => void
  }
}

const shellWindow = (): ShellWindow | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as ShellWindow)

/** The takeover stamp SceneDelegate injects at document start on iOS 26+. */
export const hasIosGlass = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dataset.iosGlass === '1'

/** Posts to the native side through the same handler the observer uses.
 *  The injected observer mints a generation per document (and per replay);
 *  tagging bundle posts with it lets the shell drop a stale document's
 *  late messages after a navigation reset. */
export const iosPost = (message: { type: 'focus'; control: ViewerChromeControl }) => {
  const win = window as unknown as {
    __manoramaChromeGen?: string
    webkit?: { messageHandlers?: { manorama?: { postMessage(payload: unknown): void } } }
  }
  const handler = win.webkit?.messageHandlers?.manorama
  const gen = win.__manoramaChromeGen
  handler?.postMessage(gen === undefined ? message : { ...message, gen })
}

/**
 * Install the inbound surface the capsules call. Delegates to the published
 * chrome handle so a call before the Viewer mounts is a harmless no-op.
 */
export const installIosShellBridge = () => {
  const w = shellWindow()
  if (!w || !hasIosGlass()) return
  w.__manoramaShell = {
    activateControl: (control) => w.__manoramaChrome?.activate(control),
    setChromeActive: (active) => w.__manoramaChrome?.setActive(active),
    focusStage: () => w.__manoramaChrome?.focusStage(),
  }
}

/** The mounted Viewer's handle — same shape the desktop publisher exposes. */
export const publishIosChrome = (handle: { current: ViewerChromeHandle | null }) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaChrome = {
    activate: (control) => handle.current?.activate(control),
    setActive: (active) => handle.current?.setActive(active),
    focusStage: () => handle.current?.focusStage(),
  }
}
