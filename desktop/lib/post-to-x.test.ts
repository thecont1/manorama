import { describe, expect, test } from 'bun:test'
import type { LocalGalleryRecord } from './catalogue'
import {
  exportPostToX,
  localPhotoReader,
  localPostPhotos,
  toBase64,
  type PostShareFile,
} from './post-to-x'
import type { PostToXPhoto } from '../../native/lib/post-to-x'
import type { ImageProgramRuntime } from '../../native/lib/image-program'

const record = (overrides: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: 'italy, amore mio',
  rootPath: '/Users/home/Pictures/italy',
  sourceKind: 'folder',
  itemCount: 3,
  items: [
    { id: 'a.jpg', name: 'a.jpg', path: '/Users/home/Pictures/italy/a.jpg', width: 4000, height: 3000 },
    { id: 'b.jpg', name: 'b.jpg', path: '/Users/home/Pictures/italy/b.jpg', width: 3000, height: 4000 },
    { id: 'c.png', name: 'c.png', path: '/Users/home/Pictures/italy/c.png', width: 800, height: 600 },
  ],
  addedAt: '2026-10-11T00:00:00.000Z',
  lastSeenAt: '2026-10-11T00:00:00.000Z',
  ...overrides,
})

const photo = (overrides: Partial<PostToXPhoto> = {}): PostToXPhoto => ({
  id: 'a.jpg',
  filename: 'a.jpg',
  width: 4000,
  height: 3000,
  alt: 'a photograph',
  src: '/Users/home/Pictures/italy/a.jpg',
  preview: 'asset://localhost/a.jpg',
  encrypted: false,
  ...overrides,
})

const fakeRuntime = (encode: (target: { width: number; height: number }) => Uint8Array): ImageProgramRuntime => ({
  decode: async () => ({
    width: 4000,
    height: 3000,
    encode: async (target) => encode(target),
  }),
})

describe('localPostPhotos', () => {
  test('maps the visible items to postable photographs', () => {
    const photos = localPostPhotos(record(), (path) => `asset://localhost${path}`)
    expect(photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg', 'c.png'])
    expect(photos[0]!.src).toBe('/Users/home/Pictures/italy/a.jpg')
    expect(photos[0]!.preview).toBe('asset://localhost/Users/home/Pictures/italy/a.jpg')
    expect(photos[0]!.encrypted).toBe(false)
  })

  test('concealed items stay concealed', () => {
    const photos = localPostPhotos(record({ hidden: ['b.jpg'] }), (path) => path)
    expect(photos.map((p) => p.id)).toEqual(['a.jpg', 'c.png'])
  })
})

describe('localPhotoReader', () => {
  test('reads the file bytes and names the type from the filename', async () => {
    const read = localPhotoReader(async () => new Uint8Array([1, 2, 3]))
    const result = await read(photo({ filename: 'a.jpg' }))
    expect(result?.mimeType).toBe('image/jpeg')
    expect([...(result?.bytes ?? [])]).toEqual([1, 2, 3])
  })

  test('a failed read answers undefined rather than throwing', async () => {
    const read = localPhotoReader(async () => { throw new Error('outside the grant') })
    expect(await read(photo())).toBeUndefined()
    expect(await read(photo({ src: '' }))).toBeUndefined()
  })
})

describe('exportPostToX', () => {
  test('prepares every photograph and hands the set to the shell once', async () => {
    const shared: { files: PostShareFile[]; text: string; url: string; title: string }[] = []
    const report = await exportPostToX({
      photos: [photo({ id: 'a', filename: 'a.jpg' }), photo({ id: 'b', filename: 'b.jpg' })],
      caption: 'winter light',
      title: 'italy, amore mio',
      url: 'https://manorama.xyz/thecontrarian/italy',
      read: async () => ({ bytes: new Uint8Array([9, 9]), mimeType: 'image/jpeg' }),
      share: async (files, text, url, title) => {
        shared.push({ files: [...files], text, url, title })
        return 'The photographs are on your clipboard.'
      },
      runtime: fakeRuntime(() => new Uint8Array([7, 7, 7])),
    })
    expect(report.outcome).toBe('shared')
    expect(report.posted).toBe(2)
    expect(report.note).toBe('The photographs are on your clipboard.')
    expect(shared).toHaveLength(1)
    expect(shared[0]!.files.map((f) => f.name)).toEqual(['01-a.jpg', '02-b.jpg'])
    expect(shared[0]!.text).toBe('winter light\nhttps://manorama.xyz/thecontrarian/italy')
    expect(shared[0]!.files[0]!.data).toBe(toBase64(new Uint8Array([7, 7, 7])))
  })

  test('a local gallery without a published address posts the caption alone', async () => {
    const texts: string[] = []
    await exportPostToX({
      photos: [photo()],
      caption: '',
      title: 'italy',
      url: '',
      read: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }),
      share: async (_files, text) => { texts.push(text) },
      runtime: fakeRuntime(() => new Uint8Array([1])),
    })
    expect(texts[0]).toBe('')
  })

  test('a photograph that cannot be prepared is left out and counted', async () => {
    const shared: PostShareFile[][] = []
    const report = await exportPostToX({
      photos: [photo({ id: 'a' }), photo({ id: 'b' })],
      caption: '',
      title: 'italy',
      url: 'https://manorama.xyz/italy',
      read: async (p) => p.id === 'a' ? undefined : { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' },
      share: async (files) => { shared.push([...files]) },
      runtime: fakeRuntime(() => new Uint8Array([1])),
    })
    expect(report.outcome).toBe('shared')
    expect(report.skipped).toBe(1)
    expect(shared[0]!.map((f) => f.name)).toEqual(['02-a.jpg'])
  })

  test('fails honestly when nothing could be prepared, and again when the shell rejects', async () => {
    const empty = await exportPostToX({
      photos: [photo()],
      caption: '',
      title: 'italy',
      url: '',
      read: async () => undefined,
      share: async () => { throw new Error('unreachable') },
      runtime: fakeRuntime(() => new Uint8Array([1])),
    })
    expect(empty.outcome).toBe('failed')
    expect(empty.posted).toBe(0)

    const rejected = await exportPostToX({
      photos: [photo()],
      caption: '',
      title: 'italy',
      url: '',
      read: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }),
      share: async () => { throw new Error('the shell refused the command') },
      runtime: fakeRuntime(() => new Uint8Array([1])),
    })
    expect(rejected.outcome).toBe('failed')
    expect(rejected.note).toBe('The photographs could not be handed to the system.')
  })
})
