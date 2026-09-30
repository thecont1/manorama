import { describe, expect, test } from 'bun:test'
import { desktopScreen, showPasteFallback } from './welcome'

describe('desktopScreen', () => {
  // "Signed out with saved galleries still shows the catalogue" used to be
  // asserted here. That is precisely the behaviour the Mac shell dropped to
  // match the mobile shells, where sign-in precedes everything, so the case is
  // gone rather than inverted — the gallery count no longer enters the decision.
  test('a signed-out launch shows the welcome surface', () => {
    expect(desktopScreen({ signedIn: false })).toBe('welcome')
  })
  test('a signed-in launch shows the catalogue, even when it is empty', () => {
    expect(desktopScreen({ signedIn: true })).toBe('catalogue')
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
