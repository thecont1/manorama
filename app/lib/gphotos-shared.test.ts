import { describe, expect, test } from 'bun:test'
import {
  extractGPhotosShare,
  fetchGPhotosImage,
  gphotosAlbumIdOf,
  parseSharePage,
  scanGPhotosAlbum,
} from './gphotos-shared'
import { MAX_GALLERY_ITEMS, SourceFetchError, isVideoItem, type VideoItem } from './imagesource'

const ALBUM_ID = 'AF1QipAlbumIdTestValue0123456789abcdefghijklmnop'
const KEY = 'k3yAbCdEf0123456789'
const SHARE_URL = `https://photos.google.com/share/${ALBUM_ID}?key=${KEY}`

/** A media item node as the share page emits it: [uid, [base, w, h, …], …]. */
const item = (uid: string, w = 4000, h = 3000, extra: unknown[] = []): unknown[] => [
  uid,
  [`https://lh3.googleusercontent.com/pw/${uid}key`, w, h, 0, 'sig', 'sig2', h, w],
  1000,
  ...extra,
]

/** The share page's ds:1 payload: [null, items, nextToken, albumDetails, …]. */
const sharePage = (
  items: unknown[],
  { token = '', title = 'Fixture album', albumId = ALBUM_ID }: { token?: string; title?: string | null; albumId?: string } = {},
) => {
  const data = [null, items, token, [albumId, title], null, null, null, null]
  return [
    '<html><head>',
    `<title>${title ?? ''} - Google Photos</title>`,
    `<link href="https://photos.google.com/share/${albumId}?key=${KEY}" rel="canonical">`,
    '</head><body>',
    `<script>AF_initDataCallback({key: 'ds:0', hash: '1', data:[], sideChannel: {}});</script>`,
    `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});</script>`,
    '</body></html>',
  ].join('')
}

/** The batchexecute response envelope: )]}' line, then JSON lines whose
 *  wrb.fr/snAcKc entry carries the inner payload as an encoded string. */
const batchResponse = (items: unknown[], nextToken = '', { albumId = ALBUM_ID, title = '' } = {}) => {
  const inner = [null, items, nextToken, [albumId, title], null]
  const envelope = [['wrb.fr', 'snAcKc', JSON.stringify(inner), null, 'generic']]
  return new Response(`)]}'\n\n${JSON.stringify(envelope)}\n`, { status: 200 })
}

type Stub = { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] }

/** Stubs the share page (optionally redirected to a resolved URL) plus any
 *  batchexecute page answers, in order. */
const stubScan = (
  html: string | Response,
  { finalUrl, pages = [] }: { finalUrl?: string; pages?: (Response | string)[] } = {},
): Stub => {
  const calls: Stub['calls'] = []
  let pageIndex = 0
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (url.includes('batchexecute')) {
      const answer = pages[pageIndex] ?? batchResponse([])
      pageIndex += 1
      return typeof answer === 'string' ? new Response(answer, { status: 200 }) : answer
    }
    const res = typeof html === 'string' ? new Response(html, { status: 200 }) : html
    if (finalUrl) Object.defineProperty(res, 'url', { value: finalUrl })
    return res
  }) as typeof fetch
  return { impl, calls }
}

describe('extractGPhotosShare', () => {
  test('parses the full share URL and keeps album id and key separate', () => {
    expect(extractGPhotosShare(SHARE_URL)).toEqual({ kind: 'share', albumId: ALBUM_ID, key: KEY })
  })

  test('parses the /photo/ item-in-album variant and keyless share links', () => {
    expect(extractGPhotosShare(`${SHARE_URL}&hl=en`)).toEqual({ kind: 'share', albumId: ALBUM_ID, key: KEY })
    expect(extractGPhotosShare(`https://photos.google.com/share/${ALBUM_ID}/photo/AF1QipItem01234567?key=${KEY}`))
      .toEqual({ kind: 'share', albumId: ALBUM_ID, key: KEY })
    expect(extractGPhotosShare(`https://photos.google.com/share/${ALBUM_ID}`))
      .toEqual({ kind: 'share', albumId: ALBUM_ID, key: null })
  })

  test('parses app.goo.gl short links', () => {
    expect(extractGPhotosShare('https://photos.app.goo.gl/o9RAqWymhNRetMTW7'))
      .toEqual({ kind: 'short', token: 'o9RAqWymhNRetMTW7' })
    expect(extractGPhotosShare('https://photos.app.goo.gl/o9RAqWymhNRetMTW7?_imcp=1'))
      .toEqual({ kind: 'short', token: 'o9RAqWymhNRetMTW7' })
  })

  test('rejects non-share Google Photos paths and foreign hosts', () => {
    expect(extractGPhotosShare('https://photos.google.com/')).toBeNull()
    expect(extractGPhotosShare('https://photos.google.com/u/0/')).toBeNull()
    expect(extractGPhotosShare('https://photos.google.com/share/abc')).toBeNull()
    expect(extractGPhotosShare('https://photos.google.com/share/')).toBeNull()
    expect(extractGPhotosShare('https://photos.app.goo.gl/')).toBeNull()
    expect(extractGPhotosShare('https://goo.gl/photos/abc')).toBeNull()
    expect(extractGPhotosShare('https://photos.google.com.evil.com/share/AF1QipLongEnoughId')).toBeNull()
    expect(extractGPhotosShare('ftp://photos.google.com/share/AF1QipLongEnoughId')).toBeNull()
    expect(extractGPhotosShare('not a url')).toBeNull()
    expect(extractGPhotosShare('')).toBeNull()
  })
})

