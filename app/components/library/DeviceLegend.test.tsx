import { describe, expect, test } from 'bun:test'
import { DeviceLegend, lastSeenLabel } from './DeviceLegend'
import type { Device } from '../../../packages/core/devices'

const SELF = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444'

const device = (overrides: Partial<Device> = {}): Device => ({
  id: SELF,
  kind: 'mac',
  ordinal: 1,
  colour: 0,
  firstSeenAt: '2026-10-01T09:00:00.000Z',
  lastSeenAt: '2026-11-14T13:50:00.000Z',
  ...overrides,
})

describe('the device legend', () => {
  test('one row per device: the pill, this device named, the other dated', () => {
    const html = String(DeviceLegend({
      devices: [device(), device({ id: OTHER, ordinal: 2, colour: 1, lastSeenAt: '2026-11-09T08:00:00.000Z' })],
      selfId: SELF,
    }))
    expect(html).toContain('Your devices')
    expect(html).toContain('>Mac 1<')
    expect(html).toContain('>Mac 2<')
    expect(html).toContain('this Mac')
    expect(html).toContain('last used 9 Nov 2026')
    // The two Macs never share a colour.
    expect(html).toContain('data-colour="0"')
    expect(html).toContain('data-colour="1"')
  })

  test('a lone device is just "Mac"', () => {
    const html = String(DeviceLegend({ devices: [device()], selfId: SELF }))
    expect(html).toContain('>Mac<')
    expect(html).not.toContain('Mac 1')
  })

  test('Forget is offered for other devices only, never for the one in use', () => {
    const withForget = String(DeviceLegend({
      devices: [device(), device({ id: OTHER, ordinal: 2, colour: 1 })],
      selfId: SELF,
      onForget: () => {},
    }))
    expect(withForget.match(/lib-devices-legend-forget/g)?.length).toBe(1)
    // The label names the device it forgets, not just its kind.
    expect(withForget).toContain('aria-label="Forget Mac 2"')
    const readOnly = String(DeviceLegend({ devices: [device(), device({ id: OTHER, ordinal: 2, colour: 1 })], selfId: SELF }))
    expect(readOnly).not.toContain('lib-devices-legend-forget')
  })

  test('an empty list renders nothing at all', () => {
    expect(DeviceLegend({ devices: [] })).toBeNull()
  })

  test('the last-seen wording is day precision and locale-free', () => {
    expect(lastSeenLabel('2026-11-09T23:30:00.000Z')).toBe('last used 9 Nov 2026')
    expect(lastSeenLabel('not a date')).toBe('last used recently')
  })
})
