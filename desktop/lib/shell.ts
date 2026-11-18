/**
 * The native shell's channel.
 *
 * The desktop bundle is the app: the Library, the gallery grid, the vault
 * meter, the local catalogue. It runs under Tauri and under the native
 * macOS shell, and the shell wants two things the bundle does not otherwise
 * expose — the committed photograph, so the shell can show a position, and a
 * way to move the stage from the native menu.
 *
 * Everything here is a no-op when no shell is present, so the Tauri build
 * behaves exactly as it did before this file existed.
 */

import type { ViewerChromeControl, ViewerChromeHandle } from '../../app/islands/Viewer'

export type ShellMessage =
  | { type: 'ready' }
  | { type: 'position'; index: number; total: number }
  | { type: 'gallery'; open: boolean; title?: string }
  | { type: 'escape' }
  | { type: 'focus'; control: ViewerChromeControl }

type ShellOutbound = { post: (message: ShellMessage) => void }

type ShellWindow = {
  __MANORAMA_SHELL__?: ShellOutbound
  __manoramaGoTo?: (index: number) => void
  __manoramaChrome?: ViewerChromeHandle
  __manoramaCloseGallery?: () => void
  __manoramaAddGallery?: () => void
  __manoramaAddFolder?: () => void
}

/**
 * The host window, when there is one. A torn-down DOM — a Worker import or a
 * test file whose globals were already restored — counts as "no shell", the
 * same contract the publishers below already promise.
 */
const shellWindow = (): ShellWindow | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as ShellWindow)

const outbound = (): ShellOutbound | undefined => shellWindow()?.__MANORAMA_SHELL__

/** Tell the shell something. Silently ignored when there is no shell. */
export const shellPost = (message: ShellMessage) => {
  outbound()?.post(message)
}

/**
 * The SwiftUI shell stamps `data-macos-shell` on the document element at
 * document start (ViewerWebView's user script); a Tauri or plain-webview
 * build never sees it. Presentation that is meant for the macOS app only
 * gates on this — Windows and Linux keep the cross-platform UI.
 */
export const hasMacosShell = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dataset.macosShell === '1'

/**
 * The handle the shell's Gallery menu drives.
 *
 * The Viewer keeps sole ownership of the index — this asks it to move, it
 * never sets it. The handle is published to the shell rather than to a
 * global, so the Tauri build never sees it.
 */
export type NavigationHandle = { current: { goTo(index: number): void } | null }

export const publishChrome = (handle: { current: ViewerChromeHandle | null }) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaChrome = {
    activate: (control) => handle.current?.activate(control),
    setActive: (active) => handle.current?.setActive(active),
    focusStage: () => handle.current?.focusStage(),
  }
}

export const publishNavigation = (handle: NavigationHandle) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaGoTo = (index: number) => {
    handle.current?.goTo(index)
  }
}

/**
 * Publish the way back to the Library.
 *
 * The shell's Gallery menu has a Close Gallery item, and the page owns the
 * state that decides what closing means — so the shell asks the page rather
 * than reaching into it.
 */
export const publishClose = (close: () => void) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaCloseGallery = close
}

/**
 * Publish the way to add a gallery.
 *
 * The native menu's "Open Folder…" item runs the Library's own add flow —
 * the page picks the folder, scans it and records it — rather than a
 * second, native path that would leave the two catalogues disagreeing.
 */
export const publishAddGallery = (add: () => void) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaAddGallery = add
}

/**
 * Publish the add flow itself — the one that picks, scans and records.
 *
 * The chooser sheet is the human way in; this is the same flow without the
 * sheet, so a test run can add a folder without clicking through a dialog.
 */
export const publishAddFolder = (add: () => void) => {
  const w = shellWindow()
  if (!w) return
  w.__manoramaAddFolder = add
}
