import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_THEME,
  THEME_KEY,
  applyTheme,
  oppositeTheme,
  parseTheme,
  readStoredTheme,
  storeTheme,
  themeControlLabel,
} from './owner-theme'

const fakeStorage = (impl?: Partial<Storage>) => impl as Storage

describe('owner-theme', () => {
  test('parseTheme: only the literal light survives', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    expect(parseTheme('garbage')).toBe(DEFAULT_THEME)
    expect(parseTheme(null)).toBe(DEFAULT_THEME)
    expect(parseTheme(undefined)).toBe(DEFAULT_THEME)
  })

  test('readStoredTheme: no storage and throwing storage both fall back', () => {
    expect(readStoredTheme(null)).toBe(DEFAULT_THEME)
    expect(readStoredTheme(undefined)).toBe(DEFAULT_THEME)
    expect(readStoredTheme(fakeStorage({ getItem: () => 'light' }))).toBe('light')
    expect(readStoredTheme(fakeStorage({
      getItem: () => { throw new Error('denied') },
    }))).toBe(DEFAULT_THEME)
  })

  test('storeTheme writes THEME_KEY and swallows storage failures', () => {
    let written: string | null = null
    storeTheme(fakeStorage({ setItem: (k, v) => { written = `${k}=${v}` } }), 'light')
    expect(written).toBe(`${THEME_KEY}=light`)
    expect(() => storeTheme(fakeStorage({
      setItem: () => { throw new Error('denied') },
    }), 'dark')).not.toThrow()
    expect(() => storeTheme(null, 'dark')).not.toThrow()
  })

  test('applyTheme adds or removes the light class — never toggles', () => {
    const added: string[] = []
    const removed: string[] = []
    const root = { classList: { add: (c: string) => added.push(c), remove: (c: string) => removed.push(c) } }
    applyTheme('light', root as never)
    applyTheme('dark', root as never)
    expect(added).toEqual(['light'])
    expect(removed).toEqual(['light'])
  })

  test('labels and opposites stay paired', () => {
    expect(themeControlLabel('dark')).toBe('Switch to light mode')
    expect(themeControlLabel('light')).toBe('Switch to dark mode')
    expect(oppositeTheme('dark')).toBe('light')
    expect(oppositeTheme('light')).toBe('dark')
  })
})
