import { describe, expect, test } from 'bun:test'
import { formatDuration } from './islands/VideoSlide'
import { reconstructSourceUrl } from './quickadd'

/**
 * Client-side pieces that are pure enough to pin directly: the duration
 * chip's formatting, and the URL reconstruction that makes fragment-bearing
 * MEGA/iCloud links survive the trip through our own path.
 */

describe('formatDuration', () => {
  test('formats minutes and zero-padded seconds', () => {
    expect(formatDuration(97)).toBe('1:37')
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(60)).toBe('1:00')
    expect(formatDuration(3600)).toBe('60:00')
  })

  test('rounds fractional seconds', () => {
    expect(formatDuration(12.4)).toBe('0:12')
    expect(formatDuration(12.6)).toBe('0:13')
  })

  test('returns null when there is no usable duration', () => {
    // The chip then falls back to a bare VIDEO label.
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(-4)).toBeNull()
    expect(formatDuration(Number.NaN)).toBeNull()
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('reconstructSourceUrl', () => {
  test('carries the fragment the server never saw — the whole point', () => {
    // A MEGA key lives after '#'; browsers never transmit it.
    expect(reconstructSourceUrl({
      pathname: '/https://mega.nz/folder/AbCdEf12',
      search: '',
      hash: '#a2V5LXNlY3JldA',
    })).toBe('https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA')
  })

  test('keeps the query string alongside the fragment', () => {
    expect(reconstructSourceUrl({
      pathname: '/https://www.dropbox.com/scl/fo/abc/xyz',
      search: '?rlkey=secret&dl=0',
      hash: '',
    })).toBe('https://www.dropbox.com/scl/fo/abc/xyz?rlkey=secret&dl=0')
  })

  test('restores the collapsed scheme separator', () => {
    expect(reconstructSourceUrl({ pathname: '/https:/mega.nz/folder/Ab', search: '', hash: '#k' }))
      .toBe('https://mega.nz/folder/Ab#k')
  })

  test('prepends https for a scheme-less paste', () => {
    expect(reconstructSourceUrl({ pathname: '/mega.nz/folder/Ab', search: '', hash: '#k' }))
      .toBe('https://mega.nz/folder/Ab#k')
  })

  test('decodes percent-encoding and survives a malformed escape', () => {
    expect(reconstructSourceUrl({ pathname: '/https%3A%2F%2Fmega.nz%2Ffolder%2FAb', search: '', hash: '' }))
      .toBe('https://mega.nz/folder/Ab')
    expect(() => reconstructSourceUrl({ pathname: '/https://mega.nz/folder/100%', search: '', hash: '' })).not.toThrow()
  })

  test('an iCloud album token in the fragment round-trips intact', () => {
    expect(reconstructSourceUrl({
      pathname: '/https://www.icloud.com/sharedalbum/',
      search: '',
      hash: '#B0z5qAGN1JIFd3y',
    })).toBe('https://www.icloud.com/sharedalbum/#B0z5qAGN1JIFd3y')
  })
})
