/**
 * The desktop catalogue's light/dark choice is the web dashboard's choice:
 * one storage key, one `<html>` class, one control label. Both surfaces paint
 * from the same stylesheet (`desktop/styles.css` imports `app/styles.css`), so
 * a Mac user who picked Light on manorama.xyz finds Light here.
 */

export type Theme = 'light' | 'dark'

/** The key `app/islands/Admin.tsx` writes. Changing it here without changing
 *  it there would split one preference into two. */
export const THEME_KEY = 'manorama:theme'

/** Dark is the photographic default — the stage is a neutral near-black. */
export const DEFAULT_THEME: Theme = 'dark'

/** Only the stored literal `light` is light, so a corrupt or hand-edited value
 *  degrades to the default rather than to no theme at all. */
export const parseTheme = (value: string | null | undefined): Theme =>
  value === 'light' ? 'light' : DEFAULT_THEME

export const oppositeTheme = (theme: Theme): Theme => theme === 'light' ? 'dark' : 'light'

/** The label names the action, not the state. */
export const themeControlLabel = (theme: Theme): string =>
  theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'

/** Storage can throw (private mode, a locked store); a failed read is the
 *  default theme, never an error the catalogue has to handle. */
export const readStoredTheme = (storage?: Pick<Storage, 'getItem'> | null): Theme => {
  if (!storage) return DEFAULT_THEME
  try {
    return parseTheme(storage.getItem(THEME_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

export const storeTheme = (theme: Theme, storage?: Pick<Storage, 'setItem'> | null): void => {
  if (!storage) return
  try {
    storage.setItem(THEME_KEY, theme)
  } catch {
    // A theme that cannot persist still applies for this session.
  }
}

type ClassRoot = { classList: Pick<DOMTokenList, 'add' | 'remove'> }

/** The class the whole stylesheet hangs off: `html.light` flips `--ink` and
 *  every ink-derived colour on both the web dashboard and this catalogue. */
export const applyThemeClass = (root: ClassRoot, theme: Theme): void => {
  if (theme === 'light') root.classList.add('light')
  else root.classList.remove('light')
}