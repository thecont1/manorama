import { beforeAll, describe, expect, test } from 'bun:test'
import { createSessionToken, resolveManoramaSession, SESSION_COOKIE } from './dropbox-session'
import { resetUserStore, updateOwnerSlug } from './user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from './test-fixtures'

const requestWith = (cookie?: string) =>
  new Request('https://manorama.xyz/api/galleries', cookie ? { headers: { Cookie: cookie } } : undefined)

beforeAll(() => {
  resetUserStore()
})

describe('session token issuance and resolution', () => {
  test('a missing signing secret fails closed', async () => {
    await seedTestUser()
    const token = await createSessionToken(TEST_OWNER.dropboxAccountId, TEST_SESSION_SECRET)
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), {})).toBeNull()
  })

  test('a request without a cookie resolves to null', async () => {
    await seedTestUser()
    expect(await resolveManoramaSession(requestWith(), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a malformed token resolves to null', async () => {
    await seedTestUser()
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=not-a-jwt`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a token signed by a different secret resolves to null', async () => {
    await seedTestUser()
    const token = await createSessionToken(TEST_OWNER.dropboxAccountId, 'a-different-secret-that-is-long-enough')
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a token for an unknown account resolves to null', async () => {
    await seedTestUser()
    const token = await createSessionToken('dbid:AAADELETEDuser', TEST_SESSION_SECRET)
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a valid session resolves with the account-keyed id', async () => {
    await seedTestUser()
    const token = await createSessionToken(TEST_OWNER.dropboxAccountId, TEST_SESSION_SECRET)
    const session = await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })
    expect(session).toEqual({
      id: `dropbox:${TEST_OWNER.dropboxAccountId}`,
      dropboxAccountId: TEST_OWNER.dropboxAccountId,
      ownerSlug: 'test-owner',
      name: 'Test Owner',
      tier: 'free',
      email: TEST_OWNER.email,
    })
  })

  test('an owner slug change is reflected without a new cookie', async () => {
    const user = await seedTestUser()
    const token = await createSessionToken(user.dropboxAccountId, TEST_SESSION_SECRET)
    const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
    expect((await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), env))?.ownerSlug).toBe('test-owner')
    await updateOwnerSlug(user.dropboxAccountId, 'moved-owner')
    expect((await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), env))?.ownerSlug).toBe('moved-owner')
  })
})
