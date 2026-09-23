import { beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { POST } from './revenuecat-webhook'
import { resetGalleryStore } from '../../lib/gallery-repository'
import { getUserByDropboxId, resetUserStore } from '../../lib/user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from '../../lib/test-fixtures'

const authorization = 'revenuecat-test-auth'
const signingSecret = 'revenuecat-signing-secret'
const env = {
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  REVENUECAT_WEBHOOK_AUTH: authorization,
  REVENUECAT_WEBHOOK_SIGNING_SECRET: signingSecret,
}
const body = JSON.stringify({
  api_version: '1.0',
  event: {
    id: 'route-event-1',
    type: 'INITIAL_PURCHASE',
    app_user_id: TEST_OWNER.dropboxAccountId,
    entitlement_ids: ['will_pay'],
  },
})

const signedHeaders = (rawBody: string) => {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  return {
    Authorization: authorization,
    'X-RevenueCat-Webhook-Signature': `t=${timestamp},v1=${signature}`,
    'Content-Type': 'application/json',
  }
}

const app = new Hono<{ Bindings: typeof env }>()
app.post('/api/revenuecat-webhook', POST[0] as never)

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
})

describe('RevenueCat webhook route', () => {
  test('accepts a signed POST and returns JSON APPLIED', async () => {
    const response = await app.request(
      '/api/revenuecat-webhook',
      { method: 'POST', headers: signedHeaders(body), body },
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      code: 'APPLIED',
      eventId: 'route-event-1',
    })
    expect((await getUserByDropboxId(TEST_OWNER.dropboxAccountId))?.tier).toBe('pro')
  })

  test('routes an invalid signature to the JSON 401 response', async () => {
    const headers = signedHeaders(body)
    headers['X-RevenueCat-Webhook-Signature'] = 't=1,v1=wrong'
    const response = await app.request(
      '/api/revenuecat-webhook',
      { method: 'POST', headers, body },
      env,
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'INVALID_SIGNATURE' })
  })
})