describe('gphotosAlbumIdOf', () => {
  test('reduces share links to the album id and reports nothing for short links', () => {
    expect(gphotosAlbumIdOf(SHARE_URL)).toBe(ALBUM_ID)
    expect(gphotosAlbumIdOf(`https://photos.google.com/share/${ALBUM_ID}`)).toBe(ALBUM_ID)
    expect(gphotosAlbumIdOf('https://photos.app.goo.gl/o9RAqWymhNRetMTW7')).toBeNull()
    expect(gphotosAlbumIdOf('https://photos.google.com/u/0/')).toBeNull()
  })
})

describe('parseSharePage', () => {
  test('extracts items, title and positional token from the ds:1 block', () => {
    const page = parseSharePage(sharePage([item('AF1QipItem000000001'), item('AF1QipItem000000002')], {
      token: 'AH_nextTokenValue0123456789abcdefghijklmnopqr',
      title: 'Preseason 2025',
    }))
    expect(page.albumFound).toBe(true)
    expect(page.items).toHaveLength(2)
    expect(page.title).toBe('Preseason 2025')
    expect(page.token).toBe('AH_nextTokenValue0123456789abcdefghijklmnopqr')
  })

  test('falls back to the last AH_ token when the token slot is empty', () => {
    const ah = 'AH_fallbackToken0123456789abcdefghijklmnopqrs'
    const html = sharePage([item('AF1QipItem000000001')]) + `<script>var t = "${ah}";</script>`
    expect(parseSharePage(html).token).toBe(ah)
  })

  test('marks an empty album as found — it is a readable page with no items', () => {
    const page = parseSharePage(sharePage([]))
    expect(page.albumFound).toBe(true)
    expect(page.items).toHaveLength(0)
  })

  test('reports not-found on a page carrying no album block', () => {
    expect(parseSharePage('<html><body>download the app</body></html>')).toEqual({
      items: [],
      token: null,
      albumFound: false,
    })
  })
})

