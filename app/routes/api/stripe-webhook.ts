import { createRoute } from 'honox/factory'
import { bodyLimit } from 'hono/body-limit'
import { processStripeWebhook, type StripeWebhookEnv } from '../../lib/stripe-webhook'

const handleWebhook = async (c: Parameters<ReturnType<typeof createRoute>[number]>[0]) => {
  const result = await processStripeWebhook(c.req.raw, c.env as StripeWebhookEnv)
  if (result.status === 200) {
    return c.json({ ok: true, code: result.code, eventId: result.eventId })
  }
  return c.json({ error: result.code }, result.status)
}

// Stripe checkout.session payloads run 10–20 KB; the bound refuses
// oversized bodies before the handler buffers them.
export default createRoute(bodyLimit({ maxSize: 256 * 1024 }), handleWebhook)
export const POST = createRoute(bodyLimit({ maxSize: 256 * 1024 }), handleWebhook)
