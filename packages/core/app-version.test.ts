import { describe, expect, test } from 'bun:test'
import { APP_DOWNLOADS_URL, compareVersions, latestForSurface, updateAvailableFor } from './app-version'

describe('compareVersions', () => {
  test('orders by numeric segment, not lexicographically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0)
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0)
  })

  test('missing segments read as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  test('unparseable input compares equal — a bad manifest never nags', () => {
    expect(compareVersions('dev-build', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', 'nightly')).toBe(0)
  })
})

describe('latestForSurface', () => {
  const manifest = {
    version: '0.4.0',
    released: '2026-11-01',
    assets: { mac: 'v0.4.0/manorama-0.4.0.dmg' },
    mobile: { ios: { version: '1.2.0', url: 'https://apps.apple.com/app/manorama' } },
  }

  test('desktop surfaces share the top-level version and the downloads page', () => {
    expect(latestForSurface(manifest, 'macos')).toEqual({ version: '0.4.0', url: APP_DOWNLOADS_URL })
    expect(latestForSurface(manifest, 'windows')).toEqual({ version: '0.4.0', url: APP_DOWNLOADS_URL })
  })

  test('ios answers its store entry once published', () => {
    expect(latestForSurface(manifest, 'ios')).toEqual({ version: '1.2.0', url: 'https://apps.apple.com/app/manorama' })
  })

  test('a platform with no published listing answers null — no nag without a destination', () => {
    expect(latestForSurface(manifest, 'android')).toBeNull()
    expect(latestForSurface({ version: '0.4.0' }, 'ios')).toBeNull()
    expect(latestForSurface({ version: '0.4.0', mobile: { ios: { version: '1.2.0' } } }, 'ios')).toBeNull()
  })

  test('no manifest answers null', () => {
    expect(latestForSurface(null, 'macos')).toBeNull()
    expect(latestForSurface(undefined, 'ios')).toBeNull()
  })
})

describe('updateAvailableFor', () => {
  test('a newer published version surfaces', () => {
    expect(updateAvailableFor({ version: '0.4.0' }, 'macos', '0.3.1')).toEqual({ version: '0.4.0', url: APP_DOWNLOADS_URL })
  })

  test('the same or an older published version stays quiet', () => {
    expect(updateAvailableFor({ version: '0.4.0' }, 'macos', '0.4.0')).toBeNull()
    expect(updateAvailableFor({ version: '0.4.0' }, 'macos', '0.9.9')).toBeNull()
  })

  test('unparseable installed versions stay quiet', () => {
    expect(updateAvailableFor({ version: '0.4.0' }, 'macos', 'dev')).toBeNull()
  })
})
