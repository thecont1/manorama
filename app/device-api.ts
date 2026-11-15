import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { isDeviceId, parseDeviceRegistration } from '../packages/core/devices'
import { forgetDevice, listDevices, registerDevice, type DeviceEnv } from './lib/device-repository'
import { privateNoStore, requireBearerSession, requireSession, type HonoSessionEnv } from './lib/session'

const dbEnv = (c: { env: unknown }) => c.env as DeviceEnv

/**
 * The account's device list. The read is open to any account session so the
 * web Library can always show the owner which devices their Local galleries
 * live on. Writes are device-token only: a browser is never a device, so a
 * web sign-in records nothing — the cookie is refused here by construction.
 */
export const createDeviceApi = () => {
  const api = new Hono<HonoSessionEnv>()

  api.use('/api/devices', privateNoStore)
  api.use('/api/devices/*', privateNoStore)

  api.get('/api/devices', requireSession(), async (c) => {
    const session = c.get('manoramaSession')
    try {
      return c.json({ devices: await listDevices(session.accountId, dbEnv(c)) })
    } catch {
      return c.json({ error: 'The device list is temporarily unavailable' }, 503)
    }
  })

  api.put('/api/devices/:id', requireBearerSession(), bodyLimit({ maxSize: 2048 }), async (c) => {
    const session = c.get('manoramaSession')
    const id = c.req.param('id')
    if (!isDeviceId(id)) return c.json({ error: 'That device is invalid' }, 400)
    const contentType = c.req.header('Content-Type') ?? ''
    if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'Expected an application/json body' }, 415)
    }
    const registration = parseDeviceRegistration(await c.req.json().catch(() => undefined))
    if (!registration) return c.json({ error: 'That device is invalid' }, 400)
    try {
      const result = await registerDevice(session.accountId, id, registration.kind, dbEnv(c))
      if (result.status === 'full') return c.json({ error: 'Forget a device to add another' }, 409)
      if (result.status === 'missing') return c.json({ error: 'That device could not be saved' }, 503)
      return c.json({ device: result.device })
    } catch {
      return c.json({ error: 'That device could not be saved' }, 503)
    }
  })

  /** Forgetting is never gated by a plan: a device the owner removed must be
   *  removable whatever tier the account is on. Idempotent — a device that is
   *  already gone answers 404, which the clients treat as success. */
  api.delete('/api/devices/:id', requireBearerSession(), async (c) => {
    const session = c.get('manoramaSession')
    const id = c.req.param('id')
    if (!isDeviceId(id)) return c.json({ error: 'That device was not found' }, 404)
    try {
      const deleted = await forgetDevice(session.accountId, id, dbEnv(c))
      if (!deleted) return c.json({ error: 'That device was not found' }, 404)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'That device could not be forgotten' }, 503)
    }
  })

  return api
}
