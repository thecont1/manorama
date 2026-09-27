import { beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { resetGalleryStore } from './gallery-repository'
import { resetUserStore, getUserByDropboxId, setUserTier } from './user-repository'
import { seedTestUser, TEST_OWNER } from './test-fixtures'
import { processStripeWebhook, verifyStripeSignature } from './stripe-webhook'

const signingSecret = 'whsec_test_secret'

const payloadFor = (session: Record<string, unknown>, event: Record<string, unknown> = {}) => JSON.stringify({
  id: 'evt_1',
  type: 'checkout.session.completed',
  created: Math.floor(Date.now() / 1000),
  data: { object: session },
  ...event,
})

const signedRequest = async (body: string, timestamp = Math.floor(Date.now() / 1000)) => {
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return new Request('https://manorama.xyz/api/stripe-webhook', {
    method: 'POST',
    headers: {
      'Stripe-Signature': `t=${timestamp},v1=${signature}`,
      'Content-Type': 'application/json',
    },
    body,
  })
}

const env = { STRIPE_WEBHOOK_SIGNING_SECRET: signingSecret }

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
})

describe('Stripe signature verification', () => {
  test('accepts a fresh v1 signature and rejects stale or wrong ones', async () => {
    const body = payloadFor({})
    const timestamp = 1_800_000_000
    const signature = createHmac('sha256', signingSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    expect(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, signingSecret, timestamp)).toBe(true)
    // Rotation: one matching v1 among several is valid.
    expect(await verifyStripeSignature(body, `t=${timestamp},v1=deadbeef,v1=${signature}`, signingSecret, timestamp)).toBe(true)
    expect(await verifyStripeSignature(body, `t=${timestamp},v1=${signature}`, signingSecret, timestamp + 301)).toBe(false)
    expect(await verifyStripeSignature(body, `t=${timestamp},v1=wrong`, signingSecret, timestamp)).toBe(false)
    expect(await verifyStripeSignature(body, null, signingSecret, timestamp)).toBe(false)
  })
})

describe('Stripe webhook tier sync', () => {
  test('promotes the client_reference_id account through setUserTier', async () => {
    const request = await signedRequest(payloadFor({
      client_reference_id: TEST_OWNER.dropboxAccountId,
    }))
    const result = await processStripeWebhook(request, env)
    expect(result).toEqual({ status: 200, code: 'APPLIED', eventId: 'evt_1', tier: 'pro' })
    expect((await getUserByDropboxId(TEST_OWNER.dropboxAccountId))?.tier).toBe('pro')
  })

  test('rejects an unsigned delivery without changing tier', async () => {
    const request = new Request('https://manorama.xyz/api/stripe-webhook', {
      method: 'POST',
      body: payloadFor({ client_reference_id: TEST_OWNER.dropboxAccountId }, { id: 'evt_2' }),
    })
    expect(await processStripeWebhook(request, env)).toEqual({ status: 401, code: 'INVALID_SIGNATURE' })
  })

  test('ignores non-checkout events', async () => {
    const request = await signedRequest(payloadFor({}, { id: 'evt_3', type: 'customer.subscription.deleted' }))
    expect(await processStripeWebhook(request, env)).toEqual({ status: 200, code: 'IGNORED_EVENT', eventId: 'evt_3' })
  })

  test('ignores sessions without a known account', async () => {
    const missing = await signedRequest(payloadFor({ id: 'sess_no_ref' }, { id: 'evt_4' }))
    expect(await processStripeWebhook(missing, env)).toEqual({ status: 200, code: 'IGNORED_IDENTITY', eventId: 'evt_4' })
    const unknown = await signedRequest(payloadFor({ client_reference_id: 'dbid:nobody' }, { id: 'evt_5' }))
    expect(await processStripeWebhook(unknown, env)).toEqual({ status: 200, code: 'IGNORED_UNKNOWN_ACCOUNT', eventId: 'evt_5' })
  })

  test('ignores a replayed or older delivery', async () => {
    await setUserTier(TEST_OWNER.dropboxAccountId, 'free')
    const nowSeconds = Math.floor(Date.now() / 1000)
    const newer = await signedRequest(payloadFor(
      { client_reference_id: TEST_OWNER.dropboxAccountId },
      { id: 'evt_newer', created: nowSeconds + 2_000 },
    ))
    const older = await signedRequest(payloadFor(
      { client_reference_id: TEST_OWNER.dropboxAccountId },
      { id: 'evt_older', created: nowSeconds + 1_000 },
    ))
    expect(await processStripeWebhook(newer, env)).toMatchObject({ code: 'APPLIED', tier: 'pro' })
    expect(await processStripeWebhook(older, env)).toEqual({
      status: 200,
      code: 'IGNORED_STALE',
      eventId: 'evt_older',
    })
  })
})
