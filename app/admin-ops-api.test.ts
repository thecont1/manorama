import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { resetAdSuppressionStore } from './lib/ads-visibility'
import { resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { resetMasterAccountStore } from './lib/master-accounts'
import { resetUserStore, setLastSeenCountry } from './lib/user-repository'

const env = {
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  MASTER_ACCOUNT_ID: TEST_OWNER.accountId,
}

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  resetAdSuppressionStore()
  resetMasterAccountStore()
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
    const body = await allowed.json() as { users: { users: { accountId: string; email?: string }[]; pageSize: number; totalPages: number } }
    const accountIds = body.users.users.map((user) => user.accountId)
    expect(accountIds[0]).toBe(TEST_OWNER.accountId)
    expect(accountIds).toContain(TEST_OWNER.accountId)
    expect(accountIds).toContain(other.accountId)
    expect(body.users.pageSize).toBe(100)
    expect(body.users.totalPages).toBe(1)
    expect(JSON.stringify(body)).not.toContain('provider_subject')
  })

  test('keeps masters first, supports multiple masters, and filters by last-seen country', async () => {
    const api = createManoramaApi()
    const other = await seedTestUser({ accountId: 'acct_operator', displayName: 'Operator', email: 'operator@example.test' })
    const india = await seedTestUser({ accountId: 'acct_india', displayName: 'India User', email: 'india@example.test' })
    await setLastSeenCountry(other.accountId, 'DE')
    await setLastSeenCountry(india.accountId, 'IN')
    const headers = { Cookie: await sessionCookieFor(TEST_OWNER.accountId), 'Content-Type': 'application/json' }

    const grant = await api.request(`/api/admin/users/${other.accountId}/master`, {
      method: 'PUT', headers, body: JSON.stringify({ granted: true }),
    }, env)
    expect(grant.status).toBe(200)

    const overview = await api.request('/api/admin/overview', { headers }, env)
    const users = ((await overview.json()) as { users: { users: { accountId: string; isMaster: boolean }[] } }).users.users
    expect(users.slice(0, 2).every((user) => user.isMaster)).toBe(true)

    const filtered = await api.request('/api/admin/overview?country=IN', { headers }, env)
    const filteredUsers = ((await filtered.json()) as { users: { users: { accountId: string; lastSeenCountry?: string }[]; total: number } }).users
    expect(filteredUsers.total).toBe(1)
    expect(filteredUsers.users[0]?.accountId).toBe(india.accountId)

    const revoke = await api.request(`/api/admin/users/${other.accountId}/master`, {
      method: 'PUT', headers, body: JSON.stringify({ granted: false }),
    }, env)
    expect(revoke.status).toBe(200)
    const selfRevoke = await api.request(`/api/admin/users/${TEST_OWNER.accountId}/master`, {
      method: 'PUT', headers, body: JSON.stringify({ granted: false }),
    }, env)
    expect(selfRevoke.status).toBe(409)
  })

  test('does not turn suppression storage failures into an empty overview', async () => {
    const api = createManoramaApi()
    const row = {
      account_id: TEST_OWNER.accountId,
      owner_slug: 'test-owner',
      display_name: TEST_OWNER.displayName,
      email: TEST_OWNER.email,
      tier: 'free',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      gallery_count: 0,
      device_gallery_count: 0,
      identity_count: 0,
    }
    const failingDb = {
      prepare(sql: string) {
        const statement = {
          bind: () => statement,
          first: async () => row,
          all: async () => {
            if (sql.includes('ad_suppressions')) throw new Error('d1 unavailable')
            return { results: [row] }
          },
        }
        return statement
      },
    }
    const response = await api.request('/api/admin/overview', {
      headers: { Cookie: await sessionCookieFor(TEST_OWNER.accountId) },
    }, { ...env, DB: failingDb as never })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'The operations overview is temporarily unavailable' })
  })

  test('requires exact account ID confirmation and never deletes the master account', async () => {
    const api = createManoramaApi()
    const headers = { Cookie: await sessionCookieFor(TEST_OWNER.accountId), 'Content-Type': 'application/json' }
    const other = await seedTestUser({ accountId: 'acct_delete_me', displayName: 'Delete Me', email: undefined })
    const path = `/api/admin/users/${other.accountId}`

    const missingConfirmation = await api.request(path, { method: 'DELETE', headers, body: JSON.stringify({}) }, env)
    expect(missingConfirmation.status).toBe(400)

    for (const body of [null, [], 42, 'acct_delete_me', true, { confirmAccountId: 42 }]) {
      const malformed = await api.request(path, {
        method: 'DELETE',
        headers,
        body: JSON.stringify(body),
      }, env)
      expect(malformed.status).toBe(400)
    }

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
