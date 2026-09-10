import { createRoute } from 'honox/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { callbackUrl, fetchDropboxAccount, OAUTH_STATE_COOKIE } from '../../../lib/dropbox-oauth'
import { upsertUser } from '../../../lib/user-repository'
import { accessEnvOf, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../../../lib/dropbox-session'

export default createRoute(async (c) => {
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE)
  if (oauthError || !code || !state || !expectedState || state !== expectedState) {
    return c.redirect('/?error=1')
  }
  try {
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' })
    const secret = accessEnvOf(c).HOST_API_JWT_SECRET?.trim()
    if (!secret) return c.redirect('/?error=1')
    const account = await fetchDropboxAccount(code, callbackUrl(c.req.raw), accessEnvOf(c) as Parameters<typeof fetchDropboxAccount>[2])
    const user = await upsertUser(account, accessEnvOf(c) as Parameters<typeof upsertUser>[1])
    const token = await createSessionToken(user.dropboxAccountId, secret)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })
    return c.redirect(`/${user.ownerSlug}`)
  } catch {
    return c.redirect('/?error=1')
  }
})
