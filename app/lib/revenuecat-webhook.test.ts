import { beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { resetGalleryStore } from './gallery-repository'
import { resetUserStore, getUserByAccountId, setUserTier, upsertUser } from './user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from './test-fixtures'
import {
  processRevenueCatWebhook,
  verifyRevenueCatAuthorization,
  verifyRevenueCatSignature,
} from './revenuecat-webhook'

const webhookAuth = 'revenuecat-test-auth'
const signingSecret = 'revenuecat-signing-secret'

const payloadFor = (event: Record<string, unknown>) => JSON.stringify({
  api_version: '1.0',
  event: {
    id: 'event-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: TEST_OWNER.accountId,
    entitlement_ids: ['will_pay'],
    ...event,
  },
})

const signedRequest = async (body: string, timestamp = Math.floor(Date.now() / 1000)) => {
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return new Request('https://manorama.xyz/api/revenuecat-webhook', {
    method: 'POST',
    headers: {
      Authorization: webhookAuth,
      'X-RevenueCat-Webhook-Signature': `t=${timestamp},v1=${signature}`,
      'Content-Type': 'application/json',
    },
    body,
  })
}

const env = {
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  REVENUECAT_WEBHOOK_AUTH: webhookAuth,
  REVENUECAT_WEBHOOK_SIGNING_SECRET: signingSecret,
}

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
})

