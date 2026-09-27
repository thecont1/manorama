import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { decodeJwt } from 'jose'
import dropboxRoute from './routes/auth/dropbox'
import callbackRoute from './routes/auth/dropbox/callback'
import { DESKTOP_CALLBACK, DESKTOP_CHALLENGE_COOKIE, desktopCodeChallenge, verifyDesktopHandoffToken } from './lib/desktop-auth'
import { OAUTH_NATIVE_COOKIE, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE } from './lib/dropbox-oauth'
import { RETURNING_COOKIE, SESSION_COOKIE } from './lib/dropbox-session'
import { resetUserStore } from './lib/user-repository'
import { TEST_SESSION_SECRET } from './lib/test-fixtures'

const ACCOUNT_ID = 'dbid:AAATESToauthroute'
const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

const env = {
  DROPBOX_APP_KEY: 'test-app-key',
  DROPBOX_APP_SECRET: 'test-app-secret',
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
}

const app = new Hono()
app.get('/auth/dropbox', ...dropboxRoute)
app.get('/auth/dropbox/callback', ...callbackRoute)

const realFetch = globalThis.fetch
let fetchCalls: string[] = []

const stubProvider = () => {
  fetchCalls = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    fetchCalls.push(url)
    if (url.includes('oauth2/token')) return Response.json({ access_token: 'provider-access-token' })
    if (url.includes('get_current_account')) {
      return Response.json({
        account_id: ACCOUNT_ID,
        email_verified: true,
        email: 'route@example.com',
        name: { display_name: 'Route User' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

beforeEach(() => {
  resetUserStore()
  stubProvider()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const cookieHeader = (pairs: Record<string, string>) =>
  Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('; ')

const setCookies = (response: Response) => response.headers.getSetCookie()
const isClearedCookie = (value: string) => /max-age=0/i.test(value) || /expires=Thu, 01 Jan 1970/i.test(value)
const cleared = (response: Response, name: string) =>
  setCookies(response).some((value) => value.startsWith(`${name}=`) && isClearedCookie(value))
const cookieValue = (response: Response, name: string) => {
  const live = setCookies(response)
    .filter((value) => value.startsWith(`${name}=`))
    .filter((value) => !isClearedCookie(value))
    .pop()
  return live ? live.split(';', 1)[0].slice(name.length + 1) : null
}

describe('dropbox sign-in start', () => {
  test('a web sign-in clears stale native markers and redirects to Dropbox', async () => {
    const response = await app.request('/auth/dropbox', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Location')).toContain('https://www.dropbox.com/oauth2/authorize')
    expect(cookieValue(response, OAUTH_STATE_COOKIE)).toBeTruthy()
    expect(cleared(response, OAUTH_NATIVE_COOKIE)).toBe(true)
    expect(cleared(response, OAUTH_NEXT_COOKIE)).toBe(true)
    expect(cleared(response, DESKTOP_CHALLENGE_COOKIE)).toBe(true)
    expect(fetchCalls).toEqual([])
  })

  test('native=1 keeps the mobile marker behaviour', async () => {
    const response = await app.request('/auth/dropbox?native=1', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('https://www.dropbox.com/oauth2/authorize')
    expect(cookieValue(response, OAUTH_NATIVE_COOKIE)).toBe('1')
    expect(cookieValue(response, DESKTOP_CHALLENGE_COOKIE)).toBeNull()
  })

  test('native=desktop stores the marker and code challenge', async () => {
    const response = await app.request(`/auth/dropbox?native=desktop&code_challenge=${RFC7636_CHALLENGE}`, {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('https://www.dropbox.com/oauth2/authorize')
    expect(cookieValue(response, OAUTH_NATIVE_COOKIE)).toBe('desktop')
    expect(cookieValue(response, DESKTOP_CHALLENGE_COOKIE)).toBe(RFC7636_CHALLENGE)
    expect(fetchCalls).toEqual([])
  })

  test('native=desktop without a valid challenge is refused before any provider work', async () => {
    for (const query of ['native=desktop', 'native=desktop&code_challenge=too-short', 'native=desktop&code_challenge=not_base64!!']) {
      const response = await app.request(`/auth/dropbox?${query}`, {}, env)
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/?error=1')
      expect(cookieValue(response, OAUTH_NATIVE_COOKIE)).toBeNull()
      expect(cookieValue(response, DESKTOP_CHALLENGE_COOKIE)).toBeNull()
    }
    expect(fetchCalls).toEqual([])
  })

  test('an unknown native value stays a plain web sign-in', async () => {
    const response = await app.request('/auth/dropbox?native=evil', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('https://www.dropbox.com/oauth2/authorize')
    expect(cookieValue(response, OAUTH_NATIVE_COOKIE)).toBeNull()
    expect(cleared(response, OAUTH_NATIVE_COOKIE)).toBe(true)
  })

  test('an external next URL is never stored', async () => {
    const response = await app.request('/auth/dropbox?next=https%3A%2F%2Fevil.example.com%2Fsteal', {}, env)
    expect(response.status).toBe(302)
    expect(cookieValue(response, OAUTH_NEXT_COOKIE)).toBeNull()
  })
})

describe('dropbox sign-in callback', () => {
  const state = 'oauth-state-1'

  test('a desktop handoff redirects to the custom scheme with a short purpose-bound token', async () => {
    const response = await app.request(`/auth/dropbox/callback?code=auth-code&state=${state}`, {
      headers: {
        Cookie: cookieHeader({
          [OAUTH_STATE_COOKIE]: state,
          [OAUTH_NATIVE_COOKIE]: 'desktop',
          [DESKTOP_CHALLENGE_COOKIE]: RFC7636_CHALLENGE,
        }),
      },
    }, env)
    expect(response.status).toBe(302)
    const location = response.headers.get('Location') ?? ''
    expect(location.startsWith(`${DESKTOP_CALLBACK}?handoff=`)).toBe(true)
    const handoff = new URL(location).searchParams.get('handoff') ?? ''
    expect(await verifyDesktopHandoffToken(handoff, TEST_SESSION_SECRET, RFC7636_VERIFIER)).toBe(ACCOUNT_ID)
    const payload = decodeJwt(handoff)
    expect(payload.typ).toBe('desktop-handoff')
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(60)
    expect(cookieValue(response, SESSION_COOKIE)).toBeTruthy()
    expect(cleared(response, OAUTH_STATE_COOKIE)).toBe(true)
    expect(cleared(response, OAUTH_NATIVE_COOKIE)).toBe(true)
    expect(cleared(response, DESKTOP_CHALLENGE_COOKIE)).toBe(true)
  })

  test('a missing or stale challenge refuses the desktop handoff', async () => {
    for (const challenge of [undefined, 'bad-challenge']) {
      resetUserStore()
      const cookies: Record<string, string> = {
        [OAUTH_STATE_COOKIE]: state,
        [OAUTH_NATIVE_COOKIE]: 'desktop',
      }
      if (challenge !== undefined) cookies[DESKTOP_CHALLENGE_COOKIE] = challenge
      const response = await app.request(`/auth/dropbox/callback?code=auth-code&state=${state}`, {
        headers: { Cookie: cookieHeader(cookies) },
      }, env)
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/?error=1')
      expect(cookieValue(response, SESSION_COOKIE)).toBeNull()
    }
    expect(fetchCalls).toEqual([])
  })

  test('a mobile handoff keeps the existing deep link', async () => {
    const response = await app.request(`/auth/dropbox/callback?code=auth-code&state=${state}`, {
      headers: {
        Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state, [OAUTH_NATIVE_COOKIE]: '1' }),
      },
    }, env)
    expect(response.status).toBe(302)
    const location = response.headers.get('Location') ?? ''
    expect(location.startsWith('in.thecontrarian.manorama://auth/callback?handoff=')).toBe(true)
    const handoff = new URL(location).searchParams.get('handoff') ?? ''
    expect(decodeJwt(handoff).typ).toBe('native-handoff')
    expect(cookieValue(response, SESSION_COOKIE)).toBeTruthy()
  })

  test('a web sign-in lands on the owner dashboard with session cookies', async () => {
    const response = await app.request(`/auth/dropbox/callback?code=auth-code&state=${state}`, {
      headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) },
    }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/route-user')
    expect(cookieValue(response, SESSION_COOKIE)).toBeTruthy()
    expect(cookieValue(response, RETURNING_COOKIE)).toBeTruthy()
    expect(cleared(response, OAUTH_STATE_COOKIE)).toBe(true)
  })

  test('a stored external next is not honoured at use time', async () => {
    const response = await app.request(`/auth/dropbox/callback?code=auth-code&state=${state}`, {
      headers: {
        Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state, [OAUTH_NEXT_COOKIE]: 'https://evil.example.com/steal' }),
      },
    }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/route-user')
  })

  test('an OAuth error clears every flow cookie', async () => {
    const response = await app.request(`/auth/dropbox/callback?error=access_denied&state=${state}`, {
      headers: {
        Cookie: cookieHeader({
          [OAUTH_STATE_COOKIE]: state,
          [OAUTH_NATIVE_COOKIE]: 'desktop',
          [DESKTOP_CHALLENGE_COOKIE]: RFC7636_CHALLENGE,
          [OAUTH_NEXT_COOKIE]: 'http://localhost/auth/dropbox',
        }),
      },
    }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(cleared(response, OAUTH_STATE_COOKIE)).toBe(true)
    expect(cleared(response, OAUTH_NATIVE_COOKIE)).toBe(true)
    expect(cleared(response, DESKTOP_CHALLENGE_COOKIE)).toBe(true)
    expect(cleared(response, OAUTH_NEXT_COOKIE)).toBe(true)
    expect(fetchCalls).toEqual([])
  })

  test('a state mismatch refuses and clears every flow cookie', async () => {
    const response = await app.request('/auth/dropbox/callback?code=auth-code&state=forged', {
      headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state, [OAUTH_NATIVE_COOKIE]: '1' }) },
    }, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?error=1')
    expect(cleared(response, OAUTH_STATE_COOKIE)).toBe(true)
    expect(cleared(response, OAUTH_NATIVE_COOKIE)).toBe(true)
    expect(fetchCalls).toEqual([])
  })
})
