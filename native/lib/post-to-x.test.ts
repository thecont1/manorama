import { describe, expect, test } from 'bun:test'
import type { GalleryMediaItem } from '../../app/lib/imagesource'
import {
  exportFileName,
  orderedSelection,
  photoMimeType,
  postToXPhotos,
  postToXText,
  togglePostSelection,
  POST_TO_X_MAX_MEDIA,
} from './post-to-x'

/**
 * The policy the picker and the share both obey: X's ceiling of twenty, the
 * gallery's own order, and the original bytes rather than a provider's
 * boxed rendition.
 */

const photo = (id: string, overrides: Partial<GalleryMediaItem> = {}): GalleryMediaItem => ({
  id,
  filename: `${id}.jpg`,
  src: `https://manorama.test/api/dropbox/file?filename=${id}.jpg`,
  width: 3000,
  height: 2000,
  alt: `Photograph ${id}`,
  c2pa: false,
  placeholder: 'data:image/svg+xml,svg',
  ...overrides,
} as GalleryMediaItem)

const video = (id: string): GalleryMediaItem => ({
  type: 'video',
  id,
  filename: `${id}.mp4`,
  src: `https://manorama.test/api/dropbox/file?filename=${id}.mp4`,
  mimeType: 'video/mp4',
  width: 1920,
  height: 1080,
  alt: 'Clip',
  c2pa: false,
  placeholder: 'data:image/svg+xml,svg',
  poster: { src: 'https://manorama.test/poster.jpg', width: 400, height: 225 },
} as GalleryMediaItem)

describe('postToXPhotos', () => {
  test('keeps the gallery order and drops video', () => {
    const photos = postToXPhotos([photo('a'), video('clip'), photo('b')])
    expect(photos.map((each) => each.id)).toEqual(['a', 'b'])
  })

  test('takes the original as the export source, not a rendition', () => {
    const [only] = postToXPhotos([
      photo('a', {
        src: 'https://manorama.test/api/dropbox/file?filename=a.jpg',
        variants: [{ width: 2048, src: 'https://manorama.test/api/dropbox/thumbnail?size=w2048h1536', format: 'jpeg' }],
      }),
    ])
    expect(only.src).toBe('https://manorama.test/api/dropbox/file?filename=a.jpg')
    // The rendition is still what the picker shows.
    expect(only.preview).toBe('https://manorama.test/api/dropbox/thumbnail?size=w2048h1536')
  })

  test('marks an encrypted source, which has no address', () => {
    const [only] = postToXPhotos([
      photo('a', {
        src: '',
        media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'F', nodeId: 'N' },
      } as Partial<GalleryMediaItem>),
    ])
    expect(only.src).toBe('')
    expect(only.encrypted).toBe(true)
  })

  test('carries the encrypted reference, so the device can decrypt it', () => {
    const media = { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'F', nodeId: 'N' } as const
    const [only] = postToXPhotos([photo('a', { src: '', media })])
    expect(only.media).toEqual(media)
  })
})

describe('photoMimeType', () => {
  test('reads the format from the file’s own name', () => {
    expect(photoMimeType({ filename: 'shot.jpg' })).toBe('image/jpeg')
    expect(photoMimeType({ filename: 'shot.JPEG' })).toBe('image/jpeg')
    expect(photoMimeType({ filename: 'shot.png' })).toBe('image/png')
    expect(photoMimeType({ filename: 'shot.heic' })).toBe('image/heic')
  })

  test('claims nothing it cannot know', () => {
    expect(photoMimeType({ filename: 'shot' })).toBe('application/octet-stream')
    expect(photoMimeType({ filename: 'shot.bin' })).toBe('application/octet-stream')
  })
})

describe('togglePostSelection', () => {
  test('adds and removes a photograph', () => {
    const added = togglePostSelection([], 'a')
    expect(added).toEqual(['a'])
    expect(togglePostSelection(added, 'a')).toEqual([])
  })

  test('stops at the ceiling', () => {
    const full = Array.from({ length: POST_TO_X_MAX_MEDIA }, (_, index) => `p${index}`)
    expect(togglePostSelection(full, 'one-too-many')).toEqual(full)
  })

  test('frees a slot when a photograph is taken back', () => {
    const full = Array.from({ length: POST_TO_X_MAX_MEDIA }, (_, index) => `p${index}`)
    const minus = togglePostSelection(full, 'p3')
    expect(minus).toHaveLength(POST_TO_X_MAX_MEDIA - 1)
    expect(togglePostSelection(minus, 'new')).toHaveLength(POST_TO_X_MAX_MEDIA)
  })
})

describe('orderedSelection', () => {
  test('posts in the gallery order, whatever order they were tapped', () => {
    const photos = postToXPhotos([photo('a'), photo('b'), photo('c')])
    expect(orderedSelection(photos, ['c', 'a']).map((each) => each.id)).toEqual(['a', 'c'])
  })
})

describe('exportFileName', () => {
  test('numbers the files so the order is visible', () => {
    expect(exportFileName(0, 'MS201907-Kashmir0692.jpg')).toBe('01-MS201907-Kashmir0692.jpg')
    expect(exportFileName(11, 'shot.jpg')).toBe('12-shot.jpg')
  })

  test('keeps the name safe for a file system', () => {
    expect(exportFileName(0, 'a b/c:d?.jpg')).toBe('01-a-b-c-d-.jpg')
    expect(exportFileName(0, '..weird.jpg')).toBe('01-weird.jpg')
    // A name that is only an extension has no stem to keep.
    expect(exportFileName(0, '.hidden')).toBe('01-photograph.jpg')
    expect(exportFileName(0, '')).toBe('01-photograph.jpg')
  })

  test('always ends in the format the export emits', () => {
    expect(exportFileName(0, 'frame.heic')).toBe('01-frame.jpg')
  })
})

describe('postToXText', () => {
  test('carries what the photographer typed and the gallery address', () => {
    expect(postToXText('Fog over the harbour', 'https://manorama.xyz/thecontrarian/italy'))
      .toBe('Fog over the harbour\nhttps://manorama.xyz/thecontrarian/italy')
  })

  test('carries the gallery address alone when nothing was typed', () => {
    expect(postToXText('   ', 'https://manorama.xyz/thecontrarian/italy'))
      .toBe('https://manorama.xyz/thecontrarian/italy')
  })
})
