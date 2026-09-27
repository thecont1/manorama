import { describe, expect, test } from 'bun:test'
import { parseDeviceGalleryInput } from '../../packages/core/device-gallery'
import { newCatalogue, type LocalCatalogue, type LocalGalleryRecord } from './catalogue'
import type { UploadProvider } from './providers/types'
import {
  createGalleryFromShareLink,
  dedupeUploadNames,
  linkDeviceGallery,
  sanitizeUploadName,
  shareLocalGallery,
  uploadFilesFor,
} from './share'

const DEVICE_ID = '1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b'

const record = (overrides?: Partial<LocalGalleryRecord>): LocalGalleryRecord => ({
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  title: 'Trip',
  rootPath: '/Volumes/CARD/DCIM',
  sourceKind: 'card',
  mountPoint: '/Volumes/CARD',
  itemCount: 2,
  items: [
    { id: 'one.jpg', name: 'one.jpg', path: '/Volumes/CARD/DCIM/one.jpg' },
    { id: 'sub/one.jpg', name: 'one.jpg', path: '/Volumes/CARD/DCIM/sub/one.jpg' },
  ],
  addedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

const catalogue = (galleries: LocalGalleryRecord[]): LocalCatalogue => ({
  ...newCatalogue(DEVICE_ID, 'This Mac'),
  galleries,
})

const captureFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { calls, fetcher }
}

describe('sanitizeUploadName', () => {
  test('strips path components and provider-unsafe characters', () => {
    expect(sanitizeUploadName('/abs/path/photo.jpg')).toBe('photo.jpg')
    // Anything before a slash is a path component and drops entirely.
    expect(sanitizeUploadName('a/b:c*d?"e<>|f.jpg')).toBe('b c d e f.jpg')
    expect(sanitizeUploadName('a:b*c?d"e<>|f.jpg')).toBe('a b c d e f.jpg')
    expect(sanitizeUploadName('..hidden')).toBe('hidden')
    expect(sanitizeUploadName('   ')).toBe('file')
    expect(sanitizeUploadName('')).toBe('file')
    expect(sanitizeUploadName('n\u0001ame.jpg')).toBe('n ame.jpg')
  })

  test('caps long names', () => {
    expect(sanitizeUploadName(`${'x'.repeat(300)}.jpg`).length).toBeLessThanOrEqual(200)
  })
})

describe('dedupeUploadNames', () => {
  test('first keeps its name; collisions suffix before the extension', () => {
    expect(dedupeUploadNames(['a.jpg', 'a.jpg', 'a.jpg', 'b.png', 'a.png'])).toEqual([
      'a.jpg', 'a (2).jpg', 'a (3).jpg', 'b.png', 'a.png',
    ])
    expect(dedupeUploadNames(['noext', 'noext'])).toEqual(['noext', 'noext (2)'])
  })
})

describe('uploadFilesFor', () => {
  test('projects items to sanitized basenames with local paths kept separate', () => {
    const files = uploadFilesFor(record())
    expect(files.map((f) => f.name)).toEqual(['one.jpg', 'one (2).jpg'])
    expect(files[0]!.path).toBe('/Volumes/CARD/DCIM/one.jpg')
  })
})

describe('createGalleryFromShareLink', () => {
  test('POSTs exactly the share link with the bearer token — nothing else', async () => {
    const { calls, fetcher } = captureFetch(() =>
      new Response(JSON.stringify({ gallery: { slug: 'trip-photos' }, galleryUrl: '/owner/trip-photos' }), { status: 201 }),
    )
    const result = await createGalleryFromShareLink('https://manorama.xyz/', 'token-value', 'https://www.dropbox.com/sh/abc/Trip', fetcher)
    expect(result).toEqual({ slug: 'trip-photos', galleryUrl: '/owner/trip-photos' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/galleries')
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-value')
    const body = JSON.parse(calls[0]!.init?.body as string)
    // The leak guard the plan contract requires: the body is ONLY the
    // public link — no path, filename, byte, or device identifier.
    expect(Object.keys(body)).toEqual(['url'])
    expect(body.url).toBe('https://www.dropbox.com/sh/abc/Trip')
    expect(calls[0]!.init?.body as string).not.toContain('/Volumes')
    expect(calls[0]!.init?.body as string).not.toContain('.jpg')
    expect(calls[0]!.init?.body as string).not.toContain(DEVICE_ID)
  })

  test('a 409 reuses the existing gallery slug', async () => {
    const { fetcher } = captureFetch(() =>
      new Response(JSON.stringify({ error: 'A gallery from that link already exists', gallery: { slug: 'trip' }, galleryUrl: '/owner/trip' }), { status: 409 }),
    )
    const result = await createGalleryFromShareLink('https://manorama.xyz', 't', 'https://drive.google.com/drive/folders/x', fetcher)
    expect(result.slug).toBe('trip')
    expect(result.galleryUrl).toBe('/owner/trip')
  })

  test('other failures throw the server message or a generic one', async () => {
    const { fetcher: bad } = captureFetch(() =>
      new Response(JSON.stringify({ error: 'That link could not be scanned' }), { status: 422 }),
    )
    await expect(createGalleryFromShareLink('https://manorama.xyz', 't', 'u', bad)).rejects.toThrow(
      'That link could not be scanned',
    )
    const { fetcher: silent } = captureFetch(() => new Response('{}', { status: 503 }))
    await expect(createGalleryFromShareLink('https://manorama.xyz', 't', 'u', silent)).rejects.toThrow(
      'The share link could not be published.',
    )
  })
})

describe('linkDeviceGallery', () => {
  test('PUTs the sync projection plus publicGallerySlug — still metadata-only', async () => {
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 200 }))
    await linkDeviceGallery('https://manorama.xyz', 'token-value', record(), catalogue([record()]), 'trip-photos', fetcher)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/device-galleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(calls[0]!.init?.method).toBe('PUT')
    const body = JSON.parse(calls[0]!.init?.body as string)
    expect(parseDeviceGalleryInput(body)).not.toBeNull()
    expect(body.publicGallerySlug).toBe('trip-photos')
    expect(calls[0]!.init?.body as string).not.toContain('/Volumes')
    expect(calls[0]!.init?.body as string).not.toContain('.jpg')
  })

  test('a rejected PUT throws', async () => {
    const { fetcher } = captureFetch(() => new Response('{}', { status: 400 }))
    await expect(
      linkDeviceGallery('https://manorama.xyz', 't', record(), catalogue([record()]), 'slug', fetcher),
    ).rejects.toThrow('could not be linked')
  })
})

