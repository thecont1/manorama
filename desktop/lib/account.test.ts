import { describe, expect, test } from 'bun:test'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import { fetchAccountGalleries, fetchAccountProfile, fetchDeviceGalleries, fetchDevices, forgetDevice, registerDevice, standaloneDeviceGalleries } from './account'

const captureFetch = (handler: (url: string) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url)
  }) as typeof fetch
  return { calls, fetcher }
}

const summary = (slug: string, images: GallerySummary['images'] = []): GallerySummary =>
  ({ id: `id-${slug}`, manifestVersion: 1, keyRetiredAt: null, lastSourceCheckAt: null, slug, title: slug, caption: '', date: '', imageCount: images.length, mediaCount: { stills: images.length, videos: 0, hidden: 0 }, sourceUrl: 'https://www.dropbox.com/scl/fo/x', createdAt: '2026-10-01T00:00:00.000Z', retention: 'retained', expiresAt: null, pinnedAt: null, hiddenAt: null, images })

const device = (id: string, deviceId: string, extras: Partial<DeviceGallery> = {}): DeviceGallery => ({
  id,
  title: id,
  sourceKind: 'folder',
  itemCount: 3,
  deviceId,
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

describe('fetchAccountProfile', () => {
  test('GETs /api/account with the bearer token and returns the fresh slug and tier', async () => {
    const { calls, fetcher } = captureFetch(() => new Response(JSON.stringify({ ownerSlug: 'fresh-name', tier: 'pro' }), { status: 200 }))
    await expect(fetchAccountProfile('https://manorama.xyz', 'token-value', fetcher)).resolves.toEqual({ ownerSlug: 'fresh-name', tier: 'pro' })
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/account')
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer token-value')
  })

  test('a legacy payload with no tier leaves it unset rather than guessing', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({ ownerSlug: 'fresh-name' }), { status: 200 }))
    await expect(fetchAccountProfile('https://manorama.xyz', 'token', fetcher)).resolves.toEqual({ ownerSlug: 'fresh-name' })
  })

  test('rejects an incomplete account response', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    await expect(fetchAccountProfile('https://manorama.xyz', 'token', fetcher)).rejects.toThrow('incomplete')
  })
})

describe('standaloneDeviceGalleries', () => {
  const OWN = '11111111-2222-4333-8444-555555555555'
  const OTHER = '66666666-7777-4888-8999-000000000000'
  const entries = (devices: DeviceGallery[], localIds: ReadonlySet<string> = new Set()) =>
    standaloneDeviceGalleries(devices, [summary('kashmir')], OWN, localIds)

  test('drops rows a local record already stands for and ones published as cloud galleries', () => {
    const devices = [
      device('aaaaaaaa-0000-4000-8000-000000000001', OWN),
      device('bbbbbbbb-0000-4000-8000-000000000002', OTHER, { publicGallerySlug: 'kashmir' }),
      device('cccccccc-0000-4000-8000-000000000003', OTHER),
    ]
    // The first row is the synced copy of a live record — the local card
    // represents it, so no standalone card at all.
    const localIds = new Set(['aaaaaaaa-0000-4000-8000-000000000001'])
    expect(entries(devices, localIds).map((entry) => entry.gallery.id)).toEqual([
      'cccccccc-0000-4000-8000-000000000003',
    ])
  })

  test('an own-device row with no record left is a ghost, not a foreign mirror', () => {
    // The catalogue that synced this row was rebuilt — the record is gone
    // but the row still names this device.
    const devices = [device('aaaaaaaa-0000-4000-8000-000000000001', OWN)]
    expect(entries(devices)).toEqual([
      { gallery: devices[0], ghost: true },
    ])
  })

  test('a row under a different deviceId stays an honest mirror', () => {
    // The deviceId is the identity. Two of the owner's Macs could share a
    // machine name, and the server no longer stores names at all — a
    // display match would never be proof of ownership.
    const devices = [device('bbbbbbbb-0000-4000-8000-000000000002', OTHER)]
    expect(entries(devices)).toEqual([
      { gallery: devices[0], ghost: false },
    ])
  })

  test('a genuinely different device is an honest mirror', () => {
    const devices = [device('cccccccc-0000-4000-8000-000000000003', OTHER)]
    expect(entries(devices)).toEqual([
      { gallery: devices[0], ghost: false },
    ])
  })
})

const DEVICE_ID = 'aaaaaaaa-0000-4000-8000-0000000000aa'

const listedDevice = () => ({
  id: DEVICE_ID,
  kind: 'mac',
  ordinal: 1,
  colour: 0,
  firstSeenAt: '2026-11-01T09:00:00.000Z',
  lastSeenAt: '2026-11-14T09:00:00.000Z',
})

describe('fetchDevices', () => {
  test('GETs /api/devices with the bearer token', async () => {
    const { calls, fetcher } = captureFetch(() => new Response(JSON.stringify({ devices: [listedDevice()] }), { status: 200 }))
    const devices = await fetchDevices('https://manorama.xyz/', 'token-value', fetcher)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/devices')
    expect(devices).toEqual([listedDevice()])
  })

  test('an incomplete payload is an error, not an empty list', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({}), { status: 200 }))
    await expect(fetchDevices('https://manorama.xyz', 'token-value', fetcher)).rejects.toThrow('incomplete')
  })
})

describe('registerDevice', () => {
  test('PUTs the kind and nothing else — never a machine name', async () => {
    const { calls, fetcher } = captureFetch(() => new Response(JSON.stringify({ device: listedDevice() }), { status: 200 }))
    const device = await registerDevice('https://manorama.xyz', 'token-value', DEVICE_ID, 'mac', fetcher)
    expect(calls[0]!.url).toBe(`https://manorama.xyz/api/devices/${DEVICE_ID}`)
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ kind: 'mac' })
    expect(device.ordinal).toBe(1)
  })

  test('a full palette surfaces the server message', async () => {
    const { fetcher } = captureFetch(() => new Response(JSON.stringify({ error: 'Forget a device to add another' }), { status: 409 }))
    await expect(registerDevice('https://manorama.xyz', 'token-value', DEVICE_ID, 'mac', fetcher))
      .rejects.toThrow('Forget a device to add another')
  })
})

describe('forgetDevice', () => {
  test('DELETEs the device, treating 404 as already gone', async () => {
    const { calls, fetcher } = captureFetch(() => new Response(JSON.stringify({ error: 'That device was not found' }), { status: 404 }))
    await forgetDevice('https://manorama.xyz', 'token-value', DEVICE_ID, fetcher)
    expect(calls[0]!.url).toBe(`https://manorama.xyz/api/devices/${DEVICE_ID}`)
    expect(calls[0]!.init?.method).toBe('DELETE')
  })
})
