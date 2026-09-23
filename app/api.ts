import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { SourceFetchError, isVideoItem, stillSourceOf, type GalleryMediaItem } from './lib/imagesource'
import { fetchDropboxFile, fetchDropboxThumbnail } from './lib/dropbox-public'
import { fetchDriveFile, fetchDriveThumbnail } from './lib/gdrive-public'
import { fetchICloudImage, fetchICloudVideo } from './lib/icloud-shared'
import { fetchMegaFile, fetchMegaPreview } from './lib/mega-public'
import { canonicalSourceMatches, scanSource, UNRECOGNIZED_LINK_MESSAGE } from './lib/sources'
import { localSourcesEnabled, serveLocalMedia } from './lib/local-source'
import { createGalleryWithinLimit, deleteGallery, getGallery, getStoredGallery, listGalleries, toSummary, updateGalleryImages, updateGalleryMetadata, updateGalleryOrder, updateGallerySlug, type GalleryEnv } from './lib/gallery-repository'
import { assertGalleryEditable, GalleryPolicyError, isGalleryExpired, paidGalleryLimitError } from './lib/gallery-policy'
import { requireSession, type HonoSessionEnv } from './lib/dropbox-session'
import { OwnerSlugError, updateOwnerSlug, getUserByOwnerSlug } from './lib/user-repository'
import { ogCardResponse, ogItemKey } from './lib/og-card'
import { randomGalleryName } from './lib/gallery-name'
import { defaultGallerySettings } from './lib/gallery-settings'

type RequestBody = { url?: string; order?: string[]; quick?: boolean }

export type RuntimeEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  GOOGLE_DRIVE_API_KEY?: string
  VENDO_API_KEY?: string
  VENDO_CONSOLE_URL?: string
  VENDO_BASE_URL?: string
  VENDO_SERVICE_KEY?: string
  VENDO_MCP_BROKER_URL?: string
  VENDO_MCP_FEDERATION_SECRET?: string
  HOST_API_JWT_SECRET?: string
  REVENUECAT_WEBHOOK_AUTH?: string
  REVENUECAT_WEBHOOK_SIGNING_SECRET?: string
}

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv

/** The public address of a gallery. Quick-add redirects the visitor here
 *  the moment a create succeeds (or is found to already exist). */
const galleryUrlFor = (ownerSlug: string, slug: string) => `/${ownerSlug}/${slug}`
const dbEnv = (c: { env: unknown }) => c.env as GalleryEnv

const slugify = (value: string) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'gallery'

/** Rejects editorial requests for pipeline galleries before their handlers
 *  run. Missing galleries continue to the handler so it can return 404. */
const requireEditableGallery = (): MiddlewareHandler<HonoSessionEnv> =>
  async (c, next) => {
    const session = c.get('manoramaSession')
    try {
      const gallery = await getStoredGallery(session.dropboxAccountId, c.req.param('slug') ?? '', dbEnv(c))
      // Expired pipeline rows linger until the daily sweep; logically they
      // are already gone, so they miss with 404 rather than READ_ONLY.
      if (gallery && isGalleryExpired(gallery)) return c.json({ error: 'That gallery was not found' }, 404)
      if (gallery) assertGalleryEditable(gallery)
    } catch (error) {
      if (error instanceof GalleryPolicyError) return c.json({ code: error.code, error: error.message }, 403)
      return c.json({ error: 'That gallery is temporarily unavailable' }, 503)
    }
    await next()
  }

/** Typographic quotes on save: straight quotes typed into the editor come
 *  out curly. Other special characters already pass through untouched. */
