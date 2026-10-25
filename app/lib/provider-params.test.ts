import { describe, expect, test } from 'bun:test'
import { fetchICloudImage } from './icloud-shared'
import { fetchMegaFile, fetchMegaPreview } from './mega-public'

/**
 * The scan path validates provider references; the proxy routes do not.
 * `extractAlbumToken` enforces `^[A-Za-z0-9_-]+$` at scan time, but
 * `/api/icloud/*` splices `album` into an upstream URL untouched — so a `/`
 * shatters the base62 partition derivation and a `?` swallows the trailing
 * path segment into a query string. MEGA's `k` is likewise unvalidated: a
 * three-byte key decrypts with an empty nonce and answers 200 with garbage
 * instead of a 400.
 *
 * The asset host for iCloud comes back from Apple's JSON and is fetched
 * unvalidated, which is what lets a wrong partition or a spoofed response
 * point the fetch elsewhere.
 */

const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 })
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

const assetMap = (host: string) => json({
  items: { SYNTH: { url_location: 'L1', url_path: '/synthetic/asset.jpg' } },
  locations: { L1: { scheme: 'https', hosts: [host] } },
})

describe('iCloud proxy references', () => {
  test('a token-shaped album builds the documented partition URL', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      seen.push(url)
      return url.includes('/sharedstreams/') ? assetMap('cvws.icloud-content.com') : new Response(JPEG, { status: 200 })
    }) as typeof fetch

    await fetchICloudImage('AbCdEf012345', 'abcdef0123456789', 'SYNTH', fetchImpl)

    // 'A' + one base62 char is the single-char partition form; 'b' is 37.
    expect(seen[0]).toBe('https://p37-sharedstreams.icloud.com/AbCdEf012345/sharedstreams/webasseturls')
  })

  test('a path-shaped album is refused before any fetch', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      seen.push(url)
      return url.includes('/sharedstreams/') ? assetMap('cvws.icloud-content.com') : new Response(JPEG, { status: 200 })
    }) as typeof fetch

    await expect(fetchICloudImage('SYNTH/inner', 'abcdef0123456789', 'SYNTH', fetchImpl))
      .rejects.toMatchObject({ status: 400 })
    expect(seen).toEqual([])
  })

  test('a `?` inside the album is refused before any fetch', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      seen.push(url)
      return url.includes('/sharedstreams/') ? assetMap('cvws.icloud-content.com') : new Response(JPEG, { status: 200 })
    }) as typeof fetch

    await expect(fetchICloudImage('SYNTH?probe=1', 'abcdef0123456789', 'SYNTH', fetchImpl))
      .rejects.toMatchObject({ status: 400 })
    expect(seen).toEqual([])
  })

  test('a foreign asset host is refused', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      seen.push(url)
      return url.includes('/sharedstreams/') ? assetMap('foreign-host.example') : new Response(JPEG, { status: 200 })
    }) as typeof fetch

    await expect(fetchICloudImage('AbCdEf012345', 'abcdef0123456789', 'SYNTH', fetchImpl))
      .rejects.toMatchObject({ status: 404 })
  })

  test('an Apple CDN asset host is accepted', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      seen.push(url)
      return url.includes('/sharedstreams/') ? assetMap('cvws.icloud-content.com') : new Response(JPEG, { status: 200 })
    }) as typeof fetch

    await fetchICloudImage('AbCdEf012345', 'abcdef0123456789', 'SYNTH', fetchImpl)

    expect(seen.at(-1)!.startsWith('https://cvws.icloud-content.com/')).toBe(true)
  })
})

describe('MEGA proxy references', () => {
  const megaFetch = (size = 4096) => (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('g.api.mega.co.nz')) return json({ g: 'https://gfs.example/synthetic', s: size })
    return new Response(new Uint8Array(size), { status: 200 })
  }) as typeof fetch

  test('a key of the wrong length is refused rather than decrypted with an empty nonce', async () => {
    // 3 bytes: ctrCrypt then reads nonce from subarray(16, 24) === empty.
    await expect(fetchMegaFile('SYNTH', undefined, 'SYNTHNODE', 'AAAA', megaFetch())).rejects.toThrow()
  })

  test('a 32-byte key is accepted', async () => {
    // 'A'.repeat(43) is a 32-byte key in base64url — the file-key layout.
    const response = await fetchMegaFile('SYNTH', undefined, 'SYNTHNODE', 'A'.repeat(43), megaFetch())
    expect(response.status).toBe(200)
  })

  test('a 16-byte key is accepted for previews', async () => {
    // Previews are CBC attribute records — foldKey only, no nonce, so the
    // 16-byte element key is legitimate. The stubbed ufa response misses,
    // which proves the run reached the network rather than a 400.
    const fah = btoa(String.fromCharCode(...new Uint8Array(8))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    await expect(
      fetchMegaPreview('SYNTH', undefined, fah, 'AAAAAAAAAAAAAAAAAAAAAA', megaFetch()),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('a preview with a malformed file-attribute handle answers 404, not 500', async () => {
    await expect(
      fetchMegaPreview('SYNTH', undefined, 'not-a-handle', 'AAAAAAAAAAAAAAAAAAAAAA', megaFetch()),
    ).rejects.toMatchObject({ status: 404 })
  })
})
