import { describe, expect, test } from 'bun:test'
import {
  assertGalleryEditable,
  expiryCountdownText,
  GalleryPolicyError,
  isGalleryExpired,
  paidGalleryLimitError,
  PIPELINE_LOCK_MESSAGE,
} from './gallery-policy'

const NOW = '2026-10-01T00:00:00.000Z'

describe('gallery edit policy', () => {
  test('retained and legacy galleries remain editable', () => {
    expect(() => assertGalleryEditable({ retention: 'retained' })).not.toThrow()
    expect(() => assertGalleryEditable({})).not.toThrow()
  })

  test('pipeline galleries fail with the typed read-only error', () => {
    try {
      assertGalleryEditable({ retention: 'pipeline' })
      throw new Error('expected a GalleryPolicyError')
    } catch (error) {
      expect(error).toBeInstanceOf(GalleryPolicyError)
      expect((error as GalleryPolicyError).name).toBe('GalleryPolicyError')
      expect((error as GalleryPolicyError).code).toBe('GALLERY_READ_ONLY')
      expect((error as GalleryPolicyError).message).toBe(PIPELINE_LOCK_MESSAGE)
    }
  })

  test('the paid limit error preserves its public code and message', () => {
    const error = paidGalleryLimitError()
    expect(error).toBeInstanceOf(GalleryPolicyError)
    expect(error.name).toBe('GalleryPolicyError')
    expect(error.code).toBe('GALLERY_LIMIT')
    expect(error.message).toBe('Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.')
  })
})

describe('gallery expiry policy', () => {
  test('a pipeline gallery expires at the deadline, not one millisecond before', () => {
    expect(isGalleryExpired({ retention: 'pipeline', expiresAt: '2026-09-30T23:59:59.999Z' }, NOW)).toBe(true)
    expect(isGalleryExpired({ retention: 'pipeline', expiresAt: NOW }, NOW)).toBe(true)
    expect(isGalleryExpired({ retention: 'pipeline', expiresAt: '2026-10-01T00:00:00.001Z' }, NOW)).toBe(false)
  })

  test('retained, legacy, and undated pipeline galleries never expire', () => {
    expect(isGalleryExpired({ retention: 'retained', expiresAt: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false)
    expect(isGalleryExpired({ expiresAt: '2020-01-01T00:00:00.000Z' }, NOW)).toBe(false)
    expect(isGalleryExpired({ retention: 'pipeline', expiresAt: null }, NOW)).toBe(false)
    expect(isGalleryExpired({ retention: 'pipeline' }, NOW)).toBe(false)
  })
})

describe('the shared expiry countdown', () => {
  const now = Date.parse(NOW)

  test('quotes whole days then leftover hours', () => {
    expect(expiryCountdownText('2026-10-29T05:00:00.000Z', now)).toBe('28 days 5 hours')
    expect(expiryCountdownText('2026-10-02T00:00:00.000Z', now)).toBe('1 day')
    expect(expiryCountdownText('2026-10-02T01:00:00.000Z', now)).toBe('1 day 1 hour')
  })

  test('drops the days under one and the hours inside the last one', () => {
    expect(expiryCountdownText('2026-10-01T05:00:00.000Z', now)).toBe('5 hours')
    expect(expiryCountdownText('2026-10-01T01:00:00.000Z', now)).toBe('1 hour')
    expect(expiryCountdownText('2026-10-01T00:30:00.000Z', now)).toBe('under an hour')
  })

  test('an expired or undated gallery gives no countdown', () => {
    expect(expiryCountdownText('2026-09-30T00:00:00.000Z', now)).toBe('under an hour')
    expect(expiryCountdownText(null, now)).toBeNull()
    expect(expiryCountdownText(undefined, now)).toBeNull()
    expect(expiryCountdownText('not-a-date', now)).toBe('under an hour')
  })
})
