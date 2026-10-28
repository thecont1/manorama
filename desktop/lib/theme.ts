/** The owner theme helpers moved to `app/lib/owner-theme.ts` so the web and
 *  native bundles share them. This file stays as the desktop import site. */
export {
  DEFAULT_THEME,
  THEME_KEY,
  applyTheme,
  oppositeTheme,
  parseTheme,
  readStoredTheme,
  storeTheme,
  themeControlLabel,
} from '../../app/lib/owner-theme'
export type { Theme } from '../../app/lib/owner-theme'