describe('shareLocalGallery', () => {
  const providerWith = (onAlbum: (album: { name: string; files: { name: string; path: string }[] }) => Promise<{ shareUrl: string }>) => {
    const calls: { name: string; files: { name: string; path: string }[] }[] = []
    const provider: UploadProvider = {
      id: 'dropbox',
      label: 'Dropbox',
      configured: () => true,
      isConnected: async () => true,
      connect: async () => {},
      completeConnect: async () => {},
      disconnect: async () => {},
      uploadAlbum: async (album) => {
        calls.push(album)
        return onAlbum(album)
      },
    }
    return { provider, calls }
  }

  test('the confirm gate: a cancelled confirmation means ZERO network calls', async () => {
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 200 }))
    const { provider, calls: uploads } = providerWith(async () => ({ shareUrl: 'https://x' }))
    const outcome = await shareLocalGallery({
      provider,
      apiBase: 'https://manorama.xyz',
      token: 't',
      record: record(),
      catalogue: catalogue([record()]),
      readFile: async () => new Uint8Array([1]),
      confirm: async () => false,
      fetcher,
    })
    expect(outcome.status).toBe('cancelled')
    expect(calls).toHaveLength(0)
    expect(uploads).toHaveLength(0)
  })

  test('confirmed: uploads under the sanitized title, publishes the link, links the device record', async () => {
    const order: string[] = []
    const { calls, fetcher } = captureFetch((url) => {
      order.push(url)
      if (url.includes('/api/galleries')) {
        return new Response(JSON.stringify({ gallery: { slug: 'trip' }, galleryUrl: '/owner/trip' }), { status: 201 })
      }
      return new Response('{}', { status: 200 })
    })
    const { provider, calls: uploads } = providerWith(async (album) => {
      order.push('upload')
      expect(album.name).toBe('Trip')
      expect(album.files.map((f) => f.name)).toEqual(['one.jpg', 'one (2).jpg'])
      return { shareUrl: 'https://www.dropbox.com/sh/abc/Trip' }
    })
    const progress: number[] = []
    const outcome = await shareLocalGallery({
      provider,
      apiBase: 'https://manorama.xyz',
      token: 'token-value',
      record: record(),
      catalogue: catalogue([record()]),
      readFile: async () => new Uint8Array([1]),
      confirm: async () => true,
      onProgress: (p) => progress.push(p.index),
      fetcher,
    })
    expect(outcome).toEqual({
      status: 'published',
      shareUrl: 'https://www.dropbox.com/sh/abc/Trip',
      slug: 'trip',
      galleryUrl: '/owner/trip',
    })
    // Upload first, then POST /api/galleries, then the device-gallery PUT.
    expect(order).toEqual([
      'upload',
      'https://manorama.xyz/api/galleries',
      'https://manorama.xyz/api/device-galleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ])
    const galleriesBody = JSON.parse(calls[0]!.init?.body as string)
    expect(Object.keys(galleriesBody)).toEqual(['url'])
    const putBody = JSON.parse(calls[1]!.init?.body as string)
    expect(putBody.publicGallerySlug).toBe('trip')
    expect(uploads).toHaveLength(1)
  })

  test('a provider failure surfaces as failed outcome — no Worker calls follow', async () => {
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 200 }))
    const { provider } = providerWith(async () => {
      throw new Error('provider offline')
    })
    const outcome = await shareLocalGallery({
      provider,
      apiBase: 'https://manorama.xyz',
      token: 't',
      record: record(),
      catalogue: catalogue([record()]),
      readFile: async () => new Uint8Array([1]),
      confirm: async () => true,
      fetcher,
    })
    expect(outcome.status).toBe('failed')
    expect((outcome as { message: string }).message).toBe('provider offline')
    expect(calls).toHaveLength(0)
  })
})
