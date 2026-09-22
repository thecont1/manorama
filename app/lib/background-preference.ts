/**
 * The "Background" preference: doodle field or flat.
 *
 * App-wide chrome, not per-album styling — so it follows the
 * `manorama:theme` precedent and lives under one global key rather than
 * the per-slug `manorama:view:<slug>` bag. A visitor who turns the
 * pattern on for one gallery expects it on the next one too; the
 * *pattern itself* still differs per URL, because that comes from the
 * seed, not from this flag.
 *
 * Every accessor is storage-failure tolerant: Safari private mode throws
 * on localStorage access, and a background preference is never worth an
 * exception on the render path.
 */

export type BackgroundPreference = 'doodle' | 'flat'

export const BACKGROUND_KEY = 'manorama:background'
export const DEFAULT_BACKGROUND: BackgroundPreference = 'flat'

/** Event fired on the window so every mounted island reacts to a change
 *  in the same tab (the native `storage` event only crosses tabs). */
export const BACKGROUND_EVENT = 'manorama:background-change'

/** Accepts the stored string, and tolerates the boolean shape in case a
 *  caller persisted `true`/`false` instead. */
export const normalizeBackground = (value: unknown): BackgroundPreference => {
  if (value === 'doodle' || value === true || value === 'true') return 'doodle'
  if (value === 'flat' || value === false || value === 'false') return 'flat'
  return DEFAULT_BACKGROUND
}

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
    // Private mode: the toggle still works for this session.
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

export const backgroundEnabled = (value: BackgroundPreference): boolean => value === 'doodle'

/** Same-tab listeners consume the custom event payload directly. Re-reading
 * localStorage here would undo the user's choice when storage is unavailable
 * (for example Safari private mode), even though the in-memory toggle worked. */
export const backgroundPreferenceFromEvent = (event: Pick<CustomEvent<unknown>, 'detail'>): BackgroundPreference =>
  normalizeBackground(event.detail)
