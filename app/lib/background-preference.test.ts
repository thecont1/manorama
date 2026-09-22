import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import {
  BACKGROUND_EVENT,
  BACKGROUND_KEY,
  DEFAULT_BACKGROUND,
  backgroundIsLight,
  backgroundPreferenceFromEvent,
  loadBackgroundPreference,
  normalizeBackground,
  saveBackgroundPreference,
} from './background-preference'

/**
 * The background toggle is app-wide chrome stored under one key, like
 * the theme. These cover the round trip, the tolerant parsing of junk
 * values, and the storage failures a private-mode browser throws.
 */

const globals = globalThis as Record<string, unknown>
let previousWindow: unknown

beforeEach(() => {
  previousWindow = globals.window
  globals.window = new Window({ width: 1200, height: 800 })
})

afterEach(() => {
  globals.window = previousWindow
})

describe('normalizeBackground', () => {
  test('accepts the two canonical values', () => {
    expect(normalizeBackground('light')).toBe('light')
    expect(normalizeBackground('dark')).toBe('dark')
  })

  test('migrates the pre-doodle-always shapes onto the dark pairing', () => {
    // 'doodle'/true meant the pattern was on: that is now the default dark
    // canvas. 'flat'/false simply had it off — there is no off any more.
    expect(normalizeBackground('doodle')).toBe('dark')
    expect(normalizeBackground(true)).toBe('dark')
    expect(normalizeBackground('true')).toBe('dark')
    expect(normalizeBackground('flat')).toBe('dark')
    expect(normalizeBackground(false)).toBe('dark')
  })

  test('falls back to the default for anything else', () => {
    for (const junk of [null, undefined, '', 'yes', 0, 1, {}, [], Number.NaN]) {
      expect(normalizeBackground(junk)).toBe(DEFAULT_BACKGROUND)
    }
  })
})

describe('persistence', () => {
  test('defaults to dark so existing galleries are untouched', () => {
    expect(loadBackgroundPreference()).toBe('dark')
    expect(backgroundIsLight('dark')).toBe(false)
    expect(backgroundIsLight('light')).toBe(true)
  })

  test('round-trips through localStorage under one global key', () => {
    saveBackgroundPreference('light')
    expect(loadBackgroundPreference()).toBe('light')
    const win = globals.window as unknown as Window
    expect(win.localStorage.getItem(BACKGROUND_KEY)).toBe('light')

    saveBackgroundPreference('dark')
    expect(loadBackgroundPreference()).toBe('dark')
  })

  test('a corrupt stored value degrades to the default', () => {
    const win = globals.window as unknown as Window
    win.localStorage.setItem(BACKGROUND_KEY, '{"nonsense":true}')
    expect(loadBackgroundPreference()).toBe(DEFAULT_BACKGROUND)
  })

  test('announces the change so open islands react in the same tab', () => {
    const win = globals.window as unknown as Window
    let heard: string | null = null
    win.addEventListener(BACKGROUND_EVENT, ((event: { detail?: unknown }) => { heard = String(event.detail) }) as never)
    saveBackgroundPreference('light')
    expect(heard).toBe('light')
  })

  test('reads the same-tab custom event detail without depending on storage', () => {
    expect(backgroundPreferenceFromEvent({ detail: 'light' })).toBe('light')
    expect(backgroundPreferenceFromEvent({ detail: 'dark' })).toBe('dark')
    expect(backgroundPreferenceFromEvent({ detail: 'corrupt' })).toBe(DEFAULT_BACKGROUND)
  })

  test('a throwing localStorage never breaks the render path', () => {
    // happy-dom's `localStorage` is readonly, so stand in a minimal
    // window whose storage throws the way Safari private mode does.
    globals.window = {
      localStorage: {
        getItem: () => { throw new Error('private mode') },
        setItem: () => { throw new Error('private mode') },
      },
      dispatchEvent: () => true,
    }
    expect(loadBackgroundPreference()).toBe(DEFAULT_BACKGROUND)
    expect(() => saveBackgroundPreference('light')).not.toThrow()
  })

  test('reads as dark when there is no window at all (SSR)', () => {
    globals.window = undefined
    expect(loadBackgroundPreference()).toBe(DEFAULT_BACKGROUND)
    expect(() => saveBackgroundPreference('light')).not.toThrow()
  })
})
