import { describe, expect, test } from 'bun:test'
import { DeviceGalleriesSection } from './components/library/DeviceGalleriesSection'
import type { DeviceGallery } from '../packages/core/device-gallery'
import type { Device } from '../packages/core/devices'

/**
 * The web Library's Local section is metadata readout, never imagery: the
 * synced rows carry no paths by design, so the markup must never produce
 * an <img> or echo a filesystem path — there is nothing to fetch one with.
 * The device itself is a coloured pill, never the machine's name.
 */

const DEVICE_ID = '99999999-1111-4222-8333-444444444444'

const device = (overrides: Partial<Device> = {}): Device => ({
  id: DEVICE_ID,
  kind: 'mac',
  ordinal: 1,
  colour: 0,
  firstSeenAt: '2026-11-01T10:00:00.000Z',
  lastSeenAt: '2026-11-14T13:50:00.000Z',
  ...overrides,
})

const gallery = (overrides: Partial<DeviceGallery> = {}): DeviceGallery => ({
  id: 'eeeeeeee-1111-4222-8333-555555555555',
  title: 'UGANDA',
  sourceKind: 'folder',
  itemCount: 28,
  deviceId: DEVICE_ID,
  updatedAt: '2026-11-14T13:50:00.000Z',
  ...overrides,
})

describe('the web Local galleries section', () => {
  test('renders super-compact tiles — title, count and the device pill', () => {
    const html = String(DeviceGalleriesSection({
      galleries: [gallery(), gallery({ id: 'ffffffff-1111-4222-8333-555555555555', title: 'BRUXELLES', itemCount: 1 })],
      devices: [device()],
    }))
    expect(html).toContain('Local galleries')
    expect(html).toContain('(2)')
    // Six tiles land across wherever the thumbnail feed fits four — the
    // grid class is the density contract, not the full-width row list.
    expect(html).toContain('lib-device-grid')
    expect(html).not.toContain('lib-list')
    expect(html).toContain('UGANDA')
    expect(html).toContain('28 photographs')
    expect(html).toContain('1 photograph')
    expect(html).toContain('device-pill')
    expect(html).toContain('data-colour="0"')
    expect(html).toContain('>Mac<')
    expect(html).toContain('open them in the app')
    // No machine name can appear — the server never receives one.
    expect(html).not.toContain('MacBook')
  })

  test('two Macs wear different pills and their own numbers', () => {
    const secondId = 'aaaaaaaa-2222-4333-8444-555555555555'
    const html = String(DeviceGalleriesSection({
      galleries: [gallery(), gallery({ id: 'bbbbbbbb-2222-4333-8444-555555555555', deviceId: secondId })],
      devices: [device(), device({ id: secondId, ordinal: 2, colour: 1 })],
    }))
    expect(html).toContain('>Mac 1<')
    expect(html).toContain('>Mac 2<')
    expect(html).toContain('data-colour="1"')
  })

  test('a row whose device is off the account wears the neutral pill', () => {
    const html = String(DeviceGalleriesSection({ galleries: [gallery({ deviceId: 'cccccccc-2222-4333-8444-555555555555' })], devices: [device()] }))
    expect(html).toContain('Another device')
    expect(html).toContain('data-colour="none"')
  })

  test('never emits an image, a link, or a filesystem path', () => {
    const html = String(DeviceGalleriesSection({ galleries: [gallery()], devices: [device()] }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('/Users/')
    expect(html).not.toContain('manorama://')
    expect(html).not.toContain('asset:')
  })

  test('an empty feed renders no section', () => {
    expect(String(DeviceGalleriesSection({ galleries: [] }))).not.toContain('Local galleries')
  })
})
