import { describe, expect, test } from 'bun:test'
import { DeviceGalleriesSection } from './components/library/DeviceGalleriesSection'
import type { DeviceGallery } from '../packages/core/device-gallery'

/**
 * The web Library's Local section is metadata readout, never imagery: the
 * synced rows carry no paths by design, so the markup must never produce
 * an <img> or echo a filesystem path — there is nothing to fetch one with.
 */

const gallery = (overrides: Partial<DeviceGallery> = {}): DeviceGallery => ({
  id: 'eeeeeeee-1111-4222-8333-555555555555',
  title: 'UGANDA',
  sourceKind: 'folder',
  itemCount: 28,
  deviceId: '99999999-1111-4222-8333-444444444444',
  deviceLabel: 'Mahesh’s MacBook Pro',
  updatedAt: '2026-11-14T13:50:00.000Z',
  ...overrides,
})

describe('the web Local galleries section', () => {
  test('renders tiles in a compact grid — title, count and device label', () => {
    const html = String(DeviceGalleriesSection({ galleries: [gallery(), gallery({ id: 'ffffffff-1111-4222-8333-555555555555', title: 'BRUXELLES', itemCount: 1 })] }))
    expect(html).toContain('Local galleries')
    expect(html).toContain('(2)')
    // Six tiles land across wherever the thumbnail feed fits four — the
    // grid class is the density contract, not the full-width row list.
    expect(html).toContain('lib-device-grid')
    expect(html).not.toContain('lib-list')
    expect(html).toContain('UGANDA')
    expect(html).toContain('28 photographs')
    expect(html).toContain('1 photograph')
    expect(html).toContain('Mahesh’s MacBook Pro')
    expect(html).toContain('open them in the app')
  })

  test('never emits an image, a link, or a filesystem path', () => {
    const html = String(DeviceGalleriesSection({ galleries: [gallery()] }))
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
