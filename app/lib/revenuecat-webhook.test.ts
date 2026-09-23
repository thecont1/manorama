import { beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { resetGalleryStore } from './gallery-repository'
import { resetUserStore, getUserByDropboxId } from './user-repository'
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
    app_user_id: TEST_OWNER.dropboxAccountId,
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
    expect((await getUserByDropboxId(TEST_OWNER.dropboxAccountId))?.tier).toBe('pro')
  })

  test('revokes pro for an expiration event', async () => {
    const request = await signedRequest(payloadFor({
      id: 'event-2',
      type: 'EXPIRATION',
      entitlement_ids: ['pro'],
      expiration_at_ms: Date.now() - 1,
    }))
    const result = await processRevenueCatWebhook(request, env)
    expect(result).toEqual({ status: 200, code: 'APPLIED', eventId: 'event-2', tier: 'free' })
    expect((await getUserByDropboxId(TEST_OWNER.dropboxAccountId))?.tier).toBe('free')
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
})