describe('RevenueCat webhook verification', () => {
  test('accepts the configured authorization header', () => {
    const request = new Request('https://manorama.xyz')
    request.headers.set('Authorization', webhookAuth)
    expect(verifyRevenueCatAuthorization(request, webhookAuth)).toBe(true)
    expect(verifyRevenueCatAuthorization(request, 'wrong')).toBe(false)
  })

  test('accepts a fresh HMAC over the exact raw body and rejects stale signatures', async () => {
    const body = payloadFor({})
    const timestamp = 1_800_000_000
    const signature = createHmac('sha256', signingSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    const header = `t=${timestamp},v1=${signature}`
    expect(await verifyRevenueCatSignature(body, header, signingSecret, timestamp)).toBe(true)
    expect(await verifyRevenueCatSignature(body, header, signingSecret, timestamp + 301)).toBe(false)
  })
})

describe('RevenueCat webhook tier sync', () => {
  test('promotes a known Dropbox account through setUserTier', async () => {
    const request = await signedRequest(payloadFor({ type: 'INITIAL_PURCHASE' }))
    const result = await processRevenueCatWebhook(request, env)
    expect(result).toEqual({ status: 200, code: 'APPLIED', eventId: 'event-1', tier: 'pro' })
    expect((await getUserByAccountId(TEST_OWNER.accountId))?.tier).toBe('pro')
  })

  test('revokes pro for an expiration event', async () => {
    const request = await signedRequest(payloadFor({
      id: 'event-2',
      type: 'EXPIRATION',
      entitlement_ids: ['will_pay'],
      expiration_at_ms: Date.now() - 1,
    }))
    const result = await processRevenueCatWebhook(request, env)
    expect(result).toEqual({ status: 200, code: 'APPLIED', eventId: 'event-2', tier: 'free' })
    expect((await getUserByAccountId(TEST_OWNER.accountId))?.tier).toBe('free')
  })

  test('rejects an unauthenticated delivery without changing tier', async () => {
    const body = payloadFor({ id: 'event-3' })
    const request = new Request('https://manorama.xyz/api/revenuecat-webhook', {
      method: 'POST',
      headers: { Authorization: 'wrong' },
      body,
    })
    const result = await processRevenueCatWebhook(request, env)
    expect(result).toEqual({ status: 401, code: 'UNAUTHORIZED' })
  })

  test('reconciles both sides of a transfer event', async () => {
    const source = 'dbid:AAAsource'
    const destination = 'dbid:AAAdestination'
    await upsertUser({ accountId: source, displayName: 'Source Owner' })
    await upsertUser({ accountId: destination, displayName: 'Destination Owner' })
    await setUserTier(source, 'pro')
    const request = await signedRequest(payloadFor({
      id: 'event-transfer',
      type: 'TRANSFER',
      app_user_id: undefined,
      transferred_from: [source],
      transferred_to: [destination],
      event_timestamp_ms: Date.now(),
    }))

    const result = await processRevenueCatWebhook(request, env)
    expect(result).toMatchObject({ status: 200, code: 'APPLIED', eventId: 'event-transfer' })
    expect((await getUserByAccountId(source))?.tier).toBe('free')
    expect((await getUserByAccountId(destination))?.tier).toBe('pro')
  })

  test('promotes a known acct_-keyed account through the same path', async () => {
    const accountId = 'acct_12345678-1234-4abc-8def-0123456789ab'
    await upsertUser({ accountId, displayName: 'Acct Owner' })
    const request = await signedRequest(payloadFor({ id: 'event-acct', app_user_id: accountId }))
    const result = await processRevenueCatWebhook(request, env)
    expect(result).toEqual({ status: 200, code: 'APPLIED', eventId: 'event-acct', tier: 'pro' })
    expect((await getUserByAccountId(accountId))?.tier).toBe('pro')
  })

  test('reconciles a legacy-to-new transfer on the same path', async () => {
    const source = 'dbid:AAAlegacysrc'
    const destination = 'acct_abcdef12-3456-4abc-8def-0123456789ab'
    await upsertUser({ accountId: source, displayName: 'Legacy Source' })
    await upsertUser({ accountId: destination, displayName: 'New Destination' })
    await setUserTier(source, 'pro')
    const request = await signedRequest(payloadFor({
      id: 'event-mixed-transfer',
      type: 'TRANSFER',
      app_user_id: undefined,
      transferred_from: [source],
      transferred_to: [destination],
      event_timestamp_ms: Date.now(),
    }))

    const result = await processRevenueCatWebhook(request, env)
    expect(result).toMatchObject({ status: 200, code: 'APPLIED', eventId: 'event-mixed-transfer' })
    expect((await getUserByAccountId(source))?.tier).toBe('free')
    expect((await getUserByAccountId(destination))?.tier).toBe('pro')
  })

  test('ignores anonymous and malformed recipients', async () => {
    for (const id of ['$RCAnonymousID:abc123', 'someone@example.com', 'acct_not-a-uuid', 42]) {
      const request = await signedRequest(payloadFor({ id: `event-ignored-${id}`, app_user_id: id }))
      expect(await processRevenueCatWebhook(request, env))
        .toEqual({ status: 200, code: 'IGNORED_IDENTITY', eventId: `event-ignored-${id}` })
    }
  })

  test('ignores account-shaped ids that match no account', async () => {
    const request = await signedRequest(payloadFor({
      id: 'event-unknown',
      app_user_id: 'acct_00000000-0000-4000-8000-000000000000',
    }))
    expect(await processRevenueCatWebhook(request, env))
      .toEqual({ status: 200, code: 'IGNORED_UNKNOWN_ACCOUNT', eventId: 'event-unknown' })
  })

  test('ignores an older delivery without changing the newer tier', async () => {
    const account = TEST_OWNER.accountId
    const newer = await signedRequest(payloadFor({
      id: 'event-newer',
      type: 'INITIAL_PURCHASE',
      event_timestamp_ms: 2_000,
    }))
    const older = await signedRequest(payloadFor({
      id: 'event-older',
      type: 'EXPIRATION',
      entitlement_ids: ['will_pay'],
      expiration_at_ms: Date.now() - 1,
      event_timestamp_ms: 1_000,
    }))

    expect(await processRevenueCatWebhook(newer, env)).toMatchObject({ code: 'APPLIED', tier: 'pro' })
    expect(await processRevenueCatWebhook(older, env)).toEqual({
      status: 200,
      code: 'IGNORED_STALE',
      eventId: 'event-older',
    })
    expect((await getUserByAccountId(account))?.tier).toBe('pro')
  })

  test('does not demote an account for an event without will_pay state', async () => {
    await setUserTier(TEST_OWNER.accountId, 'pro')
    const request = await signedRequest(payloadFor({
      id: 'event-unrelated',
      type: 'INVOICE_ISSUANCE',
      entitlement_ids: ['other_entitlement'],
      event_timestamp_ms: 3_000,
    }))

    expect(await processRevenueCatWebhook(request, env)).toEqual({
      status: 200,
      code: 'IGNORED_ENTITLEMENT',
      eventId: 'event-unrelated',
    })
    expect((await getUserByAccountId(TEST_OWNER.accountId))?.tier).toBe('pro')
  })
})
