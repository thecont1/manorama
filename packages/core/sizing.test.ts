import { describe, expect, test } from 'bun:test'
import { advanceEasedPosition, clamp, glideEase, makeBezier } from './sizing'

describe('sizing geometry', () => {
  test('clamp preserves in-range values and limits both endpoints', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(4, 0, 10)).toBe(4)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  test('makeBezier preserves endpoints and evaluates representative linear values', () => {
    const linear = makeBezier(0, 0, 1, 1)
    expect(linear(0)).toBe(0)
    expect(Math.abs(linear(0.25) - 0.25)).toBeLessThan(1e-10)
    expect(Math.abs(linear(0.5) - 0.5)).toBeLessThan(1e-10)
    expect(linear(1)).toBe(1)
  })

  test('glideEase preserves endpoints and follows the signature ease-out curve', () => {
    expect(glideEase(0)).toBe(0)
    expect(Math.abs(glideEase(0.5) - 0.9613825478043228)).toBeLessThan(1e-12)
    expect(glideEase(1)).toBe(1)
  })
  test('incremental easing reproduces the signature curve for a fixed destination', () => {
    let current = -125
    let previous = 0
    for (let frame = 1; frame <= 60; frame++) {
      const ease = glideEase(frame / 60)
      current = advanceEasedPosition(current, -1800, previous, ease)
      expect(Math.abs(current - (-125 + (-1800 + 125) * ease))).toBeLessThan(1e-8)
      previous = ease
    }
  })
  test('a healed target moves only through the remaining ease, never jumps at the current time', () => {
    expect(advanceEasedPosition(-800, -1400, .8, .8)).toBe(-800)
    expect(Math.abs(advanceEasedPosition(-800, -1400, .8, .81) + 830)).toBeLessThan(1e-8)
    expect(advanceEasedPosition(-830, -1400, .81, 1)).toBe(-1400)
  })
})
