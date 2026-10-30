import { describe, expect, test } from 'bun:test'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import { fetchAccountGalleries, fetchAccountOwnerSlug, fetchDeviceGalleries, standaloneDeviceGalleries } from './account'

const captureFetch = (handler: (url: string) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url)
  }) as typeof fetch
  return { calls, fetcher }
}

const summary = (slug: string, images: GallerySummary['images'] = []): GallerySummary =>
  ({ slug, title: slug, caption: '', date: '', imageCount: images.length, sourceUrl: 'https://www.dropbox.com/scl/fo/x', createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, images })

const device = (id: string, deviceId: string, extras: Partial<DeviceGallery> = {}): DeviceGallery => ({
  id,
  title: id,
  sourceKind: 'folder',
  itemCount: 3,
  deviceId,
  deviceLabel: 'Other Mac',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extras,
})

describe('fetchAccountGalleries', () => {
  test('GETs /api/galleries with the bearer token and rewrites preview URLs absolute', async () => {
    const body = JSON.stringify({
      galleries: [
        summary('kashmir', [
          { id: 'a', ref: undefined, filename: 'a.jpg', src: '/img/a.jpg', width: 4000, height: 3000, alt: '', placeholder: '', variants: [{ src: '/img/a-sm.jpg', width: 400, format: 'image/jpeg' }] },
        ]),
      ],
    })
    const { calls, fetcher } = captureFetch(() => new Response(body, { status: 200 }))
    const galleries = await fetchAccountGalleries('https://manorama.xyz/', 'token-value', fetcher)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/galleries')
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-value')
    expect(galleries).toHaveLength(1)
    expect(galleries[0]!.images[0]!.src).toBe('https://manorama.xyz/img/a.jpg')
    expect(galleries[0]!.images[0]!.variants![0]!.src).toBe('https://manorama.xyz/img/a-sm.jpg')
  })

  test('surfaces HTTP errors with their status', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({ error: 'expired' }), { status: 401 }))
    await expect(fetchAccountGalleries('https://manorama.xyz', 'token', fetcher)).rejects.toThrow('expired')
  })
})

describe('fetchDeviceGalleries', () => {
  test('GETs /api/device-galleries with the bearer token', async () => {
    const body = JSON.stringify({ galleries: [device('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'device-uuid')] })
    const { calls, fetcher } = captureFetch(() => new Response(body, { status: 200 }))
    const galleries = await fetchDeviceGalleries('https://manorama.xyz', 'token-value', fetcher)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/device-galleries')
    expect(galleries).toHaveLength(1)
  })
})

describe('fetchAccountOwnerSlug', () => {
  test('GETs /api/account with the bearer token and returns the fresh slug', async () => {
    const { calls, fetcher } = captureFetch(() => new Response(JSON.stringify({ ownerSlug: 'fresh-name' }), { status: 200 }))
    await expect(fetchAccountOwnerSlug('https://manorama.xyz', 'token-value', fetcher)).resolves.toBe('fresh-name')
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/account')
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-value')
  })

  test('rejects an incomplete account response', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    await expect(fetchAccountOwnerSlug('https://manorama.xyz', 'token', fetcher)).rejects.toThrow('incomplete')
  })
})

describe('standaloneDeviceGalleries', () => {
  const OWN = '11111111-2222-4333-8444-555555555555'
  const OTHER = '66666666-7777-4888-8999-000000000000'
  test('drops this Mac’s own records and ones already published as cloud galleries', () => {
    const devices = [
      device('aaaaaaaa-0000-4000-8000-000000000001', OWN),
      device('bbbbbbbb-0000-4000-8000-000000000002', OTHER, { publicGallerySlug: 'kashmir' }),
      device('cccccccc-0000-4000-8000-000000000003', OTHER),
    ]
    const account = [summary('kashmir')]
    expect(standaloneDeviceGalleries(devices, account, OWN).map((g) => g.id)).toEqual([
      'cccccccc-0000-4000-8000-000000000003',
    ])
  })
})
