import {
  getUserByDropboxId,
  setUserTier,
  type BillingEventOrder,
  type UserRepositoryEnv,
} from './user-repository'

export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export type StripeWebhookEnv = UserRepositoryEnv & {
  STRIPE_WEBHOOK_SIGNING_SECRET?: string
}

type StripeEvent = {
  id?: string
  type?: string
  created?: number
  data?: { object?: Record<string, unknown> }
}

const constantTimeEqual = (expected: string, actual: string) => {
  if (expected.length !== actual.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index)
  }
  return difference === 0
}

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Stripe-Signature is `t=<unix>,v1=<hex>` and may carry several v1 entries
 * during key rotation — a single matching v1 over `t.body` is a valid
 * delivery.
 */
export const verifyStripeSignature = async (
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) => {
  if (!header || !secret.trim()) return false
  let timestamp = NaN
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1') signatures.push(value)
  }
  if (!Number.isSafeInteger(timestamp) || !signatures.length) return false
  if (Math.abs(nowSeconds - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = bytesToHex(new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  ))
  return signatures.some((signature) => constantTimeEqual(digest, signature))
}

/**
 * Verifies and applies one Stripe event. The only mutating event is
 * `checkout.session.completed`: the Payment Link carries the owner's Dropbox
 * account ID in `client_reference_id`, and promotion goes through
 * `setUserTier` so pipeline galleries are retained in the same batch.
 * Subscription expiry/refund demotion is intentionally not handled yet —
 * Stripe subscriptions do not echo client_reference_id back, so a downgrade
 * path needs a stored customer mapping first.
 */
export const processStripeWebhook = async (
  request: Request,
  env: StripeWebhookEnv,
  nowSeconds = Math.floor(Date.now() / 1000),
) => {
  const signingSecret = env.STRIPE_WEBHOOK_SIGNING_SECRET?.trim()
  if (!signingSecret) return { status: 401 as const, code: 'UNAUTHORIZED' as const }
  const rawBody = await request.text()
  if (!(await verifyStripeSignature(rawBody, request.headers.get('Stripe-Signature'), signingSecret, nowSeconds))) {
    return { status: 401 as const, code: 'INVALID_SIGNATURE' as const }
  }

  let event: StripeEvent
  try {
    event = JSON.parse(rawBody) as StripeEvent
  } catch {
    return { status: 400 as const, code: 'INVALID_JSON' as const }
  }
  if (!event.id || typeof event.id !== 'string' || !event.type) {
    return { status: 400 as const, code: 'INVALID_EVENT' as const }
  }
  if (event.type !== 'checkout.session.completed') {
    return { status: 200 as const, code: 'IGNORED_EVENT' as const, eventId: event.id }
  }

  const session = event.data?.object ?? {}
  const accountId = typeof session.client_reference_id === 'string'
    ? session.client_reference_id.trim()
    : ''
  if (!accountId) return { status: 200 as const, code: 'IGNORED_IDENTITY' as const, eventId: event.id }

  if (!(await getUserByDropboxId(accountId, env))) {
    return { status: 200 as const, code: 'IGNORED_UNKNOWN_ACCOUNT' as const, eventId: event.id }
  }
  const order: BillingEventOrder | undefined = Number.isSafeInteger(event.created)
    ? { timestampMs: event.created! * 1000, eventId: event.id }
    : undefined
  if (!(await setUserTier(accountId, 'pro', env, undefined, order))) {
    return { status: 200 as const, code: 'IGNORED_STALE' as const, eventId: event.id }
  }
  return { status: 200 as const, code: 'APPLIED' as const, eventId: event.id, tier: 'pro' as const }
}
