import { describe, expect, test } from 'bun:test'
import { extractAlbumToken, fetchICloudCkImage, fetchICloudCkVideo, fetchICloudImage, fetchICloudVideo, scanICloudAlbum } from './icloud-shared'
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

  test('throws a usable input error instead of URL throwing on malformed input', () => {
    expect(extractAlbumToken('not a url')).toBeNull()
    expect(extractAlbumToken('')).toBeNull()
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

  test('retries the listing once on a transient answer', async () => {
    // Same bounded retry the media proxies carry — a burst-load 429 must
    // not kill the whole scan.
    const calls: string[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      calls.push(url)
      if (calls.length === 1) return jsonResponse({}, 429)
      return jsonResponse(stream([photo()]))
    }
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(calls).toHaveLength(2)
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

  test('splits on derivative key names when fields arrive as strings (real vintage)', async () => {
    // The observed live payload: no marker fields at all, fileSize and
    // dimensions as STRINGS, and roles carried by the derivative key
    // names — 720p/360p are the MP4s, PosterFrame the still.
    const fetchImpl = async () => jsonResponse(stream([videoPhoto({
      duration: '83',
      derivatives: {
        '720p': { fileSize: '3846231', checksum: 'hi-cs', width: '1280', state: 'available', height: '912' },
        'PosterFrame': { fileSize: '219154', checksum: 'poster-cs', width: '1137', state: 'available', height: '810' },
        '360p': { fileSize: '1293631', checksum: 'lo-cs', width: '640', state: 'available', height: '456' },
      },
    })]))
    const scan = await scanICloudAlbum(`https://www.icloud.com/sharedalbum/#${TOKEN}`, fetchImpl as typeof fetch)
    expect(scan.images).toHaveLength(1)
    const video = scan.images[0] as VideoItem
    expect(isVideoItem(video)).toBe(true)
    expect(video.src).toContain('c=hi-cs')
    expect(video.poster.src).toContain('c=poster-cs')
    // Emitted dimensions are real numbers even though the wire sent strings.
    expect(video.width).toBe(1280)
    expect(video.poster.width).toBe(1137)
    expect(video.durationSeconds).toBe(83)
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

describe('CloudKit shared albums (photos.icloud.com/shared/album)', () => {
  const GUID = '0d6mJ9JupJ9g-j3sm321V1KNw'
  const LINK = `https://photos.icloud.com/shared/album/${GUID}/`
  const ZONE = { zoneName: 'SharedCollection-abc', ownerRecordName: '_owner1', zoneType: 'REGULAR_CUSTOM_ZONE' }

  const ckResolve = () => jsonResponse({
    results: [{
      zoneID: ZONE,
      anonymousPublicAccess: { token: 'anon-token', databasePartition: 'https://p148-ckdatabasews.icloud.com:443' },
      share: { fields: { 'cloudkit.title': { value: 'Panoramas' } } },
    }],
  })

  const resField = (stem: string, w: number, h: number) => ({
    [`${stem}Res`]: { value: { downloadURL: `https://cvws-h2.icloud-content.com/B/sum/${stem}`, fileSize: 1000 } },
    [`${stem}Width`]: { value: w },
    [`${stem}Height`]: { value: h },
  })

  const master = (overrides: Record<string, unknown> = {}) => ({
    recordName: 'rec-001',
    recordType: 'CPLMaster',
    fields: {
      itemType: { value: 'public.heic' },
      resOriginalWidth: { value: 4032 },
      resOriginalHeight: { value: 3024 },
      ...resField('resOriginal', 4032, 3024),
      ...resField('resJPEGLarge', 3308, 2481),
      ...resField('resJPEGMed', 1654, 1241),
      ...resField('resJPEGThumb', 340, 255),
      ...(overrides.fields as Record<string, unknown> ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'fields')),
  })

  const ckFetch = (records: unknown[], resolvePayload?: Response) => {
    const calls: string[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('records/resolve')) return resolvePayload ?? ckResolve()
      if (url.includes('records/query')) return jsonResponse({ records })
      return jsonResponse({}, 404)
    }
    return { fetchImpl: fetchImpl as typeof fetch, calls }
  }

  test('detectSource spelling: token comes from the path, kind is cloudkit', async () => {
    const { icloudLinkKind } = await import('./icloud-shared')
    expect(icloudLinkKind(LINK)).toBe('cloudkit')
    expect(icloudLinkKind(`https://www.icloud.com/sharedalbum/#${TOKEN}`)).toBe('legacy')
    expect(icloudLinkKind(`https://share.icloud.com/photos/${TOKEN}`)).toBe('legacy')
    expect(icloudLinkKind('https://photos.icloud.com/')).toBeNull()
    expect(extractAlbumToken(LINK)).toBe(GUID)
  })

  test('scans masters into proxy-referenced gallery images', async () => {
    const { fetchImpl, calls } = ckFetch([master()])
    const scan = await scanICloudAlbum(LINK, fetchImpl)
    expect(scan.sourceUrl).toBe(`https://photos.icloud.com/shared/album/${GUID}`)
    expect(scan.title).toBe('Panoramas')
    expect(scan.images).toHaveLength(1)
    const [item] = scan.images
    expect(item.ref).toBe('rec-001')
    // HEIC originals take Apple's largest JPEG, not the undecodable original.
    expect(item.src).toBe(`/api/icloud/image?album=${GUID}&photo=rec-001&c=resJPEGLargeRes&v=ck`)
    expect(item.variants?.[0]?.src).toContain('c=resJPEGThumbRes')
    // Dims report the original's pixels, not the rendition's.
    expect(item.width).toBe(4032)
    expect(item.height).toBe(3024)
    expect(item.c2pa).toBe(false)
    expect(calls.some((url) => url.includes('records/resolve'))).toBe(true)
    expect(calls.some((url) => url.includes('records/query'))).toBe(true)
  })

  test('browser-decodable originals keep their own bytes and C2PA flag', async () => {
    const { fetchImpl } = ckFetch([master({ fields: { itemType: { value: 'public.jpeg' } } })])
    const scan = await scanICloudAlbum(LINK, fetchImpl)
    expect(scan.images[0]?.src).toContain('c=resOriginalRes')
    expect(scan.images[0]?.c2pa).toBe(true)
  })

  test('movie masters become VideoItems with a Vid rendition and JPEG poster', async () => {
    const { fetchImpl } = ckFetch([master({
      fields: {
        itemType: { value: 'public.movie' },
        ...resField('resVidMed', 1920, 1080),
      },
    })])
    const scan = await scanICloudAlbum(LINK, fetchImpl)
    const video = scan.images[0]
    expect(video?.type).toBe('video')
    if (video?.type !== 'video') return
    expect(video.src).toContain('c=resVidMedRes')
    expect(video.src).toContain('/api/icloud/video')
    expect(video.poster.src).toContain('c=resJPEGLargeRes')
    expect(video.width).toBe(4032)
  })

  test('a non-public share reads as an album error, not a parse failure', async () => {
    const denied = jsonResponse({ results: [{ zoneID: ZONE, anonymousPublicAccess: {} }] })
    const { fetchImpl } = ckFetch([], denied)
    await expect(scanICloudAlbum(LINK, fetchImpl)).rejects.toThrow('not shared publicly')
  })

  describe('CloudKit media fetches (fetchICloudCkImage / fetchICloudCkVideo)', () => {
    const RECORD = 'rec-001'
    const FIELD = 'resJPEGLargeRes'
    const VID_FIELD = 'resVidMedRes'
    const APPLE_URL = 'https://cvws-h2.icloud-content.com/B/sum/resJPEGLarge'

    const lookupWith = (downloadURL: string) => jsonResponse({
      records: [{ recordName: RECORD, fields: { [FIELD]: { value: { downloadURL, fileSize: 1000 } }, [VID_FIELD]: { value: { downloadURL, fileSize: 9000 } } } }],
    })

    const ckMediaFetch = (opts: {
      downloadURL?: string
      lookupResponses?: Response[]
      onDownload?: (url: string, init?: RequestInit) => Response
    } = {}) => {
      const calls: string[] = []
      let lookups = 0
      const queue = [...(opts.lookupResponses ?? [])]
      const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('records/resolve')) return ckResolve()
        if (url.includes('records/lookup')) { lookups += 1; return queue[lookups - 1] ?? lookupWith(opts.downloadURL ?? APPLE_URL) }
        return opts.onDownload?.(url, init) ?? new Response('image-bytes', { status: 200 })
      }
      return { fetchImpl: fetchImpl as typeof fetch, calls }
    }

    test('rejects an invalid reference before any request leaves', async () => {
      const { fetchImpl, calls } = ckMediaFetch()
      await expect(fetchICloudCkImage('bad token!', RECORD, FIELD, fetchImpl)).rejects.toThrow('invalid')
      await expect(fetchICloudCkVideo(GUID, 'rec.001', FIELD, undefined, fetchImpl)).rejects.toThrow('invalid')
      await expect(fetchICloudCkImage(GUID, RECORD, 'thumbnail', fetchImpl)).rejects.toThrow('invalid')
      expect(calls).toHaveLength(0)
    })

    test('refuses a derivative downloadURL outside Apple hosts', async () => {
      const { fetchImpl } = ckMediaFetch({ downloadURL: 'https://evil.example.com/x.jpg' })
      await expect(fetchICloudCkImage(GUID, RECORD, FIELD, fetchImpl)).rejects.toThrow('unavailable')
    })

    test('re-resolves the share once after a 403 lookup, then answers', async () => {
      const { fetchImpl, calls } = ckMediaFetch({ lookupResponses: [jsonResponse({}, 403)] })
      const response = await fetchICloudCkImage(GUID, RECORD, FIELD, fetchImpl)
      expect(response.status).toBe(200)
      expect(calls.filter((url) => url.includes('records/resolve'))).toHaveLength(2)
      expect(calls.filter((url) => url.includes('records/lookup'))).toHaveLength(2)
    })

    test('forwards Range upstream and passes the 206 through', async () => {
      let forwarded: string | undefined
      const { fetchImpl } = ckMediaFetch({
        onDownload: (_url, init) => {
          forwarded = new Headers(init?.headers).get('Range') ?? undefined
          return new Response('partial', {
            status: 206,
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/9000000' },
          })
        },
      })
      const response = await fetchICloudCkVideo(GUID, RECORD, VID_FIELD, 'bytes=0-1023', fetchImpl)
      expect(forwarded).toBe('bytes=0-1023')
      expect(response.status).toBe(206)
    })

    test('a failed download drops the signed URL — the retry resolves again', async () => {
      let downloads = 0
      const { fetchImpl, calls } = ckMediaFetch({
        onDownload: () => (++downloads === 1
          ? new Response('stale', { status: 500 })
          : new Response('fresh', { status: 200 })),
      })
      const response = await fetchICloudCkVideo(GUID, RECORD, VID_FIELD, undefined, fetchImpl)
      expect(response.status).toBe(200)
      expect(downloads).toBe(2)
      // The retry looked the derivative up again rather than re-fetching
      // the URL that just failed — the failed signature stays evicted.
      expect(calls.filter((url) => url.includes('records/lookup'))).toHaveLength(2)
    })
  })
})
