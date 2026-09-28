/**
 * Which top-level surface the desktop shell shows: the landing-style welcome
 * is only for a signed-out launch with an empty catalogue — anyone with saved
 * galleries or a session goes straight to the catalogue.
 */
export const desktopScreen = (state: {
  signedIn: boolean
  galleryCount: number
}): 'welcome' | 'catalogue' => (!state.signedIn && state.galleryCount === 0 ? 'welcome' : 'catalogue')

/**
 * The paste-the-link fallback exists only because a `tauri dev` build cannot
 * receive deep links — bundled builds never show it, and a signed-in user
 * never needs it.
 */
export const showPasteFallback = (isDev: boolean, signedIn: boolean): boolean => isDev && !signedIn
