import { createRoute } from 'honox/factory'
import { processRevenueCatWebhook, type RevenueCatWebhookEnv } from '../../lib/revenuecat-webhook'

export default createRoute(async (c) => {
  const result = await processRevenueCatWebhook(c.req.raw, c.env as RevenueCatWebhookEnv)
  if (result.status === 200) return c.json({ ok: true, code: result.code, eventId: result.eventId })
  return c.json({ error: result.code }, result.status)
})
