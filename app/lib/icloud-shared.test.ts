import { describe, expect, test } from 'bun:test'
import { extractAlbumToken, fetchICloudImage, fetchICloudVideo, scanICloudAlbum } from './icloud-shared'
import { isVideoItem, type VideoItem } from './imagesource'

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

  test('accepts URL-safe base64 tokens with underscores and hyphens', () => {
    const keyful = 'D2Qv3tFZXL1DdQpxHAcXpw3cqMQCAEQARog37SEKLOdR2VGldxDb_fR8M0bWgl5JpBS53glgiYNxH8'
    expect(extractAlbumToken(`https://www.icloud.com/sharedalbum/#${keyful}`)).toBe(keyful)
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

  test('video entries now join the gallery instead of being filtered out', async () => {
    // Behaviour change: iCloud videos used to be dropped at scan time.
    // They are ingested as VideoItems now — see the video describe block.
    const fetchImpl = async () => jsonResponse(stream([
      photo(),
      photo({ photoGuid: 'guid-003', mediaAssetType: 'video' }),
    ]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(2)
    expect(scan.images.map((item) => item.ref)).toEqual(['guid-001', 'guid-003'])
    expect(isVideoItem(scan.images[1])).toBe(true)
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

  test('fails friendly when the album is empty', async () => {
    const fetchImpl = async () => jsonResponse(stream([]))
    await expect(scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch))
      .rejects.toThrow('No photos or videos')
  })

  test('skips a video whose derivatives cannot be split', async () => {
    // One derivative only: no poster to pair with the clip, so the entry
    // is dropped exactly like a preview-less image.
    const fetchImpl = async () => jsonResponse(stream([
      photo(),
      photo({ photoGuid: 'guid-bad', mediaAssetType: 'video', derivatives: { '1': { checksum: 'only-cs', width: 640, height: 360 } } }),
    ]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    expect(scan.images[0].ref).toBe('guid-001')
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

const videoPhoto = (overrides: Record<string, unknown> = {}) => ({
  photoGuid: 'guid-vid',
  caption: 'Backwater drift',
  mediaAssetType: 'video',
  duration: 97,
  derivatives: {
    '1': { checksum: 'poster-cs', width: 1280, height: 720, fileSize: 90000 },
    '2': { checksum: 'movie-cs', width: 1280, height: 720, fileSize: 8400000, fileType: 'public.mpeg-4' },
  },
  ...overrides,
})

describe('scanICloudAlbum with video entries', () => {
  test('emits a VideoItem with an MP4 proxy src and a poster derivative', async () => {
    const fetchImpl = async () => jsonResponse(stream([videoPhoto()]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    const item = scan.images[0]
    expect(isVideoItem(item)).toBe(true)
    const video = item as VideoItem
    expect(video.type).toBe('video')
    expect(video.mimeType).toBe('video/mp4')
    expect(video.ref).toBe('guid-vid')
    expect(video.src).toBe('/api/icloud/video?album=B0z5qAGN1JIFd3y&photo=guid-vid&c=movie-cs')
    expect(video.poster.src).toBe('/api/icloud/image?album=B0z5qAGN1JIFd3y&photo=guid-vid&c=poster-cs')
    expect(video.durationSeconds).toBe(97)
    expect(video.c2pa).toBe(false)
    expect(video.caption).toBe('Backwater drift')
    expect(video.alt).toBe('Backwater drift')
  })

  test('the poster doubles as variants[0] so the admin rail works unchanged', async () => {
    const fetchImpl = async () => jsonResponse(stream([videoPhoto()]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images[0].variants?.[0]?.src).toContain('c=poster-cs')
  })

  test('mixed albums keep source order and key every item by ref', async () => {
    const fetchImpl = async () => jsonResponse(stream([
      photo(),
      videoPhoto(),
      photo({ photoGuid: 'guid-003', caption: 'Canoe' }),
    ]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images.map((item) => item.ref)).toEqual(['guid-001', 'guid-vid', 'guid-003'])
    expect(scan.images.map((item) => isVideoItem(item))).toEqual([false, true, false])
    // Images must not gain a `type` key — all-photo manifests stay
    // byte-identical, so there is no migration.
    expect('type' in scan.images[0]).toBe(false)
  })

  test('falls back to byte size when no derivative carries a video marker', async () => {
    const fetchImpl = async () => jsonResponse(stream([videoPhoto({
      derivatives: {
        '1': { checksum: 'poster-cs', width: 1280, height: 720, fileSize: 80000 },
        '2': { checksum: 'movie-cs', width: 1280, height: 720, fileSize: 9000000 },
      },
    })]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    const video = scan.images[0] as VideoItem
    expect(video.src).toContain('c=movie-cs')
    expect(video.poster.src).toContain('c=poster-cs')
  })

  test('probes content type when both markers and sizes are ambiguous', async () => {
    const probed: string[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes('webstream')) {
        return jsonResponse(stream([videoPhoto({
          derivatives: {
            '1': { checksum: 'a-cs', width: 1280, height: 720, fileSize: 500000 },
            '2': { checksum: 'b-cs', width: 1280, height: 720, fileSize: 500000 },
          },
        })]))
      }
      if (url.includes('webasseturls')) {
        return jsonResponse({
          items: { 'a-cs': { url_location: 'cdn', url_path: '/p/a' }, 'b-cs': { url_location: 'cdn', url_path: '/p/b' } },
          locations: { cdn: { scheme: 'https', hosts: ['cvws.icloud-content.com'] } },
        })
      }
      if (init?.method === 'HEAD') {
        probed.push(url)
        const isVideo = url.endsWith('/p/a')
        return new Response(null, { status: 200, headers: { 'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg' } })
      }
      return jsonResponse({}, 404)
    }
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as unknown as typeof fetch)
    expect(probed.length).toBeGreaterThan(0)
    const video = scan.images[0] as VideoItem
    expect(video.src).toContain('c=a-cs')
    expect(video.poster.src).toContain('c=b-cs')
  })
})

describe('fetchICloudVideo', () => {
  const assetFetch = (onRequest?: (url: string, init?: RequestInit) => Response) =>
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes('webasseturls')) {
        return jsonResponse({
          items: { 'movie-cs': { url_location: 'cdn', url_path: '/p/movie.mp4' } },
          locations: { cdn: { scheme: 'https', hosts: ['cvws.icloud-content.com'] } },
        })
      }
      return onRequest?.(url, init) ?? new Response('mp4-bytes', { status: 200, headers: { 'Content-Type': 'video/mp4' } })
    }

  test('streams the full clip when no Range is supplied', async () => {
    const response = await fetchICloudVideo(TOKEN, 'guid-vid', 'movie-cs', undefined, assetFetch() as unknown as typeof fetch)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('mp4-bytes')
  })

  test('forwards Range upstream and passes the 206 through', async () => {
    let forwarded: string | undefined
    const fetchImpl = assetFetch((_url, init) => {
      forwarded = new Headers(init?.headers).get('Range') ?? undefined
      return new Response('partial', {
        status: 206,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/8400000', 'Accept-Ranges': 'bytes' },
      })
    })
    const response = await fetchICloudVideo(TOKEN, 'guid-vid', 'movie-cs', 'bytes=0-1023', fetchImpl as unknown as typeof fetch)
    expect(forwarded).toBe('bytes=0-1023')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 0-1023/8400000')
  })

  test('fails when the derivative is not in the asset map', async () => {
    const fetchImpl = async () => jsonResponse({ items: {}, locations: {} })
    await expect(fetchICloudVideo(TOKEN, 'guid-vid', 'missing-cs', undefined, fetchImpl as typeof fetch))
      .rejects.toThrow('unavailable')
  })
})
