import { describe, expect, test } from 'bun:test'
import { clamp, glideEase, makeBezier } from './sizing'

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
})
