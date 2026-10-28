import { describe, expect, test } from 'bun:test'
import { nativeDeviceKind, nativeDeviceLabel } from './device-label'

describe('native device wording', () => {
  test('uses iPhone, iPad and generic device labels without changing behavior', () => {
    expect(nativeDeviceLabel(nativeDeviceKind('ios', { userAgent: 'iPhone' }))).toBe('this iPhone')
    expect(nativeDeviceLabel(nativeDeviceKind('ios', { userAgent: 'iPad' }))).toBe('this iPad')
    expect(nativeDeviceLabel(nativeDeviceKind('android', {}))).toBe('this device')
  })

  test('recognises iPadOS desktop mode and does not call a desktop Mac an iPad', () => {
    expect(nativeDeviceKind('ios', { platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Macintosh' })).toBe('ipad')
    expect(nativeDeviceKind('web', { platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Macintosh' })).toBe('device')
  })
})
