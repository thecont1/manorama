import { describe, expect, test } from 'bun:test'
import { toSummary, type GalleryRecord } from './gallery-repository'
import type { GalleryImage, VideoItem } from './imagesource'

const still = (id: string, hidden = false): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3,
  alt: 'a photograph', c2pa: false, placeholder: '', ...(hidden ? { hidden: true as const } : {}),
})
const video = (id: string, hidden = false): VideoItem => ({
  type: 'video', id, filename: `${id}.mp4`, src: `/videos/${id}.mp4`, mimeType: 'video/mp4',
  width: 4, height: 3, poster: { src: `/posters/${id}.jpg`, width: 4, height: 3 },
  alt: 'a video', c2pa: false, placeholder: '', ...(hidden ? { hidden: true as const } : {}),
})
const record = (images: GalleryRecord['images']): GalleryRecord => ({
  slug: 'mixed', title: 'Mixed', caption: '', date: '', images,
})

describe('toSummary mediaCount', () => {
  test('counts visible stills and videos separately and hidden on its own', () => {
    const summary = toSummary(record([still('a'), still('b'), video('v'), still('hid-p', true), video('hid-v', true)]))
    expect(summary.mediaCount).toEqual({ stills: 2, videos: 1, hidden: 2 })
    // imageCount stays the full count — the vault's "Saving n of m" reads it.
    expect(summary.imageCount).toBe(5)
  })

  test('an all-still gallery reports no videos and no hidden', () => {
    const summary = toSummary(record([still('a'), still('b')]))
    expect(summary.mediaCount).toEqual({ stills: 2, videos: 0, hidden: 0 })
  })

  test('a fully hidden gallery reports zero visible media', () => {
    const summary = toSummary(record([still('a', true), video('v', true)]))
    expect(summary.mediaCount).toEqual({ stills: 0, videos: 0, hidden: 2 })
  })
})
