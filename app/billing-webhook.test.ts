import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createManoramaApi } from './api'
import revenueCatRoute from './routes/api/revenuecat-webhook'
import stripeRoute from './routes/api/stripe-webhook'
import { getUserByAccountId, resetUserStore, upsertUser } from './lib/user-repository'
import { resetGalleryStore } from './lib/gallery-repository'

/**
 * The billing webhooks. These are the only anonymous endpoints that can move
 * privilege, and they gate that on two very different things.
 *
 * Stripe requires an HMAC signing secret and fails closed without one.
 * RevenueCat treats its signing secret as optional: when
 * `REVENUECAT_WEBHOOK_SIGNING_SECRET` is unset the endpoint silently degrades
 * to a single static `Authorization` string, and any caller holding it can
 * mint Pro (and, through an undated event, mint Free).
 *
 * Observations that are guard tests rather than bugs: promotion follows
 * `client_reference_id`, which a buyer controls on a Payment Link, so paying
 * promotes whatever account the reference names — not the buyer; no amount or
 * price is ever inspected; and a non-hex reference is used verbatim.
 */

const RC_AUTH = 'synthetic-rc-auth'
const RC_SECRET = 'synthetic-rc-signing-secret'
const STRIPE_SECRET = 'synthetic-stripe-whsec'
const VICTIM = 'dbid:AAAvictim'
const BUYER = 'dbid:AAAbuyer'

const app = new Hono()
app.route('/', createManoramaApi())
app.post('/api/revenuecat-webhook', ...(revenueCatRoute as unknown as []))
app.post('/api/stripe-webhook', ...(stripeRoute as unknown as []))

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const sign = async (secret: string, timestamp: number, body: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))))
}

const now = () => Math.floor(Date.now() / 1000)

const jsonOf = async (response: Response): Promise<{ code?: string; error?: string }> =>
  (await response.json()) as { code?: string; error?: string }

const rcBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  api_version: '1.0',
  event: {
    id: 'evt_synth',
    type: 'INITIAL_PURCHASE',
    app_user_id: VICTIM,
    entitlement_ids: ['will_pay'],
    ...extra,
  },
})

