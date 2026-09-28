import { describe, expect, test } from 'bun:test'
import { desktopScreen, showPasteFallback } from './welcome'

describe('desktopScreen', () => {
  test('signed out with an empty catalogue shows the welcome screen', () => {
    expect(desktopScreen({ signedIn: false, galleryCount: 0 })).toBe('welcome')
  })
  test('signed out with saved galleries still shows the catalogue', () => {
    expect(desktopScreen({ signedIn: false, galleryCount: 2 })).toBe('catalogue')
  })
  test('signed in with an empty catalogue shows the catalogue', () => {
    expect(desktopScreen({ signedIn: true, galleryCount: 0 })).toBe('catalogue')
  })
  test('signed in with saved galleries shows the catalogue', () => {
    expect(desktopScreen({ signedIn: true, galleryCount: 2 })).toBe('catalogue')
  })
})

describe('showPasteFallback', () => {
  test('dev build signed out shows the paste box', () => {
    expect(showPasteFallback(true, false)).toBe(true)
  })
  test('dev build signed in hides the paste box', () => {
    expect(showPasteFallback(true, true)).toBe(false)
  })
  test('bundled build signed out hides the paste box', () => {
    expect(showPasteFallback(false, false)).toBe(false)
  })
  test('bundled build signed in hides the paste box', () => {
    expect(showPasteFallback(false, true)).toBe(false)
  })
})
