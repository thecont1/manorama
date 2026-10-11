/**
 * The desktop shell's light/dark choice IS the web dashboard's choice: one
 * storage key, one `<html>` class, one control label. A Mac user who picked
 * Light on manorama.xyz finds Light here, because `desktop/styles.css` imports
 * `app/styles.css` and therefore the same `html.light` rules paint both
 * surfaces. Nothing is re-declared per platform — only the key and the class
 * name are shared constants.
 */

export type Theme = 'light' | 'dark'

/** The web dashboard writes this key; the desktop reads and writes the same
 *  one. Changing it here without changing `Admin.tsx` would split the two. */
export const THEME_KEY = 'manorama:theme'

/** Dark is the photographic default — the stage is a neutral near-black. */
export const DEFAULT_THEME: Theme = 'dark'

/** Anything that is not the stored literal `light` is dark, so a corrupt or
 *  hand-edited value degrades to the default rather than to no theme at all. */
export const parseTheme = (value: string | null | undefined): Theme =>
  value === 'light' ? 'light' : DEFAULT_THEME

/** The label names the action, not the state — the same copy the web pane
 *  uses, so the control reads identically on both surfaces. */
export const themeControlLabel = (theme: Theme): string =>
  theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'

/** Storage can throw (private mode, disabled storage); a failed read is the
 *  default theme, never an error the catalogue has to handle. */
export const readStoredTheme = (
  storage?: Pick<Storage, 'getItem'> | null,
): Theme => {
  if (!storage) return DEFAULT_THEME
  try {
    return parseTheme(storage.getItem(THEME_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

export const storeTheme = (
  storage: Pick<Storage, 'setItem'> | null | undefined,
  theme: Theme,
): void => {
  try {
    storage?.setItem(THEME_KEY, theme)
  } catch {
    // Private browsing: the theme still applies for this session.
  }
}

/** Flips the document root exactly as `Admin.tsx` does — `add`/`remove` rather
 *  than `toggle`, so the class can never be left on the wrong side. */
export const applyTheme = (
  theme: Theme,
  root: { classList: Pick<DOMTokenList, 'add' | 'remove'> },
): void => {
  if (theme === 'light') root.classList.add('light')
  else root.classList.remove('light')
}

export const oppositeTheme = (theme: Theme): Theme => theme === 'dark' ? 'light' : 'dark'