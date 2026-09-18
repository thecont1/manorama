import { isVideoItem, type GalleryMediaItem } from './imagesource'

/**
 * Per-gallery Open Graph cards: the gallery's first frame, cover-cropped
 * to 1200×630 with the Manorama wordmark composited over it.
 *
 * Two compositors, one contract:
 *  - **`cf.image.draw`** on Cloudflare, where image transformations do the
 *    resize and overlay at the edge with zero dependencies.
 *  - **jimp** everywhere else (vite dev, tests, any runtime without the
 *    transform pipeline) — pure JS, so it runs in workerd too.
 *
 * Selection is by capability, not by env flag: a `cf-resized` response
 * header proves the transform ran. When it is absent the same request
 * fell through untransformed, so the bytes get composited locally. Dev
 * therefore exercises the fallback natively.
 */

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

/** Pre-baked wordmark on a translucent dark pill. Legible over any photo
 *  without a runtime scrim — see scripts/make-og-pill.ts. */
export const OG_PILL_PATH = '/og-logo-pill.png'
/** Static card served when anything at all goes wrong. */
export const OG_FALLBACK_PATH = '/og-image.png'

/** Pill geometry inside the 1200×630 card: bottom-left, with a margin
 *  that survives the platform crops social networks apply. */
const PILL_WIDTH = 360
const PILL_HEIGHT = 96
const PILL_MARGIN = 48

/**
 * Cache key for the card: the first item's stable key. Reordering a
 * gallery changes it, which busts the edge cache without a purge — the
 * whole reason the route takes `?i=`.
 */
export const ogItemKey = (item: GalleryMediaItem | undefined) =>
  item ? item.ref ?? item.filename : ''

/**
 * The still the card is built from. Videos contribute their poster; HEIC
 * images have no browser-decodable original, so their JPEG rendition
 * (`variants[0]`) stands in. Dropbox and Drive thumbnails are bumped to
 * their largest rendition so a 256px rail thumb never becomes the card.
 */
export const ogBaseImageUrl = (item: GalleryMediaItem | undefined): string | null => {
  if (!item) return null
  if (isVideoItem(item)) return item.poster.src
  const isHeic = /\.hei[cf]$/i.test(item.filename)
  const source = isHeic ? item.variants?.[0]?.src ?? item.src : item.src
  if (!source) return null
  if (source.startsWith('/api/dropbox/thumbnail')) return source.replace(/([?&])size=[^&]*/, '$1size=w2048h2048')
  if (source.startsWith('/api/drive/thumbnail')) return source.replace(/([?&])size=[^&]*/, '$1size=w2048')
  return source
}

/** Resolves a proxy-relative src against the incoming request so the
 *  compositor can fetch it — the proxies are public, exactly like they
 *  are for a crawler loading the gallery page. */
export const absoluteSourceUrl = (source: string, requestUrl: string) =>
  source.startsWith('http') ? source : new URL(source, requestUrl).toString()

type CfImageDraw = { url: string; left?: number; top?: number; width?: number; height?: number }
type CfImageOptions = {
  cf?: {
    image?: {
      width?: number
      height?: number
      fit?: string
      format?: string
      quality?: number
      draw?: CfImageDraw[]
    }
  }
}

/**
 * Builds the card. Returns null when the composite could not be produced
 * — the caller then redirects to the static fallback rather than serving
 * a broken image.
 */
export const renderOgCard = async (
  photoUrl: string,
  pillUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> => {
  const draw: CfImageDraw[] = [{
    url: pillUrl,
    left: PILL_MARGIN,
    top: OG_HEIGHT - PILL_HEIGHT - PILL_MARGIN,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  }]
  const options: CfImageOptions = {
    cf: { image: { width: OG_WIDTH, height: OG_HEIGHT, fit: 'cover', format: 'jpeg', quality: 88, draw } },
  }
  let response: Response
  try {
    response = await fetchImpl(photoUrl, options as RequestInit)
  } catch {
    return null
  }
  if (!response.ok) return null
  // `cf-resized` is only present when the transform actually ran. Without
  // it these are the untransformed original bytes — composite locally.
  if (response.headers.get('cf-resized')) return response
  const original = await response.arrayBuffer().catch(() => null)
  if (!original) return null
  return compositeWithJimp(original, pillUrl, fetchImpl)
}

/** Pure-JS fallback compositor. Kept in its own function so the jimp
 *  import stays lazy — the Cloudflare path never pays for it. */
const compositeWithJimp = async (
  photoBytes: ArrayBuffer,
  pillUrl: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> => {
  try {
    const { Jimp } = await import('jimp')
    let card
    try {
      card = await Jimp.fromBuffer(photoBytes)
    } catch {
      // jimp's codec set stops at jpeg/png/bmp/tiff/gif — webp and HEIC
      // sources need a real decoder first. sharp transcodes to jpeg so the
      // non-cf path matches the transform pipeline's format coverage.
      const sharp = (await import('sharp')).default
      const jpeg = await sharp(Buffer.from(photoBytes)).jpeg({ quality: 92 }).toBuffer()
      card = await Jimp.fromBuffer(jpeg)
    }
    card.cover({ w: OG_WIDTH, h: OG_HEIGHT })
    try {
      const pillResponse = await fetchImpl(pillUrl)
      if (pillResponse.ok) {
        const pill = await Jimp.fromBuffer(await pillResponse.arrayBuffer())
        pill.resize({ w: PILL_WIDTH, h: PILL_HEIGHT })
        card.composite(pill, PILL_MARGIN, OG_HEIGHT - PILL_HEIGHT - PILL_MARGIN)
      }
    } catch {
      // A missing pill degrades to an unbranded card — still better than
      // no card at all.
    }
    const buffer = await card.getBuffer('image/jpeg', { quality: 88 })
    return new Response(buffer as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
  } catch {
    return null
  }
}

/** The complete route body: composite, or a redirect to the static card.
 *  Every failure path lands on the same 302 so a crawler always gets an
 *  image. */
export const ogCardResponse = async (
  item: GalleryMediaItem | undefined,
  requestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
  const fallback = () => Response.redirect(new URL(OG_FALLBACK_PATH, requestUrl).toString(), 302)
  const source = ogBaseImageUrl(item)
  if (!source) return fallback()
  const card = await renderOgCard(
    absoluteSourceUrl(source, requestUrl),
    new URL(OG_PILL_PATH, requestUrl).toString(),
    fetchImpl,
  )
  if (!card) return fallback()
  return new Response(card.body, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
