import { createRoute } from 'honox/factory'
import { processStripeWebhook, type StripeWebhookEnv } from '../../lib/stripe-webhook'

const handleWebhook = async (c: Parameters<ReturnType<typeof createRoute>[number]>[0]) => {
  const result = await processStripeWebhook(c.req.raw, c.env as StripeWebhookEnv)
  if (result.status === 200) {
    return c.json({ ok: true, code: result.code, eventId: result.eventId })
  }
  return c.json({ error: result.code }, result.status)
}

export default createRoute(handleWebhook)
export const POST = createRoute(handleWebhook)
