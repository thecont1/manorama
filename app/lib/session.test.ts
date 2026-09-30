import { beforeAll, describe, expect, test } from 'bun:test'
import { createNativeHandoffToken, createSessionToken, isMasterAccount, resolveManoramaSession, SESSION_COOKIE } from './session'
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
    const token = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
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
    const token = await createSessionToken(TEST_OWNER.accountId, 'a-different-secret-that-is-long-enough')
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a token for an unknown account resolves to null', async () => {
    await seedTestUser()
    const token = await createSessionToken('dbid:AAADELETEDuser', TEST_SESSION_SECRET)
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })).toBeNull()
  })

  test('a valid session resolves with the account-keyed id', async () => {
    await seedTestUser()
    const token = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const session = await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), { HOST_API_JWT_SECRET: TEST_SESSION_SECRET })
    expect(session).toEqual({
      id: `account:${TEST_OWNER.accountId}`,
      accountId: TEST_OWNER.accountId,
      ownerSlug: 'test-owner',
      name: 'Test Owner',
      tier: 'free',
      email: TEST_OWNER.email,
    })
  })

  test('a valid bearer token resolves without a cookie', async () => {
    await seedTestUser()
    const token = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const request = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect((await resolveManoramaSession(request, { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }))?.accountId)
      .toBe(TEST_OWNER.accountId)
  })

  test('a native handoff token never resolves as a session, by cookie or bearer', async () => {
    await seedTestUser()
    const handoff = await createNativeHandoffToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
    expect(await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${handoff}`), env)).toBeNull()
    const bearer = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: `Bearer ${handoff}` },
    })
    expect(await resolveManoramaSession(bearer, env)).toBeNull()
  })

  test('a present Authorization header wins over the cookie, even malformed', async () => {
    const bearerUser = await seedTestUser()
    await seedTestUser({ accountId: 'dbid:AAACOOKIEuser', displayName: 'Cookie User' })
    const bearerToken = await createSessionToken(bearerUser.accountId, TEST_SESSION_SECRET)
    const cookieToken = await createSessionToken('dbid:AAACOOKIEuser', TEST_SESSION_SECRET)
    const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

    const both = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: `Bearer ${bearerToken}`, Cookie: `${SESSION_COOKIE}=${cookieToken}` },
    })
    expect((await resolveManoramaSession(both, env))?.accountId).toBe(bearerUser.accountId)

    const badCookie = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: `Bearer ${bearerToken}`, Cookie: `${SESSION_COOKIE}=not-a-jwt` },
    })
    expect((await resolveManoramaSession(badCookie, env))?.accountId).toBe(bearerUser.accountId)

    const badBearer = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: 'Bearer not-a-jwt', Cookie: `${SESSION_COOKIE}=${cookieToken}` },
    })
    expect(await resolveManoramaSession(badBearer, env)).toBeNull()

    const wrongScheme = new Request('https://manorama.xyz/api/galleries', {
      headers: { Authorization: 'Basic abc123', Cookie: `${SESSION_COOKIE}=${cookieToken}` },
    })
    expect(await resolveManoramaSession(wrongScheme, env)).toBeNull()
  })

  test('an owner slug change is reflected without a new cookie', async () => {
    const user = await seedTestUser()
    const token = await createSessionToken(user.accountId, TEST_SESSION_SECRET)
    const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
    expect((await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), env))?.ownerSlug).toBe('test-owner')
    await updateOwnerSlug(user.accountId, 'moved-owner')
    expect((await resolveManoramaSession(requestWith(`${SESSION_COOKIE}=${token}`), env))?.ownerSlug).toBe('moved-owner')
  })

  test('recognizes the configured Dropbox subject through its linked account', async () => {
    const lookupCalls: unknown[][] = []
    const identityDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          if (sql.includes('provider = ? AND provider_subject = ?')) {
            expect(sql).toContain('provider = ? AND provider_subject = ?')
            lookupCalls.push(args)
            return { first: async () => ({ account_id: TEST_OWNER.accountId }) }
          }
          return { first: async () => null }
        },
      }),
    }
    const session = { accountId: TEST_OWNER.accountId }
    expect(await isMasterAccount(session, {
      MASTER_DROPBOX_SUBJECT: 'dbid:mahesh-dropbox',
      DB: identityDb as never,
    })).toBe(true)
    expect(await isMasterAccount({ accountId: 'acct_other' }, {
      MASTER_DROPBOX_SUBJECT: 'dbid:mahesh-dropbox',
      DB: identityDb as never,
    })).toBe(false)
    expect(lookupCalls).toEqual([
      ['dropbox', 'dbid:mahesh-dropbox'],
      ['dropbox', 'dbid:mahesh-dropbox'],
    ])

    const missingIdentityDb = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    }
    expect(await isMasterAccount(session, {
      MASTER_DROPBOX_SUBJECT: 'dbid:mahesh-dropbox',
      DB: missingIdentityDb as never,
    })).toBe(false)

    const failedIdentityDb = {
      prepare: () => ({
        bind: () => ({ first: async () => { throw new Error('identity lookup unavailable') } }),
      }),
    }
    expect(await isMasterAccount(session, {
      MASTER_DROPBOX_SUBJECT: 'dbid:mahesh-dropbox',
      DB: failedIdentityDb as never,
    })).toBe(false)
    expect(await isMasterAccount(session, {})).toBe(false)
  })
})
