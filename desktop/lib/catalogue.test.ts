import { describe, expect, test } from 'bun:test'
import { parseDeviceGalleryInput } from '../../packages/core/device-gallery'
import { MAX_GALLERY_ITEMS } from '../../packages/core/imagesource'
import {
  deserializeLocalCatalogue,
  deviceGalleryInput,
  deviceGalleryRequest,
  newCatalogue,
  probeAllAvailability,
  probeAvailability,
  serializeLocalCatalogue,
  type LocalCatalogue,
  type LocalGalleryRecord,
} from './catalogue'

const DEVICE_ID = '1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b'

const record = (over: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  title: 'CARD',
  rootPath: '/Volumes/CARD',
  sourceKind: 'card',
  mountPoint: '/Volumes/CARD',
  itemCount: 2,
  items: [
    { id: 'DCIM/IMG_1.jpg', name: 'IMG_1.jpg', path: '/Volumes/CARD/DCIM/IMG_1.jpg' },
    { id: 'DCIM/IMG_2.jpg', name: 'IMG_2.jpg', path: '/Volumes/CARD/DCIM/IMG_2.jpg' },
  ],
  addedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const catalogue = (galleries: LocalGalleryRecord[] = [record()]): LocalCatalogue => ({
  ...newCatalogue(DEVICE_ID, 'This Mac'),
  galleries,
})

describe('catalogue serialization', () => {
  test('round-trips a catalogue intact', () => {
    const cat = catalogue()
    const parsed = deserializeLocalCatalogue(serializeLocalCatalogue(cat))
    expect(parsed).toEqual(cat)
  })

  test('rejects corrupt or foreign payloads instead of throwing', () => {
    expect(deserializeLocalCatalogue(null)).toBeNull()
    expect(deserializeLocalCatalogue('not json')).toBeNull()
    expect(deserializeLocalCatalogue('{}')).toBeNull()
    expect(deserializeLocalCatalogue(JSON.stringify({ version: 99, deviceId: DEVICE_ID, deviceLabel: 'x', galleries: [] }))).toBeNull()
    // A gallery entry missing its path must not load — partial records
    // would sync counts for sources that can no longer be found.
    const broken = catalogue([record({ rootPath: '' })])
    expect(deserializeLocalCatalogue(JSON.stringify(broken))).toBeNull()
  })
})

describe('availability transitions', () => {
  test('mounted → available, ejected → unavailable, remounted → available', async () => {
    const gallery = record()
    let mounted = true
    const exists = async (path: string) => mounted && path === '/Volumes/CARD'
    expect(await probeAvailability(gallery, exists)).toBe('available')
    mounted = false
    expect(await probeAvailability(gallery, exists)).toBe('unavailable')
    mounted = true
    expect(await probeAvailability(gallery, exists)).toBe('available')
  })

  test('a probing error reads as unavailable, and the record is never deleted', async () => {
    const gallery = record()
    const throwing = async () => {
      throw new Error('permission denied')
    }
    expect(await probeAvailability(gallery, throwing)).toBe('unavailable')
    const states = await probeAllAvailability([gallery, record({ id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', rootPath: '/Users/a/Photos', sourceKind: 'folder', mountPoint: undefined })], async (path) => path === '/Users/a/Photos')
    expect(states[gallery.id]).toBe('unavailable')
    expect(states['bbbbbbbb-cccc-4ddd-8eee-ffffffffffff']).toBe('available')
  })
})

describe('sync payload hygiene', () => {
  test('the PUT body contains only the parsed wire fields — no paths, names, or bytes', () => {
    const cat = catalogue()
    const gallery = cat.galleries[0]!
    const body = deviceGalleryInput(gallery, cat)
    expect(parseDeviceGalleryInput(body)).not.toBeNull()
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'deviceLabel', 'itemCount', 'sourceKind', 'title'])
    const serialized = JSON.stringify(body)
    // The strongest form of the contract: nothing from the local record can
    // appear in the payload, even if field names change later.
    expect(serialized).not.toContain('/Volumes')
    expect(serialized).not.toContain('IMG_')
    expect(serialized).not.toContain(gallery.rootPath)
    for (const item of gallery.items) {
      expect(serialized).not.toContain(item.path)
      expect(serialized).not.toContain(item.name)
      expect(serialized).not.toContain(item.id)
    }
    expect('path' in body).toBe(false)
    expect('items' in body).toBe(false)
    expect('rootPath' in body).toBe(false)
  })

  test('the whole catalogue syncs with zero path material even across galleries', () => {
    const second = record({
      id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      title: 'Photos',
      rootPath: '/Users/secret/Pictures/very-private-name',
      sourceKind: 'folder',
      mountPoint: undefined,
      items: [{ id: 'inner/shot.jpg', name: 'shot.jpg', path: '/Users/secret/Pictures/very-private-name/inner/shot.jpg' }],
    })
    const cat = catalogue([record(), second])
    const payload = cat.galleries.map((g) => JSON.stringify(deviceGalleryInput(g, cat))).join(',')
    expect(payload).not.toContain('secret')
    expect(payload).not.toContain('shot.jpg')
    expect(payload).not.toContain('/')
  })

  test('caps the wire itemCount at MAX_GALLERY_ITEMS while the record keeps the true total', () => {
    const oversized = record({ itemCount: MAX_GALLERY_ITEMS + 40 })
    const cat = catalogue([oversized])
    const input = deviceGalleryInput(oversized, cat)
    expect(input.itemCount).toBe(MAX_GALLERY_ITEMS)
    expect(oversized.itemCount).toBe(MAX_GALLERY_ITEMS + 40)
    expect(parseDeviceGalleryInput(input)).not.toBeNull()
  })

  test('deviceGalleryRequest describes the exact wire request', () => {
    const cat = catalogue()
    const gallery = cat.galleries[0]!
    const request = deviceGalleryRequest('https://manorama.xyz/', gallery, cat)
    expect(request.method).toBe('PUT')
    expect(request.url).toBe(`https://manorama.xyz/api/device-galleries/${gallery.id}`)
    expect(request.body).toEqual({
      title: 'CARD',
      sourceKind: 'card',
      itemCount: 2,
      deviceId: DEVICE_ID,
      deviceLabel: 'This Mac',
    })
    // The server-side parser is the contract's enforcement point.
    expect(parseDeviceGalleryInput(request.body)).toEqual(request.body)
  })
})
