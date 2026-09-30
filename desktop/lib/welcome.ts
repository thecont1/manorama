/**
 * Which top-level surface the desktop shell shows. A signed-out launch always
 * lands on the welcome surface, because signing in is the only thing anyone can
 * do until they have: the Mac shell used to open the catalogue for a signed-out
 * owner with saved galleries, which let a local folder be opened before sign-in
 * and put the Mac out of step with the mobile shells. Nothing is lost — the
 * saved catalogue reappears the moment the session restores.
 */
export const desktopScreen = (state: { signedIn: boolean }): 'welcome' | 'catalogue' =>
  state.signedIn ? 'catalogue' : 'welcome'

/**
 * The paste-the-link fallback exists only because a `tauri dev` build cannot
 * receive deep links — bundled builds never show it, and a signed-in user
 * never needs it.
 */
export const showPasteFallback = (isDev: boolean, signedIn: boolean): boolean => isDev && !signedIn
