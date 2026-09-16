import { describe, expect, test } from 'bun:test'
import { extractAlbumToken, fetchICloudImage, scanICloudAlbum } from './icloud-shared'

const TOKEN = 'B0z5qAGN1JIFd3y'

const jsonResponse = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers })

const stream = (photos: unknown[]) => ({
  streamName: 'Kerala Backwaters',
  streamCtag: 'ctag-1',
  photos,
})

const photo = (overrides: Record<string, unknown> = {}) => ({
  photoGuid: 'guid-001',
  caption: '',
  derivatives: {
    '1': { checksum: 'small-cs', width: 340, height: 255, fileSize: 40000 },
    '2': { checksum: 'large-cs', width: 2048, height: 1536, fileSize: 900000 },
  },
  ...overrides,
})

describe('extractAlbumToken', () => {
  test('pulls the token from both public link spellings', () => {
    expect(extractAlbumToken(`https://www.icloud.com/sharedalbum/#${TOKEN}`)).toBe(TOKEN)
    expect(extractAlbumToken(`https://share.icloud.com/photos/${TOKEN}`)).toBe(TOKEN)
  })

  test('returns null for other iCloud URLs', () => {
    expect(extractAlbumToken('https://www.icloud.com/photos')).toBeNull()
    expect(extractAlbumToken('https://www.icloud.com/sharedalbum/')).toBeNull()
  })
})

describe('scanICloudAlbum', () => {
  test('maps photos to gallery images keyed by photo GUID', async () => {
    const fetchImpl = async () => jsonResponse(stream([
      photo(),
      photo({ photoGuid: 'guid-002', caption: 'Canoe at dawn' }),
      photo({ photoGuid: 'guid-003', mediaAssetType: 'video' }),
    ]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.sourceUrl).toBe(`https://www.icloud.com/sharedalbum/#${TOKEN}`)
    expect(scan.title).toBe('Kerala Backwaters')
    expect(scan.images).toHaveLength(2)
    const [first, second] = scan.images
    expect(first.ref).toBe('guid-001')
    expect(first.src).toBe('/api/icloud/image?album=B0z5qAGN1JIFd3y&photo=guid-001&c=large-cs')
    expect(first.variants?.[0]?.src).toContain('c=small-cs')
    expect(first.width).toBe(2048)
    expect(first.c2pa).toBe(false)
    expect(second.caption).toBe('Canoe at dawn')
    expect(second.filename).toBe('Canoe at dawn')
  })

  test('follows the 330 partition redirect', async () => {
    const calls: string[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      calls.push(url)
      if (calls.length === 1) {
        return jsonResponse({ 'X-Apple-MMe-Host': 'p42-sharedstreams.icloud.com' }, 330, { 'x-apple-user-partition': '42' })
      }
      return jsonResponse(stream([photo()]))
    }
    const scan = await scanICloudAlbum(`https://share.icloud.com/photos/${TOKEN}`, fetchImpl as typeof fetch)
    expect(calls[1]).toContain('p42-sharedstreams.icloud.com')
    expect(scan.images).toHaveLength(1)
  })

  test('fails friendly when the album is not public', async () => {
    const fetchImpl = async () => jsonResponse({}, 404)
    await expect(scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch))
      .rejects.toThrow('public Shared Album')
  })

  test('fails friendly when the album has no photos', async () => {
    const fetchImpl = async () => jsonResponse(stream([photo({ mediaAssetType: 'video' })]))
    await expect(scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch))
      .rejects.toThrow('No photos')
  })
})

describe('fetchICloudImage', () => {
  test('resolves the derivative checksum to a fresh CDN URL and streams it', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('webasseturls')) {
        return jsonResponse({
          items: { 'large-cs': { url_location: 'cvws.icloud-content.com', url_path: '/p/abc123' } },
          locations: { 'cvws.icloud-content.com': { scheme: 'https', hosts: ['cvws.icloud-content.com'] } },
        })
      }
      if (url === 'https://cvws.icloud-content.com/p/abc123') {
        return new Response('image-bytes', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      }
      return jsonResponse({}, 404)
    }
    const response = await fetchICloudImage(TOKEN, 'guid-001', 'large-cs', fetchImpl as typeof fetch)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('image-bytes')
  })

  test('fails when the derivative is not in the asset map', async () => {
    const fetchImpl = async () => jsonResponse({ items: {}, locations: {} })
    await expect(fetchICloudImage(TOKEN, 'guid-001', 'missing-cs', fetchImpl as typeof fetch))
      .rejects.toThrow('unavailable')
  })
})
