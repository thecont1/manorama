import { describe, expect, test } from 'bun:test'
import {
  DEVICE_EXPIRY_DAYS,
  deviceShortName,
  findDevice,
  isDeviceExpired,
  isDeviceId,
  lowestFreeColour,
  parseDeviceRegistration,
  sortDevices,
  type Device,
} from './devices'
import { parseDeviceGalleryInput } from './device-gallery'

const device = (overrides: Partial<Device> = {}): Device => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  kind: 'mac',
  ordinal: 1,
  colour: 0,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
})

describe('parseDeviceRegistration', () => {
  test('accepts every known kind and nothing else', () => {
    expect(parseDeviceRegistration({ kind: 'mac' })).toEqual({ kind: 'mac' })
    expect(parseDeviceRegistration({ kind: 'ipad' })).toEqual({ kind: 'ipad' })
    expect(parseDeviceRegistration({ kind: 'toaster' })).toBeNull()
    expect(parseDeviceRegistration({ kind: 'Mac' })).toBeNull()
    expect(parseDeviceRegistration({})).toBeNull()
    expect(parseDeviceRegistration(null)).toBeNull()
    expect(parseDeviceRegistration([])).toBeNull()
  })

  test('a device says only its kind — a name in the body is a rejected body', () => {
    expect(parseDeviceRegistration({ kind: 'mac', label: 'Mahesh’s MacBook Pro' })).toBeNull()
  })
})

test('isDeviceId only admits the UUID shape the mirror rows use', () => {
  expect(isDeviceId('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true)
  expect(isDeviceId('device-aaaaaaaa')).toBe(false)
  expect(isDeviceId(42)).toBe(false)
})

describe('deviceShortName', () => {
  test('a lone device wears the bare platform name', () => {
    const mac = device()
    expect(deviceShortName(mac, [mac])).toBe('Mac')
  })

  test('a second device of the same kind numbers both', () => {
    const one = device()
    const two = device({ id: 'bbbbbbbb-0000-4000-8000-000000000002', ordinal: 2, colour: 1 })
    expect(deviceShortName(one, [one, two])).toBe('Mac 1')
    expect(deviceShortName(two, [one, two])).toBe('Mac 2')
  })

  test('a forgotten device leaves a gap rather than renumbering the survivor', () => {
    const two = device({ id: 'bbbbbbbb-0000-4000-8000-000000000002', ordinal: 2, colour: 1 })
    const three = device({ id: 'cccccccc-0000-4000-8000-000000000003', ordinal: 3, colour: 2 })
    expect(deviceShortName(two, [two, three])).toBe('Mac 2')
    expect(deviceShortName(three, [two, three])).toBe('Mac 3')
  })

  test('kinds number independently', () => {
    const mac = device()
    const phone = device({ id: 'bbbbbbbb-0000-4000-8000-000000000002', kind: 'iphone', ordinal: 1, colour: 1 })
    expect(deviceShortName(mac, [mac, phone])).toBe('Mac')
    expect(deviceShortName(phone, [mac, phone])).toBe('iPhone')
  })
})

test('sortDevices orders by kind, then the stored number', () => {
  const phone = device({ id: 'cccccccc-0000-4000-8000-000000000003', kind: 'iphone', ordinal: 1, colour: 2 })
  const macTwo = device({ id: 'bbbbbbbb-0000-4000-8000-000000000002', ordinal: 2, colour: 1 })
  const macOne = device()
  expect(sortDevices([phone, macTwo, macOne]).map((entry) => entry.id)).toEqual([macOne.id, macTwo.id, phone.id])
  // the input array is not reordered
  expect([phone, macTwo, macOne][0]).toBe(phone)
})

describe('lowestFreeColour', () => {
  test('an empty account starts at slot zero', () => {
    expect(lowestFreeColour([])).toBe(0)
  })

  test('a freed slot is reused before a new one is taken', () => {
    expect(lowestFreeColour([device({ colour: 0 }), device({ id: 'b', colour: 2 })])).toBe(1)
  })

  test('a full palette has nothing to give', () => {
    const full = Array.from({ length: 12 }, (_, colour) => device({ id: `device-${colour}`, colour }))
    expect(lowestFreeColour(full)).toBeNull()
  })
})

describe('isDeviceExpired', () => {
  const now = Date.parse('2026-07-01T00:00:00.000Z')

  test('a device seen inside the window stays', () => {
    expect(isDeviceExpired({ lastSeenAt: '2026-06-30T00:00:00.000Z' }, now)).toBe(false)
  })

  test('a device unseen for the whole window drops off', () => {
    const stale = new Date(now - (DEVICE_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()
    expect(isDeviceExpired({ lastSeenAt: stale }, now)).toBe(true)
  })

  test('an unreadable stamp is stale, not immortal', () => {
    expect(isDeviceExpired({ lastSeenAt: 'not a date' }, now)).toBe(true)
  })
})

test('findDevice answers null for a missing or absent id', () => {
  const mac = device()
  expect(findDevice([mac], mac.id)).toBe(mac)
  expect(findDevice([mac], 'bbbbbbbb-0000-4000-8000-000000000002')).toBeNull()
  expect(findDevice([mac], null)).toBeNull()
})

describe('parseDeviceGalleryInput', () => {
  const base = { title: 'Studio', sourceKind: 'folder', itemCount: 3, deviceId: 'aaaaaaaa-0000-4000-8000-000000000001' }

  test('a legacy label is accepted and never carried forward', () => {
    const parsed = parseDeviceGalleryInput({ ...base, deviceLabel: 'Mahesh’s MacBook Pro' })
    expect(parsed).not.toBeNull()
    expect(parsed).not.toHaveProperty('deviceLabel')
  })

  test('a malformed label is still a rejected body', () => {
    expect(parseDeviceGalleryInput({ ...base, deviceLabel: 'x'.repeat(81) })).toBeNull()
    expect(parseDeviceGalleryInput({ ...base, deviceLabel: '' })).toBeNull()
    expect(parseDeviceGalleryInput({ ...base, deviceLabel: 7 })).toBeNull()
  })

  test('an unknown key is still refused', () => {
    expect(parseDeviceGalleryInput({ ...base, deviceName: 'Studio Mac' })).toBeNull()
  })
})
