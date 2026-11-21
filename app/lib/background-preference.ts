/**
 * The "Canvas" preference: Dark (the default — light-ink doodle field on
 * the charcoal canvas) or Light (dark-ink doodles on the warm-paper
 * canvas). Both pairings put every photograph in a 10px optical margin,
 * so the artwork shows through the gaps between frames.
 *
 * The third historic value — 'none', the Blank canvas with photographs
 * abutting and no field — was retired by the owner: galleries now always
 * paint the approved artwork. Old stored 'none'/'flat'/false shapes
 * normalize onto the new default instead of resurrecting an unreachable
 * option. (The embedded marketing home demo keeps its bare edge-to-edge
 * layout through the Viewer's own gate, not through this preference.)
 *
 * App-wide chrome, not per-album styling — so it follows the
 * `manorama:theme` precedent and lives under one global key rather than
 * the per-slug `manorama:view:<slug>` bag. A visitor who picks a
 * background for one gallery expects it on the next one too; the
 * *pattern itself* still differs per URL, because that comes from the
 * seed, not from this flag.
 *
 * Every accessor is storage-failure tolerant: Safari private mode throws
 * on localStorage access, and a background preference is never worth an
 * exception on the render path.
 */

export type BackgroundPreference = 'light' | 'dark'

export const BACKGROUND_KEY = 'manorama:background'
export const DEFAULT_BACKGROUND: BackgroundPreference = 'dark'

/** Event fired on the window so every mounted island reacts to a change
 *  in the same tab (the native `storage` event only crosses tabs). */
export const BACKGROUND_EVENT = 'manorama:background-change'

/** Accepts the stored string. Only the two surviving pairings are
 *  distinguished: 'light' stays Light, and everything else lands on the
 *  Dark default — including the retired Blank shapes ('none', 'flat',
 *  false) and the historic 'doodle'/true pattern-on shapes, which always
 *  meant the dark doodle pairing. Junk is the same default. */
export const normalizeBackground = (value: unknown): BackgroundPreference =>
  value === 'light' ? 'light' : DEFAULT_BACKGROUND

export const loadBackgroundPreference = (): BackgroundPreference => {
  if (typeof window === 'undefined') return DEFAULT_BACKGROUND
  try {
    return normalizeBackground(window.localStorage.getItem(BACKGROUND_KEY))
  } catch {
    return DEFAULT_BACKGROUND
  }
}

export const saveBackgroundPreference = (value: BackgroundPreference): void => {
  if (typeof window === 'undefined') return
  const normalized = normalizeBackground(value)
  try {
    window.localStorage.setItem(BACKGROUND_KEY, normalized)
  } catch {
    // Private mode: the choice still works for this session.
  }
  try {
    // Prefer the window's own constructor: a synthetic/proxied window
    // (tests, embedded shims) will not accept an Event minted by a
    // different realm.
    const Ctor = (window as { CustomEvent?: typeof CustomEvent }).CustomEvent
      ?? (typeof CustomEvent === 'function' ? CustomEvent : undefined)
    if (Ctor) window.dispatchEvent(new Ctor(BACKGROUND_EVENT, { detail: normalized }))
  } catch {
    // CustomEvent is unavailable in some SSR-ish shims; not fatal.
  }
}

export const backgroundIsLight = (value: BackgroundPreference): boolean => value === 'light'

/** Same-tab listeners consume the custom event payload directly. Re-reading
 * localStorage here would undo the user's choice when storage is unavailable
 * (for example Safari private mode), even though the in-memory toggle worked. */
export const backgroundPreferenceFromEvent = (event: Pick<CustomEvent<unknown>, 'detail'>): BackgroundPreference =>
  normalizeBackground(event.detail)
