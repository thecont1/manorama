import { describe, expect, test } from 'bun:test'
import { composePlate, plateIndexFor, type AdFrame } from './adframe'
import { BundledSource, type GalleryImage } from './imagesource'

const photo = (id: string): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `https://example.test/${id}.jpg`, width: 1000,
  height: 700, alt: id, c2pa: false, placeholder: '',
})

const plate: AdFrame = {
  id: 'plate', advertiser: 'Example', badge: 'Ad', provider: 'admob-banner',
}

describe('runtime ad plate composition', () => {
  test('inserts one plate at the deterministic interior midpoint for eight photos', () => {
    const photos = Array.from({ length: 8 }, (_, index) => photo(String(index)))
    const composed = composePlate(photos, plate)
    expect(composed).toHaveLength(9)
    expect(composed[plateIndexFor(photos.length) ?? -1]).toBe(plate)
    expect(composed[0]).toBe(photos[0])
    expect(composed.at(-1)).toBe(photos.at(-1))
    expect(photos).toHaveLength(8)
  })

  test('suppresses the plate below eight photos and for missing frames', () => {
    const photos = Array.from({ length: 7 }, (_, index) => photo(String(index)))
    expect(composePlate(photos, plate)).toBe(photos)
    expect(composePlate([...photos, photo('7')], null)).toHaveLength(8)
    expect(plateIndexFor(7)).toBeNull()
  })

  test('places one plate only, never at an endpoint', () => {
    const photos = Array.from({ length: 24 }, (_, index) => photo(String(index)))
    const composed = composePlate(photos, plate)
    expect(composed.filter((item) => 'provider' in item)).toEqual([plate])
    expect(composed[0]).not.toBe(plate)
    expect(composed.at(-1)).not.toBe(plate)
  })

  test('keeps the stored BundledSource sequence photo-only', () => {
    const photos = Array.from({ length: 8 }, (_, index) => photo(String(index)))
    const source = new BundledSource({ slug: 'test', title: 'Test', caption: '', date: '', images: photos })
    const before = JSON.stringify(source.list())
    const runtime = source.listWithPlate(plate)
    expect(runtime.filter((item) => 'provider' in item)).toEqual([plate])
    expect(JSON.stringify(source.list())).toBe(before)
    expect(source.list()).toHaveLength(8)
  })
})
