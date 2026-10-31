import { describe, expect, test } from 'bun:test'
import {
  composePlate,
  HOUSE_AD_CREATIVES,
  HOUSE_AD_FRAME,
  houseAdCreativeFor,
  houseAdFrameFor,
  PLATE_CADENCE,
  platePositionsFor,
  singlePlatePositionsFor,
  type AdFrame,
} from './adframe'
import { BundledSource, type GalleryImage } from './imagesource'

const photo = (id: string): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `https://example.test/${id}.jpg`, width: 1000,
  height: 700, alt: id, c2pa: false, placeholder: '',
})

const plate: AdFrame = {
  id: 'plate', advertiser: 'Example', badge: 'Ad', provider: 'admob-banner',
}

const photos = (count: number) => Array.from({ length: count }, (_, index) => photo(String(index)))

describe('seeded plate cadence', () => {
  test('lands around every 25th photograph with seeded jitter', () => {
    const positions = platePositionsFor(100, 'gallery:2026-09-24')
    expect(positions.length).toBe(3)
    for (const pos of positions) {
      expect(pos).toBeGreaterThanOrEqual(PLATE_CADENCE - 4)
      expect(pos).toBeLessThan(99)
    }
    positions.forEach((pos, index) => {
      if (index === 0) return
      const gap = pos - positions[index - 1]
      expect(gap).toBeGreaterThanOrEqual(PLATE_CADENCE - 4)
      expect(gap).toBeLessThanOrEqual(PLATE_CADENCE + 4)
    })
  })

  test('is deterministic for a seed and varies across seeds', () => {
    const dayOne = platePositionsFor(120, 'gallery:2026-09-24')
    expect(platePositionsFor(120, 'gallery:2026-09-24')).toEqual(dayOne)
    const dayTwo = platePositionsFor(120, 'gallery:2026-09-25')
    const galleryTwo = platePositionsFor(120, 'other:2026-09-24')
    expect(dayTwo).not.toEqual(dayOne)
    expect(galleryTwo).not.toEqual(dayOne)
  })

  test('never places first, last, or adjacent plates — and suppresses short galleries', () => {
    for (const seed of ['a:1', 'b:2', 'c:3', 'd:4', 'e:5']) {
      const positions = platePositionsFor(60, seed)
      expect(positions[0]).toBeGreaterThan(0)
      expect(positions.at(-1) ?? 0).toBeLessThan(59)
      positions.forEach((pos, index) => {
        if (index === 0) return
        expect(pos - positions[index - 1]).toBeGreaterThan(1)
      })
    }
    expect(platePositionsFor(20, 'anything')).toEqual([])
  })

  test('composePlate inserts one frame at each seeded position without mutating input', () => {
    const items = photos(60)
    const positions = platePositionsFor(60, 'gallery:2026-09-24')
    const composed = composePlate(items, plate, positions)
    expect(composed).toHaveLength(60 + positions.length)
    expect(composed.filter((item) => 'provider' in item)).toHaveLength(positions.length)
    positions.forEach((pos, plateIndex) => {
      // Each earlier plate shifts the runtime index by one.
      expect(composed[pos + plateIndex]).toBe(plate)
      expect(composed[pos + plateIndex + 1]).toBe(items[pos])
    })
    expect(composed[0]).toBe(items[0])
    expect(composed.at(-1)).toBe(items.at(-1))
    expect(items).toHaveLength(60)
  })

  test('returns the photo list untouched without a frame or positions', () => {
    const items = photos(60)
    expect(composePlate(items, null, [25])).toBe(items)
    expect(composePlate(items, plate, [])).toBe(items)
  })

  test('the interim single-plate rule picks one interior position per seed', () => {
    // Exactly one placement per gallery — never first, never last.
    for (const seed of ['a:1', 'b:2', 'c:3', 'd:4', 'e:5']) {
      const positions = singlePlatePositionsFor(60, seed)
      expect(positions).toHaveLength(1)
      expect(positions[0]).toBeGreaterThan(0)
      expect(positions[0]).toBeLessThan(59)
    }
    expect(singlePlatePositionsFor(60, 'x:1')).toEqual(singlePlatePositionsFor(60, 'x:1'))
    // Three photographs leaves exactly one interior slot; under three there
    // is no honest place a plate can sit, so the gallery stays clean.
    expect(singlePlatePositionsFor(3, 'x:1')).toEqual([1])
    expect(singlePlatePositionsFor(2, 'x:1')).toEqual([])
    expect(singlePlatePositionsFor(0, 'x:1')).toEqual([])
  })

  test('keeps the stored BundledSource sequence photo-only', () => {
    const items = photos(60)
    const source = new BundledSource({ slug: 'test', title: 'Test', caption: '', date: '', images: items })
    const before = JSON.stringify(source.list())
    const runtime = source.listWithPlate(plate, 'test:2026-09-24')
    expect(runtime.filter((item) => 'provider' in item)).toHaveLength(platePositionsFor(60, 'test:2026-09-24').length)
    expect(JSON.stringify(source.list())).toBe(before)
    expect(source.list()).toHaveLength(60)
  })
})

describe('interim house creatives', () => {
  test('the seeded pick is deterministic per scope and day and always in pool', () => {
    const picked = houseAdCreativeFor('gallery:2026-10-31')
    expect(HOUSE_AD_CREATIVES).toContain(picked)
    expect(houseAdCreativeFor('gallery:2026-10-31')).toBe(picked)
    // Every creative is a vertical asset served from the shared /ads folder.
    for (const creative of HOUSE_AD_CREATIVES) {
      expect(creative.src).toMatch(/^\/ads\//)
      expect(creative.height).toBeGreaterThan(creative.width)
    }
  })

  test('houseAdFrameFor varies the image by scope and day but keeps the frame', () => {
    const frame = houseAdFrameFor('gallery', '2026-10-31')
    expect(frame.id).toBe(HOUSE_AD_FRAME.id)
    expect(frame.provider).toBe('manorama-house')
    expect(frame.badge).toBe('Sponsored')
    expect(HOUSE_AD_CREATIVES).toContain(frame.image)
    expect(frame).not.toBe(HOUSE_AD_FRAME)
    // Same scope, same day: same creative. Different day may re-roll.
    expect(houseAdFrameFor('gallery', '2026-10-31').image).toEqual(frame.image)
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']
    const seen = new Set(days.map((day) => houseAdFrameFor('gallery', day).image?.src))
    expect(seen.size).toBeGreaterThan(1)
  })
})