describe('scanGPhotosAlbum', () => {
  test('scans a share link into gallery images in album order', async () => {
    const stub = stubScan(sharePage([
      item('AF1QipItem000000001', 4000, 3000),
      item('AF1QipItem000000002', 3000, 4000),
      item('AF1QipItem000000003', 2000, 2000),
    ], { title: 'Preseason 2025' }))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.sourceUrl).toBe(SHARE_URL)
    expect(scan.title).toBe('Preseason 2025')
    expect(scan.images.map((image) => image.filename)).toEqual(['Photo 1', 'Photo 2', 'Photo 3'])
    const first = scan.images[0]
    expect(first.ref).toBe('AF1QipItem000000001')
    expect(first.src).toBe(`/api/gphotos/image?u=${encodeURIComponent('https://lh3.googleusercontent.com/pw/AF1QipItem000000001key')}&r=w4000`)
    expect(first.width).toBe(4000)
    expect(first.height).toBe(3000)
    expect(first.c2pa).toBe(false)
    expect(first.fidelity).toBe('full-resolution-render')
    expect(first.variants?.[0]?.src).toBe(`/api/gphotos/image?u=${encodeURIComponent('https://lh3.googleusercontent.com/pw/AF1QipItem000000001key')}&r=h256`)
    // Portrait item keeps its thumbnail under intrinsic height.
    expect(scan.images[1].variants?.[0]?.width).toBe(192)

    // A source wider than the proxy's rendition bound gets the largest
    // supported rendition; intrinsic dimensions still report the source.
    const wide = stubScan(sharePage([item('AF1QipItemWide000001', 20000, 10000)]))
    const wideScan = await scanGPhotosAlbum(SHARE_URL, wide.impl)
    expect(wideScan.images[0].src).toContain('r=w16384')
    expect(wideScan.images[0].width).toBe(20000)
    expect(wideScan.images[0].fidelity).toBe('display-derivative')
    // No token in the page → no batchexecute calls at all.
    expect(stub.calls.filter((c) => c.url.includes('batchexecute'))).toHaveLength(0)
  })

  test('appends _imcp=1 to the page fetch so short links serve the album page', async () => {
    const stub = stubScan(sharePage([item('AF1QipItem000000001')]))
    await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(new URL(stub.calls[0].url).searchParams.get('_imcp')).toBe('1')
  })

  test('resolves a short link through the redirected response URL', async () => {
    const stub = stubScan(sharePage([item('AF1QipItem000000001')]), { finalUrl: SHARE_URL })
    const scan = await scanGPhotosAlbum('https://photos.app.goo.gl/o9RAqWymhNRetMTW7', stub.impl)
    expect(scan.sourceUrl).toBe(SHARE_URL)
  })

  test('resolves a short link through the page canonical link when no redirect URL is visible', async () => {
    const stub = stubScan(sharePage([item('AF1QipItem000000001')]))
    const scan = await scanGPhotosAlbum('https://photos.app.goo.gl/o9RAqWymhNRetMTW7', stub.impl)
    expect(scan.sourceUrl).toBe(SHARE_URL)
  })

  test('paginates through batchexecute with the triple-nested f.req body', async () => {
    const token = 'AH_pageTwoToken0123456789abcdefghijklmnopqr'
    const stub = stubScan(
      sharePage([item('AF1QipItem000000001')], { token }),
      { pages: [batchResponse([item('AF1QipItem000000002'), item('AF1QipItem000000003')])] },
    )
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images.map((image) => image.ref)).toEqual([
      'AF1QipItem000000001', 'AF1QipItem000000002', 'AF1QipItem000000003',
    ])
    const rpcCall = stub.calls.find((c) => c.url.includes('batchexecute'))
    expect(rpcCall).toBeDefined()
    expect(rpcCall!.url).toContain('rpcids=snAcKc')
    const body = new URLSearchParams(String(rpcCall!.init?.body)).get('f.req')!
    const outer = JSON.parse(body)
    expect(outer[0][0][0]).toBe('snAcKc')
    expect(JSON.parse(outer[0][0][1])).toEqual([ALBUM_ID, token, null, KEY])
  })

  test('dedupes items repeated across page boundaries', async () => {
    const token = 'AH_pageTwoToken0123456789abcdefghijklmnopqr'
    const stub = stubScan(
      sharePage([item('AF1QipItem000000001'), item('AF1QipItem000000002')], { token }),
      { pages: [batchResponse([item('AF1QipItem000000002'), item('AF1QipItem000000003')])] },
    )
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images.map((image) => image.ref)).toEqual([
      'AF1QipItem000000001', 'AF1QipItem000000002', 'AF1QipItem000000003',
    ])
  })

  test('stops paging when the same token answers twice, and reports the listing partial', async () => {
    const token = 'AH_stuckToken0123456789abcdefghijklmnopqrs'
    const stub = stubScan(
      sharePage([item('AF1QipItem000000001')], { token }),
      { pages: [batchResponse([item('AF1QipItem00000000X')], token)] },
    )
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images).toHaveLength(2)
    expect(stub.calls.filter((c) => c.url.includes('batchexecute'))).toHaveLength(1)
    // The token was still live when the loop gave up — not a complete album.
    expect(scan.partial).toBe(true)
  })

  test('does not mark a fully-enumerated album partial, and never marks the cap itself partial', async () => {
    const complete = stubScan(sharePage([item('AF1QipItem000000001')]))
    expect((await scanGPhotosAlbum(SHARE_URL, complete.impl)).partial).toBeUndefined()

    const capped = stubScan(sharePage(
      Array.from({ length: MAX_GALLERY_ITEMS + 4 }, (_, i) => item(`AF1QipItem${String(i).padStart(8, '0')}`)),
      { token: 'AH_moreToken0123456789abcdefghijklmnopqrs' },
    ), { pages: [batchResponse([], 'AH_moreToken0123456789abcdefghijklmnopqrs')] })
    const scan = await scanGPhotosAlbum(SHARE_URL, capped.impl)
    expect(scan.images).toHaveLength(MAX_GALLERY_ITEMS)
    expect(scan.partial).toBeUndefined()
  })

  test('duplicates do not consume the enumeration bound', async () => {
    const dupes = Array.from({ length: MAX_GALLERY_ITEMS }, () => item('AF1QipItem000000001'))
    const video = item('AF1QipItemVideo00001', 1920, 1080, [[[['https://lh3.googleusercontent.com/pw/k=m18']]]])
    const stub = stubScan(
      sharePage([...dupes, video], { token: 'AH_pageTwoToken0123456789abcdefghijklmnopqr' }),
      { pages: [batchResponse([item('AF1QipItem000000002'), item('AF1QipItem000000003')])] },
    )
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images.map((image) => image.ref)).toEqual([
      'AF1QipItem000000001', 'AF1QipItemVideo00001', 'AF1QipItem000000002', 'AF1QipItem000000003',
    ])
    expect(stub.calls.filter((c) => c.url.includes('batchexecute'))).toHaveLength(1)
  })

  test('caps at MAX_GALLERY_ITEMS and reports the overrun', async () => {
    const items = Array.from({ length: MAX_GALLERY_ITEMS + 10 }, (_, i) => item(`AF1QipItem${String(i).padStart(8, '0')}`))
    const stub = stubScan(sharePage(items))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images).toHaveLength(MAX_GALLERY_ITEMS)
    expect(scan.truncated).toBe(MAX_GALLERY_ITEMS + 10)
  })

  test('keeps video items as videos and drops non-lh3 media urls', async () => {
    const video = item('AF1QipItemVideo00001', 1920, 1080, [[[['https://lh3.googleusercontent.com/pw/otherkey=m18']]]])
    const foreign = ['AF1QipItemForeign001', ['https://cdn.example.com/img.jpg', 1000, 1000], 1000]
    const stub = stubScan(sharePage([item('AF1QipItem000000001'), video, foreign]))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images.map((image) => image.ref)).toEqual(['AF1QipItem000000001', 'AF1QipItemVideo00001'])
    expect(isVideoItem(scan.images[1])).toBe(true)
  })

  test('emits a VideoItem from the descriptor shape current payloads use', async () => {
    const video = item('AF1QipItemVideo00001', 1080, 1920, [
      { '15': 4082, '76647426': [11157, null, 1080, 1920, null, 4, 134, null, [[1, null, 1080, 1920]], 0, null, null, null, ['https://lh3.googleusercontent.com/pw/AF1QipItemVideo00001key']] },
    ])
    const stub = stubScan(sharePage([item('AF1QipItem000000001'), video]))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    const emitted = scan.images[1]
    expect(isVideoItem(emitted)).toBe(true)
    const clip = emitted as VideoItem
    expect(clip.filename).toBe('Video 2')
    expect(clip.mimeType).toBe('video/mp4')
    expect(clip.durationSeconds).toBe(11.157)
    expect(clip.width).toBe(1080)
    expect(clip.height).toBe(1920)
    expect(clip.src).toBe('https://lh3.googleusercontent.com/pw/AF1QipItemVideo00001key=m22')
    expect(clip.poster.src).toBe(`/api/gphotos/image?u=${encodeURIComponent('https://lh3.googleusercontent.com/pw/AF1QipItemVideo00001key')}&r=w1080`)
    expect(clip.c2pa).toBe(false)
    expect(clip.fidelity).toBe('display-derivative')
  })

  test('emits a VideoItem without a duration for the older URL-marker shape', async () => {
    const video = item('AF1QipItemVideo00001', 1920, 1080, [[[['https://lh3.googleusercontent.com/pw/otherkey=m22']]]])
    const stub = stubScan(sharePage([video]))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    const emitted = scan.images[0]
    expect(isVideoItem(emitted)).toBe(true)
    expect((emitted as VideoItem).durationSeconds).toBeUndefined()
    expect((emitted as VideoItem).src).toMatch(/^https:\/\/lh3\.googleusercontent\.com\/.*=m22$/)
  })

  test('throws the empty-album error when the album block carries no items', async () => {
    const stub = stubScan(sharePage([]))
    await expect(scanGPhotosAlbum(SHARE_URL, stub.impl)).rejects.toThrow('No photos or videos were found')
  })

  test('throws the read-failure error on a page with no album block', async () => {
    const stub = stubScan('<html><body>get the app</body></html>')
    await expect(scanGPhotosAlbum(SHARE_URL, stub.impl)).rejects.toThrow('could not read that Google Photos album')
  })

  test('an all-video album scans to a video gallery', async () => {
    const video = item('AF1QipItemVideo00001', 1920, 1080, [[[['https://lh3.googleusercontent.com/pw/k=m22']]]])
    const stub = stubScan(sharePage([video]))
    const scan = await scanGPhotosAlbum(SHARE_URL, stub.impl)
    expect(scan.images).toHaveLength(1)
    expect(isVideoItem(scan.images[0])).toBe(true)
  })

  test('rejects non-share links with paste guidance', async () => {
    await expect(scanGPhotosAlbum('https://photos.google.com/u/0/')).rejects.toThrow('Use a public Google Photos shared album link')
    await expect(scanGPhotosAlbum('https://photos.google.com/')).rejects.toThrow('Use a public Google Photos shared album link')
  })

  test('surfaces an upstream 404 without retrying it', async () => {
    const stub = stubScan(new Response('nope', { status: 404 }))
    await expect(scanGPhotosAlbum(SHARE_URL, stub.impl)).rejects.toThrow('Manorama could not read that Google Photos album (404)')
    expect(stub.calls).toHaveLength(1)
  })

  test('retries a transient 5xx once', async () => {
    const calls: string[] = []
    let first = true
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input))
      if (first) {
        first = false
        return new Response('boom', { status: 503 })
      }
      return new Response(sharePage([item('AF1QipItem000000001')]), { status: 200 })
    }) as typeof fetch
    const scan = await scanGPhotosAlbum(SHARE_URL, impl)
    expect(scan.images).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  test('a malformed batchexecute answer fails the scan', async () => {
    const token = 'AH_pageTwoToken0123456789abcdefghijklmnopqr'
    const stub = stubScan(
      sharePage([item('AF1QipItem000000001')], { token }),
      { pages: [')]}\'\n\n{"not":"an envelope"}\n', ')]}\'\n\n{"not":"an envelope"}\n'] },
    )
    await expect(scanGPhotosAlbum(SHARE_URL, stub.impl)).rejects.toThrow('could not read that Google Photos album')
  })
})

