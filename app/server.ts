import { createApp } from 'honox/server'
import { createRequire } from 'node:module'
import { fetchDropboxFile, fetchDropboxThumbnail, scanDropboxFolder } from './lib/dropbox-public'
import { createGallery, deleteGallery, getGallery, listGalleries, toSummary, updateGalleryMetadata, updateGalleryOrder, updateGallerySlug } from './lib/gallery-repository'

type RequestBody = { url?: string; order?: string[] }

type RuntimeEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  VENDO_API_KEY?: string
  VENDO_CONSOLE_URL?: string
  VENDO_BASE_URL?: string
  VENDO_SERVICE_KEY?: string
}

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv

const slugify = (value: string) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'gallery'

const streamResponse = (response: Response, cacheControl: string) => {
  const headers = new Headers()
  headers.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(response.body, { status: 200, headers })
}

// Load the Vendo CJS handler at module scope. This is fine in the dev-server
// (Node) and in a Cloudflare Workers build the vendo/ route would be handled
// by a separate module if necessary.
const vendoRequire = createRequire(import.meta.url)
const { handleVendoRequest } = vendoRequire('../vendo/handler.cjs')

const init = (app: ReturnType<typeof createApp>) => {
  app.get('/api/galleries', async (c) => {
    try {
      const galleries = await listGalleries(envOf(c))
      return c.json({ galleries: galleries.map(toSummary) })
    } catch {
      return c.json({ error: 'The gallery list is temporarily unavailable' }, 503)
    }
  })

  app.post('/api/galleries/scan', async (c) => {
    const payload = await c.req.json<RequestBody>().catch((): RequestBody => ({}))
    if (!payload.url?.trim()) return c.json({ error: 'Paste a public Dropbox folder URL' }, 400)
    try {
      const scan = await scanDropboxFolder(payload.url, envOf(c))
      return c.json({ scan })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That Dropbox folder could not be scanned' }, 422)
    }
  })

  app.post('/api/galleries', async (c) => {
    const payload = await c.req.json<RequestBody>().catch((): RequestBody => ({}))
    if (!payload.url?.trim()) return c.json({ error: 'Paste a public Dropbox folder URL' }, 400)
    try {
      const scan = await scanDropboxFolder(payload.url, envOf(c))
      const existing = (await listGalleries(envOf(c))).find((item) => item.sourceUrl === scan.sourceUrl || item.slug === slugify(scan.title))
      const baseSlug = existing?.slug || slugify(scan.title)
      let slug = baseSlug
      let suffix = 2
      while (!existing && await listGalleries(envOf(c)).then((items) => items.some((item) => item.slug === slug))) {
        slug = `${baseSlug}-${suffix}`
        suffix += 1
      }
      const orderedImages = payload.order?.length
        ? payload.order.flatMap((filename) => scan.images.filter((image) => image.filename === filename)).concat(scan.images.filter((image) => !payload.order?.includes(image.filename)))
        : scan.images
      const gallery = await createGallery({
        slug,
        title: scan.title,
        caption: '',
        date: '',
        sourceUrl: scan.sourceUrl,
        createdAt: new Date().toISOString(),
        images: orderedImages,
      }, envOf(c))
      return c.json({ gallery: toSummary(gallery) }, 201)
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be added' }, 422)
    }
  })

  app.patch('/api/galleries/:slug', async (c) => {
    const payload = await c.req.json<{ title?: string; caption?: string; order?: string[]; slug?: string }>().catch((): { title?: string; caption?: string; order?: string[]; slug?: string } => ({}))
    const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : undefined
    const caption = typeof payload.caption === 'string' ? payload.caption.trim().slice(0, 500) : undefined
    const order = Array.isArray(payload.order) ? payload.order.filter((item): item is string => typeof item === 'string').slice(0, 500) : undefined
    const nextSlug = typeof payload.slug === 'string' ? payload.slug.trim().toLowerCase() : undefined
    if (title !== undefined && !title) return c.json({ error: 'A gallery title cannot be empty' }, 400)
    if (nextSlug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nextSlug)) return c.json({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' }, 400)
    if (title === undefined && caption === undefined && !order && nextSlug === undefined) return c.json({ error: 'Provide a gallery URL, metadata, or an image order to update' }, 400)
    try {
      let gallery = nextSlug !== undefined ? await updateGallerySlug(c.req.param('slug'), nextSlug, envOf(c)) : order ? await updateGalleryOrder(c.req.param('slug'), order, envOf(c)) : await getGallery(c.req.param('slug'), envOf(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (title !== undefined || caption !== undefined) gallery = await updateGalleryMetadata(gallery.slug, { title, caption }, envOf(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      return c.json({ gallery: toSummary(gallery) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be updated' }, 422)
    }
  })

  app.delete('/api/galleries/:slug', async (c) => {
    try {
      const deleted = await deleteGallery(c.req.param('slug'), envOf(c))
      if (!deleted) return c.json({ error: 'That gallery cannot be deleted' }, 404)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'That gallery could not be deleted' }, 503)
    }
  })

  app.post('/api/galleries/:slug/refresh', async (c) => {
    try {
      const gallery = await getGallery(c.req.param('slug'), envOf(c))
      if (!gallery) return c.json({ error: 'That gallery was not found' }, 404)
      if (!gallery.sourceUrl) return c.json({ error: 'Only Dropbox-sourced galleries can be refreshed' }, 400)
      const scan = await scanDropboxFolder(gallery.sourceUrl, envOf(c))
      const byFilename = new Map(gallery.images.map((image) => [image.filename, image]))
      const refreshed = scan.images.map((image) => byFilename.get(image.filename) ?? image)
      const updated = await createGallery({ ...gallery, images: refreshed }, envOf(c))
      return c.json({ gallery: toSummary(updated) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'That gallery could not be refreshed' }, 422)
    }
  })

  app.get('/api/dropbox/thumbnail', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxThumbnail(sourceUrl, filename, envOf(c)), 'private, max-age=300')
    } catch {
      return c.json({ error: 'That Dropbox thumbnail is unavailable' }, 404)
    }
  })

  app.get('/api/dropbox/file', async (c) => {
    const sourceUrl = c.req.query('sourceUrl')
    const filename = c.req.query('filename')
    if (!sourceUrl || !filename) return c.json({ error: 'Missing Dropbox image reference' }, 400)
    try {
      return streamResponse(await fetchDropboxFile(sourceUrl, filename, envOf(c)), 'private, no-store')
    } catch {
      return c.json({ error: 'That Dropbox image is unavailable' }, 404)
    }
  })

  // Route Vendo API requests to the Vendo server.
  // Uses createRequire to load the CJS handler, bypassing Vite's ESM
  // module runner which can't handle CJS-heavy deps (@vercel/oidc, pg,
  // yaml, ajv, @modelcontextprotocol/sdk).
  app.all('/api/vendo/*', async (c) => {
    const response = await handleVendoRequest(c.req.raw, envOf(c))
    return response
  })

  app.use('*', async (c, next) => {
    await next()
    // Only add the X-Robots-Tag header to HTML responses. Static assets
    // (fonts, modules, JSON) are served by the dev server and must not have
    // their content-type or content-length altered.
    const ct = c.res.headers.get('content-type')
    if (ct && ct.includes('text/html')) {
      c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    }
  })
}

const app = createApp({ init })

export default app
