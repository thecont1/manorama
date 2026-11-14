import { describe, expect, test } from 'bun:test'
import {
  deviceListingOutcome,
  keyListingDiffers,
  manifestKeyOf,
  SOURCE_CHECK_INTERVAL_MS,
  sourceCheckDue,
  versionedListingDiffers,
} from './source-freshness'

const item = (filename: string, overrides: { ref?: string; contentVersion?: string } = {}) => ({ filename, ...overrides })

describe('sourceCheckDue', () => {
  const now = Date.parse('2026-11-01T00:00:00.000Z')

  test('a never-checked gallery is due', () => {
    expect(sourceCheckDue(null, now)).toBe(true)
    expect(sourceCheckDue(undefined, now)).toBe(true)
  })

  test('a check inside the interval is not due', () => {
    const recent = new Date(now - SOURCE_CHECK_INTERVAL_MS + 1000).toISOString()
    expect(sourceCheckDue(recent, now)).toBe(false)
  })

  test('a check exactly at the interval is due', () => {
    const boundary = new Date(now - SOURCE_CHECK_INTERVAL_MS).toISOString()
    expect(sourceCheckDue(boundary, now)).toBe(true)
  })

  test('an unparseable stamp counts as never checked', () => {
    expect(sourceCheckDue('not-a-date', now)).toBe(true)
  })
})

describe('manifestKeyOf', () => {
  test('ref wins over filename — the provider-stable id is the identity', () => {
    expect(manifestKeyOf(item('name.jpg', { ref: 'file-id-1' }))).toBe('file-id-1')
    expect(manifestKeyOf(item('name.jpg'))).toBe('name.jpg')
  })
})

describe('versionedListingDiffers', () => {
  const stored = [item('a.jpg', { contentVersion: '1' }), item('b.jpg', { ref: 'id-b', contentVersion: '2' })]

  test('matching keys and versions answer unchanged', () => {
    expect(versionedListingDiffers(stored, [{ key: 'a.jpg', version: '1' }, { key: 'id-b', version: '2' }])).toBe('unchanged')
  })

  test('order is not a change — the refresh merge preserves ordering', () => {
    expect(versionedListingDiffers(stored, [{ key: 'id-b', version: '2' }, { key: 'a.jpg', version: '1' }])).toBe('unchanged')
  })

  test('a moved version answers changed', () => {
    expect(versionedListingDiffers(stored, [{ key: 'a.jpg', version: '1' }, { key: 'id-b', version: '3' }])).toBe('changed')
  })

  test('a new source item answers changed', () => {
    expect(versionedListingDiffers(stored, [
      { key: 'a.jpg', version: '1' }, { key: 'id-b', version: '2' }, { key: 'c.jpg', version: '9' },
    ])).toBe('changed')
  })

  test('a removed source item answers changed', () => {
    expect(versionedListingDiffers(stored, [{ key: 'a.jpg', version: '1' }])).toBe('changed')
  })

  test('missing versions on a matching set answer unknown — never unchanged', () => {
    const legacy = [item('a.jpg'), item('b.jpg', { ref: 'id-b' })]
    expect(versionedListingDiffers(legacy, [{ key: 'a.jpg' }, { key: 'id-b' }])).toBe('unknown')
    expect(versionedListingDiffers(stored, [{ key: 'a.jpg', version: '1' }, { key: 'id-b' }])).toBe('unknown')
  })

  test('a missing version still cannot hide a real difference', () => {
    const legacy = [item('a.jpg'), item('gone.jpg')]
    expect(versionedListingDiffers(legacy, [{ key: 'a.jpg' }])).toBe('changed')
  })
})

describe('keyListingDiffers', () => {
  const stored = [item('a.jpg'), item('b.jpg', { ref: 'uid-b' })]

  test('the same key set answers unchanged', () => {
    expect(keyListingDiffers(stored, ['a.jpg', 'uid-b'])).toBe('unchanged')
    expect(keyListingDiffers(stored, ['uid-b', 'a.jpg'])).toBe('unchanged')
  })

  test('adds and removals answer changed', () => {
    expect(keyListingDiffers(stored, ['a.jpg', 'uid-b', 'uid-c'])).toBe('changed')
    expect(keyListingDiffers(stored, ['a.jpg'])).toBe('changed')
  })
})

describe('deviceListingOutcome', () => {
  const stored = [item('a.jpg', { ref: 'node-1', contentVersion: 'hash-1' })]

  test('a truncated device listing can prove nothing — unknown', () => {
    expect(deviceListingOutcome(stored, { images: stored, truncated: 42 })).toBe('unknown')
  })

  test('a matching device listing answers unchanged', () => {
    expect(deviceListingOutcome(stored, { images: [{ filename: 'a.jpg', ref: 'node-1', contentVersion: 'hash-1' }] })).toBe('unchanged')
  })

  test('a moved or added item answers changed', () => {
    expect(deviceListingOutcome(stored, { images: [{ filename: 'a.jpg', ref: 'node-1', contentVersion: 'hash-2' }] })).toBe('changed')
    expect(deviceListingOutcome(stored, { images: [
      { filename: 'a.jpg', ref: 'node-1', contentVersion: 'hash-1' },
      { filename: 'b.jpg', ref: 'node-2', contentVersion: 'hash-2' },
    ] })).toBe('changed')
  })
})