const smartQuotes = (text: string) =>
  text
    .replace(/(^|[\s([{<])'/g, '$1\u2018')
    .replace(/'/g, '\u2019')
    .replace(/(^|[\s([{<])"/g, '$1\u201C')
    .replace(/"/g, '\u201D')

/** Maps a provider fetch failure to a proxy response: 404 only for a
 *  confirmed missing asset, 503 for missing configuration and retryable
 *  or upstream 5xx failures, otherwise the upstream status is retained. */
const proxyFailure = (c: Context, provider: string, reference: string, error: unknown) => {
  const status = error instanceof SourceFetchError ? error.status : undefined
  console.error('image proxy failure', { provider, reference, status: status ?? null, error })
  if (status === 404) return c.json({ error: `That ${provider} is unavailable` }, 404)
  if (status === undefined || status === 429 || status >= 500) return c.json({ error: `That ${provider} is temporarily unavailable` }, 503)
  return c.json({ error: `That ${provider} is unavailable` }, status as 400)
}

/** Magic-byte image sniffing for proxy responses. Byte 4 'ftyp' covers
 *  the ISO-BMFF family (avif/avis/heic/heix/mif1/msf1 brands). */
const sniffImageType = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
  }
  return null
}

const streamResponse = async (response: Response, cacheControl: string) => {
  const headers = new Headers()
  let body: ReadableStream | null = response.body
  let contentType = response.headers.get('Content-Type')
  // Provider content endpoints label image bytes application/octet-stream
  // (Dropbox shared-link files always do, decrypted MEGA originals carry
  // none). Sniff the first chunk so consumers that dispatch on the type —
  // the in-browser C2PA reader, save-as — see the real format. The chunk is
  // re-emitted ahead of the remaining stream; no tee, so no copy buffers.
  if ((!contentType || contentType === 'application/octet-stream') && body) {
    const reader = body.getReader()
    const { value: first, done } = await reader.read()
    contentType = (first && sniffImageType(first)) ?? 'application/octet-stream'
    body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (first) controller.enqueue(first)
          while (!done) {
            const { value, done: finished } = await reader.read()
            if (finished) break
            controller.enqueue(value)
          }
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          reader.releaseLock()
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
  }
  headers.set('Content-Type', contentType || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(body, { status: 200, headers })
}

/** Streams a media response preserving range semantics: a 206 keeps its
 *  status, Content-Range and Content-Length so the browser's media stack
 *  can seek, and Accept-Ranges advertises the capability on full
 *  responses too. Used by the video proxy; images stay on the simpler
 *  always-200 path above. */
const streamRangeResponse = (response: Response, cacheControl: string) => {
  const headers = new Headers()
  headers.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Accept-Ranges', response.headers.get('Accept-Ranges') || 'bytes')
  const contentRange = response.headers.get('Content-Range')
  if (contentRange) headers.set('Content-Range', contentRange)
  const contentLength = response.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)
  const status = response.status === 206 ? 206 : 200
  return new Response(response.body, { status, headers })
}

/**
 * The gallery management API as one route group. Every /api/galleries and
 * /api/account operation is gated by the Dropbox session at the group
 * boundary; each handler scopes its reads and writes to the signed-in
 * owner. The Dropbox image proxy stays public because public gallery
 * pages load their images through it.
 */
export const createManoramaApi = () => {
  const api = new Hono<HonoSessionEnv>()

  api.use('/api/*', async (c, next) => {
    const origin = c.req.header('Origin')
    let allowed = false
    if (origin === 'capacitor://localhost') allowed = true
    if (origin) {
      try {
        const url = new URL(origin)
        allowed ||= url.protocol === 'http:' && url.hostname === 'localhost'
      } catch {
        allowed = false
      }
    }
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin!)
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      c.header('Vary', 'Origin')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })
  api.get('/api/gallery/:owner/:slug', async (c) => {
    const user = await getUserByOwnerSlug(c.req.param('owner'), dbEnv(c))
    if (!user) return c.json({ error: 'That gallery was not found' }, 404)
    const gallery = await getGallery(user.dropboxAccountId, c.req.param('slug'), dbEnv(c))
    if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
    const manifest = { slug: gallery.slug, title: gallery.title, caption: gallery.caption, date: gallery.date, images: gallery.images }
    return c.json({ manifest, settings: defaultGallerySettings(gallery) })
  })
  api.use('/api/galleries', requireSession())
  api.use('/api/galleries/*', requireSession())
  api.use('/api/account', requireSession())
  api.use('/api/account/*', requireSession())

  api.get('/api/galleries', async (c) => {
    const session = c.get('manoramaSession')
    try {
      const galleries = await listGalleries(session.dropboxAccountId, dbEnv(c))
      return c.json({ galleries: galleries.map(toSummary) })
    } catch {
      return c.json({ error: 'The gallery list is temporarily unavailable' }, 503)
    }
  })

  api.post('/api/galleries/scan', async (c) => {
    const payload = await c.req.json<RequestBody>().catch((): RequestBody => ({}))
    if (!payload.url?.trim()) return c.json({ error: UNRECOGNIZED_LINK_MESSAGE }, 400)
    try {
      const scan = await scanSource(payload.url, envOf(c))
      return c.json({ scan })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That link could not be scanned' }, 422)
    }
  })

  api.post('/api/galleries', async (c) => {
    const session = c.get('manoramaSession')
    const payload = await c.req.json<RequestBody>().catch((): RequestBody => ({}))
    if (!payload.url?.trim()) return c.json({ error: UNRECOGNIZED_LINK_MESSAGE }, 400)
    try {
      // Quick-add revisit fast path: when the pasted link canonicalizes to
      // a gallery this owner already has, reopen it WITHOUT re-scanning
      // the provider. Without this a revisit pays a full album scan just
      // to be told 409 — and a provider hiccup would turn a known-good
      // link into a 422 instead of a redirect.
      const existingBefore = (await listGalleries(session.dropboxAccountId, dbEnv(c)))
        .find((item) => item.sourceUrl && canonicalSourceMatches(item.sourceUrl, payload.url!))
      if (existingBefore) return c.json({
        error: 'A gallery from that link already exists',
        gallery: toSummary(existingBefore),
        galleryUrl: galleryUrlFor(session.ownerSlug, existingBefore.slug),
      }, 409)
      const scan = await scanSource(payload.url, envOf(c))
      const galleries = await listGalleries(session.dropboxAccountId, dbEnv(c))
      const sourceUrlMatch = galleries.find((item) => item.sourceUrl === scan.sourceUrl)
      // A revisit to /<share-url> must reopen the gallery that link already
      // produced, so the 409 carries the existing gallery and its address.
      if (sourceUrlMatch) return c.json({
        error: 'A gallery from that link already exists',
        gallery: toSummary(sourceUrlMatch),
        galleryUrl: galleryUrlFor(session.ownerSlug, sourceUrlMatch.slug),
      }, 409)
      const orderedImages = payload.order?.length
        ? (() => {
            const seen = new Set<string>()
            const uniqueOrder: string[] = []
            for (const key of payload.order!) {
              if (!seen.has(key)) { seen.add(key); uniqueOrder.push(key) }
            }
            return uniqueOrder.flatMap((key) => scan.images.filter((image) => (image.ref ?? image.filename) === key))
              .concat(scan.images.filter((image) => !seen.has(image.ref ?? image.filename)))
          })()
        : scan.images
      // Quick-add (the manorama.xyz/<share-url> shortcut) names the
      // gallery itself: three random hyphenated words, which also makes
      // the slug read like the title. Dashboard creates keep the scanned
      // folder name — the owner chose it on the provider side.
      const title = payload.quick ? randomGalleryName() : smartQuotes(scan.title)
      const baseSlug = slugify(title)
      let slug = baseSlug
      let suffix = 2
      while (galleries.some((item) => item.slug === slug)) {
        slug = `${baseSlug}-${suffix}`
        suffix += 1
      }
      // Best-effort fast reject at the limit; the atomic check below is
      // the real guard against concurrent requests.
      // Atomic limit check + insert: concurrent requests cannot both
      // pass the count and exceed the limit. Retry on slug conflict
      // (a concurrent create may have grabbed the same slug).
      for (let attempt = 0; ; attempt++) {
        const result = await createGalleryWithinLimit(session.dropboxAccountId, {
          slug,
          title,
          caption: '',
          date: '',
          sourceUrl: scan.sourceUrl,
          createdAt: new Date().toISOString(),
          images: orderedImages,
        }, dbEnv(c))
        if (result.ok) return c.json({
          gallery: toSummary(result.gallery),
          galleryUrl: galleryUrlFor(session.ownerSlug, result.gallery.slug),
          // Set when the source album held more than the gallery cap —
          // quick-add shows the note before redirecting so truncation is
          // never silent.
          ...(scan.truncated ? { truncated: { kept: orderedImages.length, total: scan.truncated } } : {}),
        }, 201)
        if (result.reason === 'limit') {
          const error = paidGalleryLimitError()
          return c.json({ code: error.code, error: error.message, dashboardUrl: `/${session.ownerSlug}` }, 403)
        }
        if (result.reason === 'duplicate-source') {
          // Lost the race to a concurrent create of the same link — resolve
          // the winner so this caller still gets somewhere to go.
          const existing = (await listGalleries(session.dropboxAccountId, dbEnv(c))).find((item) => item.sourceUrl === scan.sourceUrl)
          return c.json({
            error: 'A gallery from that link already exists',
            ...(existing ? { gallery: toSummary(existing), galleryUrl: galleryUrlFor(session.ownerSlug, existing.slug) } : {}),
          }, 409)
        }
        if (attempt > 50) return c.json({ error: 'That gallery could not be added' }, 422)
        slug = `${baseSlug}-${suffix}`
        suffix += 1
      }
    } catch (error) {
      if (error instanceof GalleryPolicyError) return c.json({ code: error.code, error: error.message }, 403)
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be added' }, 422)
    }
  })

  api.patch('/api/galleries/:slug', requireEditableGallery(), async (c) => {
    const session = c.get('manoramaSession')
    // Body `slug` is intentionally not read: the URL slug is the resource
    // identity; a rename arrives only as `newSlug`.
    const payload = await c.req.json<{ title?: string; caption?: string; order?: string[]; newSlug?: string }>().catch((): { title?: string; caption?: string; order?: string[]; newSlug?: string } => ({}))
    const title = typeof payload.title === 'string' ? smartQuotes(payload.title.trim().slice(0, 120)) : undefined
    const caption = typeof payload.caption === 'string' ? smartQuotes(payload.caption.trim().slice(0, 500)) : undefined
    const order = Array.isArray(payload.order) ? payload.order.filter((item): item is string => typeof item === 'string').slice(0, 500) : undefined
    const nextSlug = typeof payload.newSlug === 'string' ? payload.newSlug.trim().toLowerCase() : undefined
    if (title !== undefined && !title) return c.json({ error: 'A gallery title cannot be empty' }, 400)
    if (nextSlug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nextSlug)) return c.json({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' }, 400)
    if (title === undefined && caption === undefined && !order && nextSlug === undefined) return c.json({ error: 'Provide a gallery URL, metadata, or an image order to update' }, 400)
    try {
      let gallery = nextSlug !== undefined ? await updateGallerySlug(session.dropboxAccountId, c.req.param('slug'), nextSlug, dbEnv(c)) : await getGallery(session.dropboxAccountId, c.req.param('slug'), dbEnv(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (order) gallery = await updateGalleryOrder(session.dropboxAccountId, gallery.slug, order, dbEnv(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (title !== undefined || caption !== undefined) gallery = await updateGalleryMetadata(session.dropboxAccountId, gallery.slug, { title, caption }, dbEnv(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      return c.json({ gallery: toSummary(gallery) })
    } catch (error) {
      if (error instanceof GalleryPolicyError) return c.json({ code: error.code, error: error.message }, 403)
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be updated' }, 422)
    }
  })

  api.delete('/api/galleries/:slug', async (c) => {
    const session = c.get('manoramaSession')
    try {
      const deleted = await deleteGallery(session.dropboxAccountId, c.req.param('slug'), dbEnv(c))
      if (!deleted) return c.json({ error: 'That gallery cannot be deleted' }, 404)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'That gallery could not be deleted' }, 503)
    }
  })

  api.post('/api/galleries/:slug/refresh', requireEditableGallery(), async (c) => {
    const session = c.get('manoramaSession')
    try {
      const gallery = await getGallery(session.dropboxAccountId, c.req.param('slug'), dbEnv(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (!gallery.sourceUrl) return c.json({ error: 'Only link-sourced galleries can be refreshed' }, 400)
      const scan = await scanSource(gallery.sourceUrl, envOf(c))
      // Retained images keep the owner's ordering but pick up fresh
      // scanner metadata and source references; images removed from the
      // source drop out, newly discovered ones append at the end.
      const scanByKey = new Map(scan.images.map((image) => [image.ref ?? image.filename, image]))
      const keptKeys = new Set(gallery.images.map((image) => image.ref ?? image.filename))
      const retained = gallery.images.flatMap((image) => {
        const fresh = scanByKey.get(image.ref ?? image.filename)
        return fresh ? [fresh] : []
      })
      const refreshed = retained.concat(scan.images.filter((image) => !keptKeys.has(image.ref ?? image.filename)))
      // Persist only the refreshed images, not the stale gallery metadata
      // read before the scan — a concurrent metadata change is preserved.
      const updated = await updateGalleryImages(session.dropboxAccountId, gallery.slug, refreshed, dbEnv(c))
      if (!updated) return c.json({ error: 'That gallery was not found' }, 404)
      return c.json({ gallery: toSummary(updated) })
    } catch (error) {
      if (error instanceof GalleryPolicyError) return c.json({ code: error.code, error: error.message }, 403)
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be refreshed' }, 422)
    }
  })

  /** Changes the signed-in owner's URL segment. Galleries follow the
   * account, so every public gallery address updates with it. */
  api.patch('/api/account', async (c) => {
    const session = c.get('manoramaSession')
    const payload = await c.req.json<{ ownerSlug?: string }>().catch((): { ownerSlug?: string } => ({}))
    if (typeof payload.ownerSlug !== 'string') return c.json({ error: 'Provide a new URL' }, 400)
    try {
      const user = await updateOwnerSlug(session.dropboxAccountId, payload.ownerSlug, dbEnv(c))
      return c.json({ ownerSlug: user.ownerSlug })
    } catch (error) {
      if (error instanceof OwnerSlugError) return c.json({ error: error.message }, 422)
      return c.json({ error: 'That URL could not be changed' }, 503)
    }
  })

  // Public image proxies: public gallery pages load source images through
  // these routes, so they are intentionally NOT behind the session.
  api.get('/api/dropbox/thumbnail', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    const sizeParam = c.req.query('size')
    const size = sizeParam === 'w2048h2048' || sizeParam === 'w1024h768' ? sizeParam : 'w256h256' as const
    // Dropbox offers HEIC renditions only up to w1024h768; clamp so stored
    // galleries with w2048h2048 preview URLs keep working.
    const effectiveSize = filename && /\.hei[cf]$/i.test(filename) && size === 'w2048h2048' ? 'w1024h768' as const : size
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxThumbnail(sourceUrl, filename, envOf(c), effectiveSize), 'private, max-age=300')
    } catch (error) {
      return proxyFailure(c, 'Dropbox thumbnail', `${filename} in ${sourceUrl}`, error)
    }
  })

  api.get('/api/dropbox/file', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxFile(sourceUrl, filename, envOf(c)), 'private, no-store')
    } catch (error) {
      return proxyFailure(c, 'Dropbox image', `${filename} in ${sourceUrl}`, error)
    }
  })

  api.get('/api/drive/thumbnail', async (c) => {
    const id = c.req.query('id')
    const resourceKey = c.req.query('rk')
    const size = c.req.query('size') === 'w2048' ? 'w2048' as const : 'w256' as const
    if (!id) return c.json({ error: 'Missing Google Drive image reference' }, 400)
    try {
      return streamResponse(await fetchDriveThumbnail(id, envOf(c), size, fetch, resourceKey), 'private, max-age=300')
    } catch (error) {
      return proxyFailure(c, 'Google Drive thumbnail', id, error)
    }
  })

  api.get('/api/drive/file', async (c) => {
    const id = c.req.query('id')
    const resourceKey = c.req.query('rk')
    if (!id) return c.json({ error: 'Missing Google Drive image reference' }, 400)
    try {
      return streamResponse(await fetchDriveFile(id, envOf(c), fetch, resourceKey), 'private, no-store')
    } catch (error) {
      return proxyFailure(c, 'Google Drive image', id, error)
    }
  })

  api.get('/api/mega/file', async (c) => {
    const folder = c.req.query('folder')
    const set = c.req.query('set')
    const node = c.req.query('node')
    const key = c.req.query('k')
    if ((!folder && !set) || !node || !key) return c.json({ error: 'Missing MEGA image reference' }, 400)
    try {
      return streamResponse(await fetchMegaFile(folder, set, node, key), 'private, max-age=300')
    } catch (error) {
      return proxyFailure(c, 'MEGA image', `${node} in ${folder ?? set}`, error)
    }
  })

  api.get('/api/mega/preview', async (c) => {
    const folder = c.req.query('folder')
    const set = c.req.query('set')
    const fah = c.req.query('h')
    const key = c.req.query('k')
    if ((!folder && !set) || !fah || !key) return c.json({ error: 'Missing MEGA image reference' }, 400)
    try {
      return streamResponse(await fetchMegaPreview(folder, set, fah, key), 'private, max-age=300')
    } catch (error) {
      return proxyFailure(c, 'MEGA preview', `${fah} in ${folder ?? set}`, error)
    }
  })

  api.get('/api/icloud/image', async (c) => {
    const album = c.req.query('album')
    const photo = c.req.query('photo')
    const checksum = c.req.query('c')
    if (!album || !photo || !checksum) return c.json({ error: 'Missing iCloud image reference' }, 400)
    try {
      return streamResponse(await fetchICloudImage(album, photo, checksum), 'private, max-age=300')
    } catch (error) {
      return proxyFailure(c, 'iCloud image', `${photo} in ${album}`, error)
    }
  })

  /** Video derivatives, Range-forwarded so seeking costs a slice rather
   *  than the whole clip. Public like the image proxies — a gallery page
   *  is public, and the derivative URL is as sensitive as the album link
   *  itself. Never cached: asset URLs expire. */
  api.get('/api/icloud/video', async (c) => {
    const album = c.req.query('album')
    const photo = c.req.query('photo')
    const checksum = c.req.query('c')
    if (!album || !photo || !checksum) return c.json({ error: 'Missing iCloud video reference' }, 400)
    try {
      const range = c.req.header('Range')
      return streamRangeResponse(await fetchICloudVideo(album, photo, checksum, range), 'private, no-store')
    } catch (error) {
      return proxyFailure(c, 'iCloud video', `${photo} in ${album}`, error)
    }
  })

  /**
   * Dev-only local-folder media. Registered unconditionally so the route
   * table is identical across environments; the flag check inside makes it
   * a 404 outside `bun run dev`, and serveLocalMedia confines reads to
   * directories scanned this session anyway.
   */
  api.get('/api/local/file', async (c) => {
    if (!localSourcesEnabled()) return c.json({ error: 'That file is unavailable' }, 404)
    return serveLocalMedia(new URL(c.req.url), c.req.header('Range') ?? null)
  })

  /**
   * Per-gallery Open Graph card. Public by necessity: crawlers carry no
   * cookies, exactly like the image proxies above. `?i=` is the first
   * item's key — it participates in the cache key only, so a reorder
   * busts the edge cache without a purge.
   *
   * Every failure — unknown owner, missing gallery, empty gallery, a
   * compositor fault — redirects to the static card so a crawler is
   * never handed an error page where an image belongs.
   */
  api.get('/api/og/:owner/:slug', async (c) => {
    const fallback = () => c.redirect(new URL('/og-image.png', c.req.url).toString(), 302)
    const noStore = (response: Response) => {
      const res = new Response(response.body, response)
      res.headers.set('Cache-Control', 'no-store')
      return res
    }
    try {
      const user = await getUserByOwnerSlug(c.req.param('owner'), dbEnv(c))
      if (!user) return noStore(fallback())
      const gallery = await getGallery(user.dropboxAccountId, c.req.param('slug'), dbEnv(c))
      const first = gallery?.images?.[0] as GalleryMediaItem | undefined
      const pipeline = gallery?.retention === 'pipeline'
      if (!first) return noStore(fallback())
      const response = await ogCardResponse(first, c.req.url)
      if (!pipeline) return response
      return noStore(response)
    } catch (error) {
      console.error('og card failure', { path: c.req.path, error })
      return noStore(fallback())
    }
  })

  return api
}
