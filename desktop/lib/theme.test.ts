import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyTheme,
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

describe('theme vocabulary', () => {
  test('only the literal light is light; everything else is the dark default', () => {
    expect(parseTheme('light')).toBe('light')
    for (const value of ['dark', 'Light', '', null, undefined, 'light ']) {
      expect(parseTheme(value)).toBe('dark')
    }
    expect(DEFAULT_THEME).toBe('dark')
    expect(oppositeTheme('dark')).toBe('light')
    expect(oppositeTheme('light')).toBe('dark')
  })

  test('the control names the action it performs, as the web pane does', () => {
    expect(themeControlLabel('dark')).toBe('Switch to light mode')
    expect(themeControlLabel('light')).toBe('Switch to dark mode')
  })

  test('the stored choice is read back, and a missing or throwing store is dark', () => {
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'light' }))).toBe('light')
    expect(readStoredTheme(fakeStorage({ [THEME_KEY]: 'dark' }))).toBe('dark')
    expect(readStoredTheme(fakeStorage())).toBe('dark')
    expect(readStoredTheme(null)).toBe('dark')
    expect(readStoredTheme(undefined)).toBe('dark')
    // Private browsing can make storage throw on read; that is not an error
    // the catalogue should have to handle.
    expect(readStoredTheme({ getItem: () => { throw new Error('denied') } })).toBe('dark')
  })

  test('writing stores the theme, and a throwing store stays silent', () => {
    const storage = fakeStorage()
    storeTheme(storage, 'light')
    expect(storage.entries.get(THEME_KEY)).toBe('light')
    storeTheme(storage, 'dark')
    expect(storage.entries.get(THEME_KEY)).toBe('dark')
    expect(() => storeTheme({ setItem: () => { throw new Error('denied') } }, 'light')).not.toThrow()
    expect(() => storeTheme(null, 'light')).not.toThrow()
  })

  test('applying adds and removes the one class the shared stylesheet keys off', () => {
    const classes = new Set<string>()
    const root = { classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) } } }
    applyTheme('light', root)
    expect([...classes]).toEqual(['light'])
    applyTheme('light', root)
    expect([...classes]).toEqual(['light'])
    applyTheme('dark', root)
    expect([...classes]).toEqual([])
  })

  test('the storage key and class are the web dashboard\u2019s, not a desktop copy', () => {
    // A split here would silently give a Mac user two different themes. The
    // web pane is the authority; this fails the day the two drift apart.
    const shared = readFileSync(fileURLToPath(new URL('../../app/lib/owner-theme.ts', import.meta.url)), 'utf8')
    expect(shared).toContain(`'${THEME_KEY}'`)
    expect(shared).toContain(`classList.add('light')`)
    expect(shared).toContain(`classList.remove('light')`)
    const admin = readFileSync(fileURLToPath(new URL('../../app/islands/Admin.tsx', import.meta.url)), 'utf8')
    expect(admin).toContain(`from '../lib/owner-theme'`)
  })
})
