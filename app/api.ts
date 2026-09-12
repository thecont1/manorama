import { Hono } from 'hono'
import { fetchDropboxFile, fetchDropboxThumbnail, scanDropboxFolder } from './lib/dropbox-public'
import { createGalleryWithinLimit, deleteGallery, getGallery, listGalleries, toSummary, updateGalleryImages, updateGalleryMetadata, updateGalleryOrder, updateGallerySlug, countGalleries, type GalleryEnv } from './lib/gallery-repository'
import { requireSession, type HonoSessionEnv } from './lib/dropbox-session'
import { OwnerSlugError, updateOwnerSlug } from './lib/user-repository'

type RequestBody = { url?: string; order?: string[] }

export type RuntimeEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  VENDO_API_KEY?: string
  VENDO_CONSOLE_URL?: string
  VENDO_BASE_URL?: string
  VENDO_SERVICE_KEY?: string
  VENDO_MCP_BROKER_URL?: string
  VENDO_MCP_FEDERATION_SECRET?: string
  HOST_API_JWT_SECRET?: string
}

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv
const dbEnv = (c: { env: unknown }) => c.env as GalleryEnv

const slugify = (value: string) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'gallery'

/** Free tier caps at 3 galleries; pro is unlimited. The check is one seam. */
const FREE_GALLERY_LIMIT = 3
const galleryLimit = (tier: 'free' | 'pro') => tier === 'pro' ? Number.MAX_SAFE_INTEGER : FREE_GALLERY_LIMIT
const limitMessage = `You're using all ${FREE_GALLERY_LIMIT} of your galleries. Remove one to add another — or write to us about keeping more.`

/** Typographic quotes on save: straight quotes typed into the editor come
 *  out curly. Other special characters already pass through untouched. */
const smartQuotes = (text: string) =>
  text
    .replace(/(^|[\s([{<])'/g, '$1\u2018')
    .replace(/'/g, '\u2019')
    .replace(/(^|[\s([{<])"/g, '$1\u201C')
    .replace(/"/g, '\u201D')

const streamResponse = (response: Response, cacheControl: string) => {
  const headers = new Headers()
  headers.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(response.body, { status: 200, headers })
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
    if (!payload.url?.trim()) return c.json({ error: 'Paste a public Dropbox folder URL' }, 400)
    try {
      const scan = await scanDropboxFolder(payload.url, envOf(c))
      return c.json({ scan })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That Dropbox folder could not be scanned' }, 422)
    }
  })

  api.post('/api/galleries', async (c) => {
    const session = c.get('manoramaSession')
    const payload = await c.req.json<RequestBody>().catch((): RequestBody => ({}))
    if (!payload.url?.trim()) return c.json({ error: 'Paste a public Dropbox folder URL' }, 400)
    try {
      // Best-effort fast reject at the limit; the atomic check below is
      // the real guard against concurrent requests.
      if (await countGalleries(session.dropboxAccountId, dbEnv(c)) >= galleryLimit(session.tier)) {
        return c.json({ error: limitMessage }, 403)
      }
      const scan = await scanDropboxFolder(payload.url, envOf(c))
      const galleries = await listGalleries(session.dropboxAccountId, dbEnv(c))
      const sourceUrlMatch = galleries.find((item) => item.sourceUrl === scan.sourceUrl)
      if (sourceUrlMatch) return c.json({ error: 'A gallery from that Dropbox folder already exists' }, 409)
      const orderedImages = payload.order?.length
        ? (() => {
            const seen = new Set<string>()
            const uniqueOrder: string[] = []
            for (const filename of payload.order!) {
              if (!seen.has(filename)) { seen.add(filename); uniqueOrder.push(filename) }
            }
            return uniqueOrder.flatMap((filename) => scan.images.filter((image) => image.filename === filename))
              .concat(scan.images.filter((image) => !seen.has(image.filename)))
          })()
        : scan.images
      const baseSlug = slugify(scan.title)
      let slug = baseSlug
      let suffix = 2
      while (galleries.some((item) => item.slug === slug)) {
        slug = `${baseSlug}-${suffix}`
        suffix += 1
      }
      // Atomic limit check + insert: concurrent requests cannot both
      // pass the count and exceed the limit. Retry on slug conflict
      // (a concurrent create may have grabbed the same slug).
      for (let attempt = 0; ; attempt++) {
        const result = await createGalleryWithinLimit(session.dropboxAccountId, {
          slug,
          title: smartQuotes(scan.title),
          caption: '',
          date: '',
          sourceUrl: scan.sourceUrl,
          createdAt: new Date().toISOString(),
          images: orderedImages,
        }, galleryLimit(session.tier), dbEnv(c))
        if (result.ok) return c.json({ gallery: toSummary(result.gallery) }, 201)
        if (result.reason === 'limit') return c.json({ error: limitMessage }, 403)
        if (result.reason === 'duplicate-source') return c.json({ error: 'A gallery from that Dropbox folder already exists' }, 409)
        if (attempt > 50) return c.json({ error: 'That gallery could not be added' }, 422)
        slug = `${baseSlug}-${suffix}`
        suffix += 1
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be added' }, 422)
    }
  })

  api.patch('/api/galleries/:slug', async (c) => {
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

  api.post('/api/galleries/:slug/refresh', async (c) => {
    const session = c.get('manoramaSession')
    try {
      const gallery = await getGallery(session.dropboxAccountId, c.req.param('slug'), dbEnv(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (!gallery.sourceUrl) return c.json({ error: 'Only Dropbox-sourced galleries can be refreshed' }, 400)
      const scan = await scanDropboxFolder(gallery.sourceUrl, envOf(c))
      const byFilename = new Map(gallery.images.map((image) => [image.filename, image]))
      const refreshed = scan.images.map((image) => byFilename.get(image.filename) ?? image)
      // Persist only the refreshed images, not the stale gallery metadata
      // read before the scan — a concurrent metadata change is preserved.
      const updated = await updateGalleryImages(session.dropboxAccountId, gallery.slug, refreshed, dbEnv(c))
      if (!updated) return c.json({ error: 'That gallery was not found' }, 404)
      return c.json({ gallery: toSummary(updated) })
    } catch (error) {
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

  // Public image proxy: public gallery pages load Dropbox-sourced images
  // through these routes, so they are intentionally NOT behind the session.
  api.get('/api/dropbox/thumbnail', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    const size = c.req.query('size') === 'w2048h2048' ? 'w2048h2048' as const : 'w256h256' as const
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxThumbnail(sourceUrl, filename, envOf(c), size), 'private, max-age=300')
    } catch {
      return c.json({ error: 'That Dropbox thumbnail is unavailable' }, 404)
    }
  })

  api.get('/api/dropbox/file', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxFile(sourceUrl, filename, envOf(c)), 'private, no-store')
    } catch {
      return c.json({ error: 'That Dropbox image is unavailable' }, 404)
    }
  })

  return api
}