describe('fetchGPhotosImage', () => {
  const BASE = 'https://lh3.googleusercontent.com/pw/AP1GczTestKey0123456789'

  const recording = (response: Response) => {
    const urls: string[] = []
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return response
    }) as typeof fetch
    return { urls, impl }
  }

  test('fetches the lh3 base URL with the rendition appended', async () => {
    const { urls, impl } = recording(new Response('jpeg', { status: 200 }))
    const res = await fetchGPhotosImage(BASE, 'w400', impl)
    expect(res.status).toBe(200)
    expect(urls).toEqual([`${BASE}=w400`])
  })

  test('replaces an existing rendition suffix rather than stacking it', async () => {
    const { urls, impl } = recording(new Response('jpeg', { status: 200 }))
    await fetchGPhotosImage(`${BASE}=w800`, 'h256', impl)
    expect(urls).toEqual([`${BASE}=h256`])
  })

  test('strips query and fragment from the media URL', async () => {
    const { urls, impl } = recording(new Response('jpeg', { status: 200 }))
    await fetchGPhotosImage(`${BASE}?x=1#frag`, 'w400', impl)
    expect(urls).toEqual([`${BASE}=w400`])
  })

  test('rejects non-lh3 hosts, http, userinfo and malformed URLs before fetching', async () => {
    const { urls, impl } = recording(new Response('jpeg', { status: 200 }))
    for (const u of [
      'https://lh3.googleusercontent.com.evil.com/pw/x',
      'https://photos.google.com/pw/x',
      'http://lh3.googleusercontent.com/pw/x',
      'https://user:pass@lh3.googleusercontent.com/pw/x',
      'not a url',
    ]) {
      await expect(fetchGPhotosImage(u, 'w400', impl)).rejects.toBeInstanceOf(SourceFetchError)
    }
    expect(urls).toHaveLength(0)
  })

  test('rejects rendition shapes outside the w/h whitelist', async () => {
    const { urls, impl } = recording(new Response('jpeg', { status: 200 }))
    for (const r of ['m18', 'd', 's256', 'w0', 'w99999', 'w400-no', '', 'x']) {
      await expect(fetchGPhotosImage(BASE, r, impl)).rejects.toBeInstanceOf(SourceFetchError)
    }
    expect(urls).toHaveLength(0)
  })

  test('does not retry a confirmed 404 and retries a 5xx once', async () => {
    const { urls: miss, impl: missImpl } = recording(new Response('nope', { status: 404 }))
    await expect(fetchGPhotosImage(BASE, 'w400', missImpl)).rejects.toBeInstanceOf(SourceFetchError)
    expect(miss).toHaveLength(1)

    const { urls: boom, impl: boomImpl } = recording(new Response('boom', { status: 503 }))
    await expect(fetchGPhotosImage(BASE, 'w400', boomImpl)).rejects.toBeInstanceOf(SourceFetchError)
    expect(boom).toHaveLength(2)
  })
})
