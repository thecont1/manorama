import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { resetAdSuppressionStore } from './lib/ads-visibility'
import { resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { resetUserStore } from './lib/user-repository'

const env = {
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  MASTER_ACCOUNT_ID: TEST_OWNER.accountId,
}

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  resetAdSuppressionStore()
  await seedTestUser()
})

describe('master operations API', () => {
  test('returns account metadata only to the configured master account', async () => {
    const api = createManoramaApi()
    const anonymous = await api.request('/api/admin/overview', {}, env)
    expect(anonymous.status).toBe(401)

    const other = await seedTestUser({ accountId: 'acct_other', displayName: 'Other User', email: 'other@example.test' })
    const forbidden = await api.request('/api/admin/overview', {
      headers: { Cookie: await sessionCookieFor(other.accountId) },
    }, env)
    expect(forbidden.status).toBe(403)

    const allowed = await api.request('/api/admin/overview', {
      headers: { Cookie: await sessionCookieFor(TEST_OWNER.accountId) },
    }, env)
    expect(allowed.status).toBe(200)
    const body = await allowed.json() as { users: { accountId: string; email?: string }[] }
    const accountIds = body.users.map((user) => user.accountId)
    expect(accountIds).toContain(TEST_OWNER.accountId)
    expect(accountIds).toContain(other.accountId)
    expect(JSON.stringify(body)).not.toContain('provider_subject')
  })

  test('requires exact account ID confirmation and never deletes the master account', async () => {
    const api = createManoramaApi()
    const headers = { Cookie: await sessionCookieFor(TEST_OWNER.accountId), 'Content-Type': 'application/json' }
    const other = await seedTestUser({ accountId: 'acct_delete_me', displayName: 'Delete Me', email: undefined })
    const path = `/api/admin/users/${other.accountId}`

    const missingConfirmation = await api.request(path, { method: 'DELETE', headers, body: JSON.stringify({}) }, env)
    expect(missingConfirmation.status).toBe(400)

    const deleted = await api.request(path, { method: 'DELETE', headers, body: JSON.stringify({ confirmAccountId: other.accountId }) }, env)
    expect(deleted.status).toBe(200)
    expect((await api.request('/api/admin/overview', { headers }, env)).text()).resolves.not.toContain(other.accountId)

    const self = await api.request(`/api/admin/users/${TEST_OWNER.accountId}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ confirmAccountId: TEST_OWNER.accountId }),
    }, env)
    expect(self.status).toBe(409)
  })
})
