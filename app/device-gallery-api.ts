import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { DEVICE_GALLERY_ID_PATTERN, parseDeviceGalleryInput } from '../packages/core/device-gallery'
import { deleteDeviceGallery, listDeviceGalleries, putDeviceGallery, setDeviceGalleryHidden, type DeviceGalleryEnv } from './lib/device-gallery-repository'
import { getStoredGallery } from './lib/gallery-repository'
import { isGalleryExpired } from './lib/gallery-policy'
import { getUserByAccountId } from './lib/user-repository'
import { accessEnvOf, resolveManoramaSession, type HonoSessionEnv } from './lib/session'

const dbEnv = (c: { env: unknown }) => c.env as DeviceGalleryEnv

const privateNoStore: MiddlewareHandler<HonoSessionEnv> = async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
}

const requireBearerSession = (): MiddlewareHandler<HonoSessionEnv> =>
  async (c, next) => {
    const authorization = c.req.header('Authorization') ?? ''
    if (!/^Bearer[ \t]+\S+$/i.test(authorization)) return c.json({ error: 'Authentication required' }, 401)
    const headers = new Headers(c.req.raw.headers)
    headers.delete('Cookie')
    const session = await resolveManoramaSession(
      new Request(c.req.raw.url, { method: c.req.raw.method, headers }),
      accessEnvOf(c),
    )
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    c.set('manoramaSession', session)
    await next()
  }

export const createDeviceGalleryApi = () => {
  const api = new Hono<HonoSessionEnv>()

  api.use('/api/device-galleries', privateNoStore)
  api.use('/api/device-galleries/*', privateNoStore)
  api.use('/api/device-galleries', requireBearerSession())
  api.use('/api/device-galleries/*', requireBearerSession())

  api.get('/api/device-galleries', async (c) => {
    const session = c.get('manoramaSession')
    try {
      // The listing runs first so a broken database still answers 503; the
      // tier only filters the payload — a Free account's feed is simply
      // empty, the same answer a demotion leaves behind.
      const galleries = await listDeviceGalleries(session.accountId, dbEnv(c))
      const user = await getUserByAccountId(session.accountId, dbEnv(c))
      return c.json({ galleries: user?.tier === 'pro' ? galleries : [] })
    } catch {
      return c.json({ error: 'The device gallery list is temporarily unavailable' }, 503)
    }
  })

  api.put('/api/device-galleries/:id', bodyLimit({ maxSize: 8192 }), async (c) => {
    const session = c.get('manoramaSession')
    // Syncing is a Visionary feature. The gate only applies when the account
    // record could be read — a missing binding falls through to the store,
    // which reports its own 503.
    if (dbEnv(c).DB) {
      let user = null as Awaited<ReturnType<typeof getUserByAccountId>>
      try {
        user = await getUserByAccountId(session.accountId, dbEnv(c))
      } catch {
        return c.json({ error: 'The device gallery list is temporarily unavailable' }, 503)
      }
      if (user?.tier !== 'pro') return c.json({ error: 'Local galleries are included with Visionary' }, 403)
    }
    const id = c.req.param('id')
    if (!DEVICE_GALLERY_ID_PATTERN.test(id)) return c.json({ error: 'That device gallery is invalid' }, 400)
    const contentType = c.req.header('Content-Type') ?? ''
    if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'Expected an application/json body' }, 415)
    }
    const input = parseDeviceGalleryInput(await c.req.json().catch(() => undefined))
    if (!input) return c.json({ error: 'That device gallery is invalid' }, 400)
    if (input.publicGallerySlug !== undefined) {
      let linked = null as Awaited<ReturnType<typeof getStoredGallery>>
      try {
        linked = await getStoredGallery(session.accountId, input.publicGallerySlug, dbEnv(c))
      } catch {
        return c.json({ error: 'The device gallery list is temporarily unavailable' }, 503)
      }
      if (!linked || isGalleryExpired(linked)) return c.json({ error: 'That device gallery is invalid' }, 400)
    }
    try {
      const gallery = await putDeviceGallery(session.accountId, id, input, dbEnv(c))
      return c.json({ gallery })
    } catch {
      return c.json({ error: 'That device gallery could not be saved' }, 503)
    }
  })

  /** The hide toggle any device on the account can send — the flag lives on
   *  the row, so hiding a mirror propagates to every device that lists it.
   *  Open to Free accounts for the same reason DELETE is: cleanup must never
   *  be gated by a plan that already left. */
  api.patch('/api/device-galleries/:id', bodyLimit({ maxSize: 2048 }), async (c) => {
    const session = c.get('manoramaSession')
    const id = c.req.param('id')
    if (!DEVICE_GALLERY_ID_PATTERN.test(id)) return c.json({ error: 'That device gallery was not found' }, 404)
    const payload = await c.req.json<{ hidden?: boolean }>().catch((): { hidden?: boolean } => ({}))
    if (typeof payload.hidden !== 'boolean') return c.json({ error: 'Provide a hidden state to update' }, 400)
    try {
      const updated = await setDeviceGalleryHidden(session.accountId, id, payload.hidden, dbEnv(c))
      if (!updated) return c.json({ error: 'That device gallery was not found' }, 404)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'That device gallery could not be updated' }, 503)
    }
  })

  api.delete('/api/device-galleries/:id', async (c) => {
    const session = c.get('manoramaSession')
    const id = c.req.param('id')
    if (!DEVICE_GALLERY_ID_PATTERN.test(id)) return c.json({ error: 'That device gallery was not found' }, 404)
    try {
      const deleted = await deleteDeviceGallery(session.accountId, id, dbEnv(c))
      if (!deleted) return c.json({ error: 'That device gallery was not found' }, 404)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'That device gallery could not be deleted' }, 503)
    }
  })

  return api
}
