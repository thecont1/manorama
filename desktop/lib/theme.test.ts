import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  applyThemeClass,
  DEFAULT_THEME,
  oppositeTheme,
  parseTheme,
  readStoredTheme,
  storeTheme,
  THEME_KEY,
  themeControlLabel,
} from './theme'

const fakeStorage = (initial: Record<string, string> = {}) => {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    entries,
  }
}

describe('desktop theme', () => {
  test('the key is the one the web dashboard writes', () => {
    // `app/islands/Admin.tsx` reads and writes this literal. Two keys would be
    // two preferences.
    expect(THEME_KEY).toBe('manorama:theme')
    expect(DEFAULT_THEME).toBe('dark')
  })

  test('only the stored literal light is light; everything else is dark', () => {
    expect(parseTheme('light')).toBe('light')
    for (const value of ['dark', 'Light', '', null, undefined, 'light ']) {
      expect(parseTheme(value)).toBe('dark')
    }
    expect(oppositeTheme('dark')).toBe('light')
    expect(oppositeTheme('light')).toBe('dark')
  })

  test('the label names the action, not the state', () => {
    expect(themeControlLabel('dark')).toBe('Switch to light mode')
    expect(themeControlLabel('light')).toBe('Switch to dark mode')
  })

  test('the stored choice is read back, and a missing or throwing store is dark', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'light' }))).toBe('light')
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'dark' }))).toBe('dark')
    expect(readStoredTheme(fakeStorage())).toBe('dark')
    expect(readStoredTheme(null)).toBe('dark')
    expect(readStoredTheme(undefined)).toBe('dark')
    // Private browsing can make storage throw on read; that is not an error.
    expect(readStoredTheme({ getItem: () => { throw new Error('locked') } })).toBe('dark')
  })

  test('a write that throws leaves the session themed', () => {
    const storage = fakeStorage()
    storeTheme('light', storage)
    expect(storage.entries.get(THEME_KEY)).toBe('light')
    storeTheme('dark', storage)
    expect(storage.entries.get(THEME_KEY)).toBe('dark')
    expect(() => storeTheme('light', { setItem: () => { throw new Error('denied') } })).not.toThrow()
    expect(() => storeTheme('light', null)).not.toThrow()
  })

  test('applying adds and removes the one class the shared stylesheet keys off', () => {
    const classes = new Set<string>()
    const root = { classList: { add: (name: string) => { classes.add(name) }, remove: (name: string) => { classes.delete(name) } } }
    applyThemeClass(root, 'light')
    expect([...classes]).toEqual(['light'])
    // Applied twice it is still one class: `add`/`remove`, never `toggle`.
    applyThemeClass(root, 'light')
    expect([...classes]).toEqual(['light'])
    applyThemeClass(root, 'dark')
    expect([...classes]).toEqual([])
  })

  test('the storage key and class are the web dashboard’s, not a desktop copy', () => {
    // A split here would silently give a Mac user two different themes. The web
    // pane is the authority; this fails the day the two drift apart.
    const admin = readFileSync(fileURLToPath(new URL('../../app/islands/Admin.tsx', import.meta.url)), 'utf8')
    expect(admin).toContain(`'${THEME_KEY}'`)
    expect(admin).toContain(`classList.add('light')`)
    expect(admin).toContain(`classList.remove('light')`)
  })
})