const rcPost = (body: string, env: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request('/api/revenuecat-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  }, env)

const rcSigned = async (body: string, env: Record<string, string>, timestamp = now()) =>
  rcPost(body, env, { Authorization: RC_AUTH, 'X-RevenueCat-Webhook-Signature': `t=${timestamp},v1=${await sign(RC_SECRET, timestamp, body)}` })

const stripePost = async (object: Record<string, unknown>, type = 'checkout.session.completed', env: Record<string, string> = { STRIPE_WEBHOOK_SIGNING_SECRET: STRIPE_SECRET }) => {
  const body = JSON.stringify({ id: 'evt_synth', type, created: now(), data: { object } })
  const timestamp = now()
  return app.request('/api/stripe-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${await sign(STRIPE_SECRET, timestamp, body)}` },
    body,
  }, env)
}

const seed = async () => {
  resetUserStore()
  resetGalleryStore()
  await upsertUser({ accountId: VICTIM, displayName: 'Victim' })
  await upsertUser({ accountId: BUYER, displayName: 'Buyer' })
}

describe('revenuecat authentication', () => {
  test('with a signing secret, an unsigned delivery is refused', async () => {
    await seed()
    const response = await rcPost(rcBody(), { REVENUECAT_WEBHOOK_AUTH: RC_AUTH, REVENUECAT_WEBHOOK_SIGNING_SECRET: RC_SECRET }, { Authorization: RC_AUTH })
    expect(response.status).toBe(401)
    expect((await jsonOf(response)).error).toBe('INVALID_SIGNATURE')
    expect((await getUserByAccountId(VICTIM))?.tier).toBe('free')
  })

  test('a signature outside the five-minute window is refused', async () => {
    await seed()
    const body = rcBody()
    const response = await rcSigned(body, { REVENUECAT_WEBHOOK_AUTH: RC_AUTH, REVENUECAT_WEBHOOK_SIGNING_SECRET: RC_SECRET }, now() - 400)
    expect(response.status).toBe(401)
  })

  test('a valid signature is applied', async () => {
    await seed()
    const response = await rcSigned(rcBody(), { REVENUECAT_WEBHOOK_AUTH: RC_AUTH, REVENUECAT_WEBHOOK_SIGNING_SECRET: RC_SECRET })
    expect(response.status).toBe(200)
    expect((await getUserByAccountId(VICTIM))?.tier).toBe('pro')
  })

  test('an unsigned body is accepted when no signing secret is configured', async () => {
    // Today's behaviour: the bearer alone is the whole gate.
    await seed()
    const response = await rcPost(rcBody(), { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }, { Authorization: RC_AUTH })
    expect(response.status).toBe(200)
    expect((await getUserByAccountId(VICTIM))?.tier).toBe('pro')
  })

  test('the signing secret should be required, as it already is for Stripe', async () => {
    // Recommended contract: unset signing secret means refuse, so a deployment
    // cannot quietly lose signature verification. Currently 200.
    await seed()
    const response = await rcPost(rcBody(), { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }, { Authorization: RC_AUTH })
    expect(response.status).toBe(401)
  })
})

describe('revenuecat event ordering', () => {
  test('an undated event cannot leave an account downgraded against a newer watermark', async () => {
    // An event with no event_timestamp_ms is applied unconditionally, because
    // `order` is undefined and the monotonic guard in setUserTier never runs.
    // It also leaves the stored watermark untouched, so a genuinely later
    // event is then judged stale. End state here must be Pro either way:
    // the fix may be to reject undated events or to stamp them with now().
    await seed()
    const env = { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }

    const fresh = rcBody({ id: 'evt_fresh', event_timestamp_ms: 9_999_999_999_999, expiration_at_ms: 9_999_999_999_999 })
    expect((await rcPost(fresh, env, { Authorization: RC_AUTH })).status).toBe(200)

    const replay = rcBody({ id: 'evt_replayed', type: 'EXPIRATION', event_timestamp_ms: undefined })
    await rcPost(replay, env, { Authorization: RC_AUTH })

    const newer = rcBody({ id: 'evt_later', event_timestamp_ms: 5_000 })
    await rcPost(newer, env, { Authorization: RC_AUTH })

    expect((await getUserByAccountId(VICTIM))?.tier).toBe('pro')
  })

  test('a duplicate delivery at the same instant is ignored', async () => {
    await seed()
    const env = { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }
    const body = rcBody({ id: 'evt_same', event_timestamp_ms: 1_000 })
    expect((await rcPost(body, env, { Authorization: RC_AUTH })).status).toBe(200)
    const again = await rcPost(body, env, { Authorization: RC_AUTH })
    expect((await jsonOf(again)).code).toBe('IGNORED_STALE')
  })

  test('an event that is not about the paid entitlement is ignored', async () => {
    await seed()
    const body = rcBody({ entitlement_ids: ['some_other_entitlement'] })
    const response = await rcPost(body, { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }, { Authorization: RC_AUTH })
    expect((await jsonOf(response)).code).toBe('IGNORED_ENTITLEMENT')
  })
})

describe('webhook body limits', () => {
  const filler = () => 'x'.repeat(8 * 1024 * 1024)
  // RevenueCat nests the event; Stripe puts id/type at the top level.
  const oversizedRc = () => JSON.stringify({
    api_version: '1.0',
    filler: filler(),
    event: { id: 'evt_big', type: 'INITIAL_PURCHASE', app_user_id: VICTIM, entitlement_ids: ['will_pay'] },
  })
  const oversizedStripe = () => JSON.stringify({
    id: 'evt_big', type: 'checkout.session.completed', created: now(), filler: filler(), data: { object: {} },
  })

  test('revenuecat refuses an oversized body before buffering it whole', async () => {
    // The device-gallery PUT is capped at 8192 bytes; the webhooks are unbounded,
    // and the body is read before authentication is even considered.
    await seed()
    const response = await rcPost(oversizedRc(), { REVENUECAT_WEBHOOK_AUTH: RC_AUTH }, { Authorization: RC_AUTH })
    expect(response.status).toBe(413)
  })

  test('stripe refuses an oversized body before buffering it whole', async () => {
    await seed()
    const body = oversizedStripe()
    const timestamp = now()
    const response = await app.request('/api/stripe-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${await sign(STRIPE_SECRET, timestamp, body)}` },
      body,
    }, { STRIPE_WEBHOOK_SIGNING_SECRET: STRIPE_SECRET })
    expect(response.status).toBe(413)
  })
})

describe('stripe promotion target', () => {
  test('the promotion follows client_reference_id, not the payer', async () => {
    await seed()
    const response = await stripePost({ payment_status: 'paid', client_reference_id: VICTIM })
    expect(response.status).toBe(200)
    expect((await getUserByAccountId(VICTIM))?.tier).toBe('pro')
    expect((await getUserByAccountId(BUYER))?.tier).toBe('free')
  })

  test('a reference outside the hex encoding is used verbatim', async () => {
    await seed()
    const response = await stripePost({ payment_status: 'paid', client_reference_id: BUYER })
    expect((await jsonOf(response)).code).toBe('APPLIED')
    expect((await getUserByAccountId(BUYER))?.tier).toBe('pro')
  })

  test('no amount or price is inspected', async () => {
    await seed()
    const response = await stripePost({ payment_status: 'paid', amount_total: 0, client_reference_id: BUYER })
    expect((await jsonOf(response)).code).toBe('APPLIED')
  })

  test('an unpaid session is held back for delayed payment methods', async () => {
    await seed()
    const response = await stripePost({ payment_status: 'unpaid', client_reference_id: VICTIM })
    expect((await jsonOf(response)).code).toBe('IGNORED_UNPAID')
    expect((await getUserByAccountId(VICTIM))?.tier).toBe('free')
  })

  test('no signing secret configured fails closed', async () => {
    await seed()
    const response = await stripePost({ payment_status: 'paid', client_reference_id: VICTIM }, 'checkout.session.completed', {})
    expect(response.status).toBe(401)
  })
})
