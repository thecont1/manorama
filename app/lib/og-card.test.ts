import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { renderOgCard, ogCardResponse, OG_WIDTH, OG_HEIGHT } from './og-card'

/**
 * The jimp fallback is the compositor that actually runs in dev and in
 * any runtime without Cloudflare image transformations, so it is
 * exercised here for real — no mocked image library.
 */

const jpegBytes = async (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 40, g: 90, b: 60 } } }).jpeg().toBuffer()

const pngPill = async () =>
  sharp({ create: { width: 360, height: 96, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 0.6 } } }).png().toBuffer()

/** A fetch that serves a photo and a pill, and records what was asked. */
const imageFetch = (photo: Uint8Array, pill: Uint8Array, calls: string[] = []) =>
  (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('pill')) return new Response(pill as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } })
    return new Response(photo as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
  }) as unknown as typeof fetch

describe('the jimp fallback compositor', () => {
  test('produces a real 1200x630 JPEG when no edge transform ran', async () => {
    // No `cf-resized` header — exactly what vite dev and workerd return.
    const response = await renderOgCard(
      'https://example.test/photo.jpg',
      'https://example.test/pill.png',
      imageFetch(await jpegBytes(1600, 900), await pngPill()),
    )
    expect(response).not.toBeNull()
    const output = Buffer.from(await response!.arrayBuffer())
    const meta = await sharp(output).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(OG_WIDTH)
    expect(meta.height).toBe(OG_HEIGHT)
  })

  test('fits a portrait source whole inside the card on the dark canvas', async () => {
    const response = await renderOgCard(
      'https://example.test/photo.jpg',
      'https://example.test/pill.png',
      imageFetch(await jpegBytes(800, 1400), await pngPill()),
    )
    const output = Buffer.from(await response!.arrayBuffer())
    const meta = await sharp(output).metadata()
    expect(meta.width).toBe(OG_WIDTH)
    expect(meta.height).toBe(OG_HEIGHT)
    // Pillarboxed, not cropped: the dark canvas fills the sides and the
    // photo fills the height, so nothing at the top of the frame is cut.
    const band = await sharp(output).extract({ left: 10, top: 300, width: 20, height: 20 }).raw().toBuffer()
    for (const channel of band) expect(channel).toBeLessThan(30)
    const photo = await sharp(output).extract({ left: 590, top: 540, width: 20, height: 20 }).raw().toBuffer()
    let green = 0
    for (let i = 1; i < photo.length; i += 3) green += photo[i]
    expect(green / (photo.length / 3)).toBeGreaterThan(60)
  })

  test('passes an edge-transformed response straight through', async () => {
    const transformed = (async () => new Response('edge-bytes', {
      headers: { 'Content-Type': 'image/jpeg', 'cf-resized': 'internal stats' },
    })) as unknown as typeof fetch
    const response = await renderOgCard('https://example.test/photo.jpg', 'https://example.test/pill.png', transformed)
    expect(await response!.text()).toBe('edge-bytes')
  })

  test('asks the edge for a padded fit with the pill strictly centered', async () => {
    let cfImage: { fit?: string; draw?: Array<{ left: number; top: number; width: number; height: number }> } | undefined
    const capture = (async (_input: Parameters<typeof fetch>[0], init?: { cf?: { image?: typeof cfImage } }) => {
      cfImage = init?.cf?.image
      return new Response('edge-bytes', { headers: { 'Content-Type': 'image/jpeg', 'cf-resized': 'internal stats' } })
    }) as unknown as typeof fetch
    await renderOgCard('https://example.test/photo.jpg', 'https://example.test/pill.png', capture)
    // pad = contain on a fixed canvas — the whole frame survives.
    expect(cfImage?.fit).toBe('pad')
    expect(cfImage?.draw).toHaveLength(1)
    const pill = cfImage!.draw![0]
    expect(pill.width).toBe(756)
    expect(pill.height).toBe(202)
    expect(pill.left).toBe((OG_WIDTH - 756) / 2)
    expect(pill.top).toBe(Math.round((OG_HEIGHT - 202) / 2))
  })

  test('still produces a card when the pill asset is missing', async () => {
    const photo = await jpegBytes(1600, 900)
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('pill')) return new Response(null, { status: 404 })
      return new Response(photo as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
    }) as unknown as typeof fetch
    const response = await renderOgCard('https://example.test/photo.jpg', 'https://example.test/pill.png', fetchImpl)
    const meta = await sharp(Buffer.from(await response!.arrayBuffer())).metadata()
    expect(meta.width).toBe(OG_WIDTH)
  })

  test('returns null when the photo cannot be fetched', async () => {
    const failing = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    expect(await renderOgCard('https://example.test/x.jpg', 'https://example.test/pill.png', failing)).toBeNull()
  })

  test('returns null when the photo bytes are not an image', async () => {
    const garbage = (async () => new Response('not an image', { headers: { 'Content-Type': 'image/jpeg' } })) as unknown as typeof fetch
    expect(await renderOgCard('https://example.test/x.jpg', 'https://example.test/pill.png', garbage)).toBeNull()
  })

  test('returns null when the fetch itself throws', async () => {
    const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await renderOgCard('https://example.test/x.jpg', 'https://example.test/pill.png', throwing)).toBeNull()
  })
})

describe('ogCardResponse', () => {
  const item = {
    id: 'p-1',
    ref: 'guid-1',
    filename: 'one.jpg',
    src: '/api/icloud/image?album=t&photo=guid-1&c=large',
    width: 2048,
    height: 1536,
    alt: 'A photograph',
    c2pa: false,
    placeholder: '',
  }

  test('serves the composite with a day of public cache', async () => {
    const response = await ogCardResponse(
      item,
      'https://manorama.xyz/api/og/owner/slug',
      imageFetch(await jpegBytes(1600, 900), await pngPill()),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })

  test('resolves the proxy-relative src against the request origin', async () => {
    const calls: string[] = []
    await ogCardResponse(
      item,
      'https://manorama.xyz/api/og/owner/slug',
      imageFetch(await jpegBytes(400, 300), await pngPill(), calls),
    )
    expect(calls[0]).toBe('https://manorama.xyz/api/icloud/image?album=t&photo=guid-1&c=large')
  })

  test('an item with no usable source redirects to the static card', async () => {
    const response = await ogCardResponse(undefined, 'https://manorama.xyz/api/og/owner/slug')
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('/og-image.png')
  })

  test('a compositor failure redirects rather than serving a broken image', async () => {
    const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const response = await ogCardResponse(item, 'https://manorama.xyz/api/og/owner/slug', failing)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('/og-image.png')
  })
})
