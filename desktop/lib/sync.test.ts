import { describe, expect, test } from 'bun:test'
import { parseDeviceGalleryInput } from '../../packages/core/device-gallery'
import { newCatalogue, type LocalCatalogue, type LocalGalleryRecord } from './catalogue'
import { removeDeviceGallery, syncDeviceGalleries } from './sync'

const record = (id: string, title: string): LocalGalleryRecord => ({
  id,
  title,
  rootPath: `/Volumes/${title}`,
  sourceKind: 'card',
  mountPoint: `/Volumes/${title}`,
  itemCount: 3,
  items: [
    { id: `DCIM/${title}_1.jpg`, name: `${title}_1.jpg`, path: `/Volumes/${title}/DCIM/${title}_1.jpg` },
  ],
  addedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
})

const catalogue = (galleries: LocalGalleryRecord[]): LocalCatalogue => ({
  ...newCatalogue('1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b', 'This Mac'),
  galleries,
})

const captureFetch = (handler: (url: string) => Response) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url)
  }) as typeof fetch
  return { calls, fetcher }
}

describe('syncDeviceGalleries', () => {
  test('PUTs one metadata-only record per gallery with a bearer token', async () => {
    const galleries = [
      record('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'CARD_A'),
      record('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'CARD_B'),
    ]
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 200 }))
    const result = await syncDeviceGalleries('https://manorama.xyz', 'token-value', catalogue(galleries), fetcher)
    expect(result).toEqual({ synced: 2, failed: 0 })
    expect(calls.map((call) => call.url)).toEqual([
      'https://manorama.xyz/api/device-galleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'https://manorama.xyz/api/device-galleries/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    ])
    for (const call of calls) {
      expect(call.init?.method).toBe('PUT')
      const headers = call.init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer token-value')
      expect(headers['Content-Type']).toBe('application/json')
      const body = JSON.parse(call.init?.body as string)
      // The server parser is the contract — and the serialized body can
      // carry no path material by construction.
      expect(parseDeviceGalleryInput(body)).not.toBeNull()
      expect(call.init?.body as string).not.toContain('/Volumes')
      expect(call.init?.body as string).not.toContain('.jpg')
    }
  })

  test('counts failures quietly — sync never throws at the caller', async () => {
    const galleries = [
      record('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'CARD_A'),
      record('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'CARD_B'),
      record('cccccccc-dddd-4eee-8fff-000000000000', 'CARD_C'),
    ]
    let n = 0
    const { fetcher } = captureFetch(() => {
      n += 1
      if (n === 2) return new Response('{}', { status: 401 })
      if (n === 3) throw new Error('network down')
      return new Response('{}', { status: 200 })
    })
    const result = await syncDeviceGalleries('https://manorama.xyz', 'token', catalogue(galleries), fetcher)
    expect(result).toEqual({ synced: 1, failed: 2 })
  })
})

describe('removeDeviceGallery', () => {
  test('DELETEs the remote row and swallows failures', async () => {
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 404 }))
    await expect(
      removeDeviceGallery('https://manorama.xyz', 'token-value', record('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'CARD_A'), fetcher),
    ).resolves.toBeUndefined()
    expect(calls[0]!.init?.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/device-galleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const throwing = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    await expect(
      removeDeviceGallery('https://manorama.xyz', 'token', record('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'CARD_A'), throwing),
    ).resolves.toBeUndefined()
  })
})
