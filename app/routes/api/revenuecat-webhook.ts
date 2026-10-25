import { createRoute } from 'honox/factory'
import { bodyLimit } from 'hono/body-limit'
import { processRevenueCatWebhook, type RevenueCatWebhookEnv } from '../../lib/revenuecat-webhook'

const handleWebhook = async (c: Parameters<ReturnType<typeof createRoute>[number]>[0]) => {
  const result = await processRevenueCatWebhook(c.req.raw, c.env as RevenueCatWebhookEnv)
  if (result.status === 200) {
    return c.json({ ok: true, code: result.code, eventId: result.eventId })
  }
  return c.json({ error: result.code }, result.status)
}

// Real RevenueCat payloads run a few KB; the bound refuses oversized
// bodies before the handler buffers them.
export default createRoute(bodyLimit({ maxSize: 256 * 1024 }), handleWebhook)
export const POST = createRoute(bodyLimit({ maxSize: 256 * 1024 }), handleWebhook)
