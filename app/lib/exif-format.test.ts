import { describe, expect, test } from 'bun:test'
import { formatCaptured, formatExposure } from './exif-format'

describe('formatCaptured', () => {
  test('full timestamp with offset renders wall-clock date and time', () => {
    expect(formatCaptured('2026-11-22T14:05:09+05:30')).toBe('22 November 2026, 14:05')
  })

  test('seconds and fractional seconds are dropped', () => {
    expect(formatCaptured('2026-01-29T19:12:58.096827')).toBe('29 January 2026, 19:12')
  })

  test('date-only input drops the time', () => {
    expect(formatCaptured('2026-09-23')).toBe('23 September 2026')
  })

  test('space-separated timestamp parses too', () => {
    expect(formatCaptured('2026-03-14 10:30:00')).toBe('14 March 2026, 10:30')
  })

  test('unparseable input returns the raw string', () => {
    expect(formatCaptured('not a date')).toBe('not a date')
    expect(formatCaptured('2026-13-40T99:99:99')).toBe('2026-13-40T99:99:99')
    expect(formatCaptured('0000:00:00 00:00:00')).toBe('0000:00:00 00:00:00')
  })

  test('empty and missing input stay absent', () => {
    expect(formatCaptured(undefined)).toBeUndefined()
    expect(formatCaptured('')).toBeUndefined()
  })
})

describe('formatExposure', () => {
  test('joins aperture, shutter, ISO and focal length in order', () => {
    expect(formatExposure({
      aperture: 'f/2.8', shutter: '1/250 s', iso: 400, focalLength: '35 mm',
    })).toBe('f/2.8 · 1/250 s · ISO 400 · 35 mm')
  })

  test('present parts only, in order', () => {
    expect(formatExposure({ aperture: 'f/2', iso: 100 })).toBe('f/2 · ISO 100')
    expect(formatExposure({ focalLength: '23.5 mm' })).toBe('23.5 mm')
    expect(formatExposure({ shutter: '2 s' })).toBe('2 s')
  })

  test('non-positive or missing ISO is skipped; empty exif yields nothing', () => {
    expect(formatExposure({ iso: 0, aperture: 'f/4' })).toBe('f/4')
    expect(formatExposure({})).toBeUndefined()
    expect(formatExposure(undefined)).toBeUndefined()
  })
})
