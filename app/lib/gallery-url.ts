import { galleryUrlWithPreservedHash } from '../../packages/core/encrypted-source'

export type GalleryHistoryWindow = Pick<Window, 'history' | 'location'>

/** The only production history-write seam. Callers pass path/query changes;
 * the current capability fragment survives unless the target has its own. */
export const rewriteGalleryHistory = (
  win: GalleryHistoryWindow,
  mode: 'push' | 'replace',
  state: unknown,
  nextUrl: string | URL,
): void => {
  const target = String(nextUrl)
  const rewritten = galleryUrlWithPreservedHash(target, win.location.hash)
  if (mode === 'push') win.history.pushState(state, '', rewritten)
  else win.history.replaceState(state, '', rewritten)
}

/** History methods do not emit popstate. This single wrapper owns the
 * monkey-patch needed by URL-reactive surfaces and restores it on cleanup. */
export const listenForGalleryHistoryWrites = (win: Window, listener: () => void): (() => void) => {
  const pushState = win.history.pushState
  const replaceState = win.history.replaceState
  win.history.pushState = function (...args) { pushState.apply(this, args); listener() }
  win.history.replaceState = function (...args) { replaceState.apply(this, args); listener() }
  return () => {
    win.history.pushState = pushState
    win.history.replaceState = replaceState
  }
}
