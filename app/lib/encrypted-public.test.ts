import { describe, expect, test } from 'bun:test'
import { stripLegacyDeliveryCapabilities } from './encrypted-public'
import type { GalleryImage, VideoItem } from '../../packages/core/imagesource'

const KEY = 'CANARYKEYabcdefghijkl'

const legacyImage = (): GalleryImage => ({
  id: 'mega-abcdefghij012345',
  ref: 'NODEHANDLE01',
  filename: 'photo.jpg',
  src: `/api/mega/file?node=NODEHANDLE01&k=${KEY}`,
  media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'FOLDER', nodeId: 'NODEHANDLE01' },
  contentVersion: 'a'.repeat(64),
  fidelity: 'original',
  width: 1200,
  height: 800,
  alt: 'photo',
  c2pa: true,
  placeholder: 'data:image/svg+xml,svg',
  variants: [{ src: `/api/mega/preview?h=FA&k=${KEY}`, format: 'jpeg', width: 400 }],
})

const legacyVideo = (): VideoItem => ({
  type: 'video', id: 'mega-video000000000', filename: 'clip.mp4',
  src: `/api/mega/file?node=V&k=${KEY}`, mimeType: 'video/mp4',
  width: 1920, height: 1080, alt: 'clip', c2pa: false, placeholder: 'data:image/svg+xml,svg',
  poster: { src: `/api/mega/preview?h=FA2&k=${KEY}`, width: 400, height: 225 },
  variants: [{ src: `/api/mega/preview?h=FA2&k=${KEY}`, format: 'jpeg', width: 400 }],
  sources: [{ src: `/api/mega/file?node=V&k=${KEY}`, mimeType: 'video/mp4' }],
  captions: [{ src: `/api/mega/file?node=CC&k=${KEY}`, srclang: 'en', label: 'English' }],
})

describe('stripLegacyDeliveryCapabilities', () => {
  test('clears the keyed original, preview, and poster while keeping identity and media refs', () => {
    const image = stripLegacyDeliveryCapabilities(legacyImage())
    expect(image.src).toBe('')
    expect(image.variants).toEqual([])
    expect(JSON.stringify(image)).not.toContain(KEY)
    expect(image).toMatchObject({
      id: 'mega-abcdefghij012345', ref: 'NODEHANDLE01', filename: 'photo.jpg',
      media: { kind: 'encrypted', nodeId: 'NODEHANDLE01' },
      contentVersion: 'a'.repeat(64), fidelity: 'original', c2pa: true,
    })

    const video = stripLegacyDeliveryCapabilities(legacyVideo())
    expect(video.src).toBe('')
    expect(video.poster.src).toBe('')
    expect(video.variants).toEqual([])
    expect(video.sources).toEqual([])
    expect(video.captions).toEqual([])
    expect(JSON.stringify(video)).not.toContain(KEY)
    expect(video.type).toBe('video')
  })

  test('keeps media-bearing variants with a blanked src and omits media-less ones', () => {
    const image = stripLegacyDeliveryCapabilities({
      ...legacyImage(),
      variants: [
        // A keyed variant that also carries a media ref loses the URL, not the ref.
        { src: `/api/mega/preview?h=FA&k=${KEY}`, format: 'jpeg', width: 400, media: { kind: 'encrypted' as const, provider: 'mega' as const, sourceKind: 'folder' as const, sourceId: 'FOLDER', nodeId: 'NODEHANDLE01', previewId: 'FA' } },
        { src: `/api/mega/preview?h=FB&k=${KEY}`, format: 'jpeg', width: 800 },
      ],
    })
    expect(image.variants).toHaveLength(1)
    expect(image.variants![0]).toMatchObject({ src: '', media: { kind: 'encrypted', previewId: 'FA' } })
    expect(JSON.stringify(image)).not.toContain(KEY)
  })

  test('round-trips a v2 keyless item — stripping is lossless where no capability exists', () => {
    const image: GalleryImage = {
      id: 'mega-abcdefghij012345', filename: 'x.jpg', src: '',
      media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'FOLDER', nodeId: 'N1' },
      width: 10, height: 10, alt: '', c2pa: false, placeholder: 'p',
      variants: [{ src: '', format: 'jpeg', width: 400, media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'FOLDER', nodeId: 'N1', previewId: 'PREVIEWH1' } }],
    }
    expect(stripLegacyDeliveryCapabilities(image)).toEqual(image)
  })

  test('does not mutate the input item', () => {
    const original = legacyImage()
    stripLegacyDeliveryCapabilities(original)
    expect(original.src).toContain(KEY)
  })
})
