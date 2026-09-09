import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createSessionToken, requireSession, SESSION_COOKIE, type HonoSessionEnv } from '../app/lib/dropbox-session'
import { resetUserStore } from '../app/lib/user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from '../app/lib/test-fixtures'
import { createVendoAuth } from './server'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let cookie: string
let forgedCookie: string

beforeAll(async () => {
  resetUserStore()
  await seedTestUser()
  cookie = `${SESSION_COOKIE}=${await createSessionToken(TEST_OWNER.dropboxAccountId, TEST_SESSION_SECRET)}`
  forgedCookie = `${SESSION_COOKIE}=${await createSessionToken(TEST_OWNER.dropboxAccountId, 'a-different-secret-that-is-long-enough')}`
})

const request = (headers?: Record<string, string>) =>
  new Request('https://manorama.xyz/api/vendo/threads', { headers })

describe('Vendo principals resolve from the Manorama Dropbox session', () => {
  test('anonymous requests produce a null principal', async () => {
    const auth = createVendoAuth(env)
    expect(await auth.principal(request())).toBeNull()
  })

  test('invalid session cookies produce a null principal', async () => {
    const auth = createVendoAuth(env)
    expect(await auth.principal(request({ Cookie: 'manorama_session=not-a-jwt' }))).toBeNull()
    // Signed by a different secret: verification must fail closed.
    expect(await auth.principal(request({ Cookie: forgedCookie }))).toBeNull()
  })

  test('missing session configuration fails closed', async () => {
    const auth = createVendoAuth({})
    expect(await auth.principal(request({ Cookie: cookie }))).toBeNull()
  })

  test('an unknown account fails closed even with a valid token', async () => {
    const stranger = `${SESSION_COOKIE}=${await createSessionToken('dbid:AAADELETEDuser', TEST_SESSION_SECRET)}`
    const auth = createVendoAuth(env)
    expect(await auth.principal(request({ Cookie: stranger }))).toBeNull()
  })

  test('a valid session produces the dropbox principal', async () => {
    const auth = createVendoAuth(env)
    expect(await auth.principal(request({ Cookie: cookie })))
      .toEqual({ kind: 'user', subject: `dropbox:${TEST_OWNER.dropboxAccountId}` })
  })

  test('the verified email is exposed only through facts, never the subject', async () => {
    const auth = createVendoAuth(env)
    expect(await auth.facts?.(request({ Cookie: cookie })))
      .toEqual({ email: TEST_OWNER.email })
    const noEmail = await seedTestUser({ dropboxAccountId: 'dbid:AAANOEMAILuser', displayName: 'No Email', email: undefined })
    expect(noEmail.email).toBeUndefined()
    const noEmailCookie = `${SESSION_COOKIE}=${await createSessionToken('dbid:AAANOEMAILuser', TEST_SESSION_SECRET)}`
    expect(await auth.facts?.(request({ Cookie: noEmailCookie }))).toBeUndefined()
    expect(await auth.facts?.(request())).toBeUndefined()
  })

  test('the API middleware and Vendo resolve byte-for-byte identical subjects', async () => {
    const app = new Hono<HonoSessionEnv>()
    app.use(requireSession())
    app.get('/whoami', (c) => c.json({ id: c.get('manoramaSession').id }))
    const response = await app.request('/whoami', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    const { id } = await response.json() as { id: string }
    const auth = createVendoAuth(env)
    expect((await auth.principal(request({ Cookie: cookie })))?.subject).toBe(id)
  })
})
