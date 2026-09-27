import { createRoute } from 'honox/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { callbackUrl, fetchDropboxAccount, OAUTH_NATIVE_COOKIE, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE } from '../../../lib/dropbox-oauth'
import { upsertUser } from '../../../lib/user-repository'
import { accessEnvOf, createNativeHandoffToken, createSessionToken, RETURNING_COOKIE, RETURNING_TTL_SECONDS, SESSION_COOKIE, SESSION_TTL_SECONDS } from '../../../lib/dropbox-session'
import { createDesktopHandoffToken, DESKTOP_CALLBACK, DESKTOP_CHALLENGE_COOKIE, isDesktopChallenge } from '../../../lib/desktop-auth'

export default createRoute(async (c) => {
  c.header('Cache-Control', 'no-store')
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const expectedState = getCookie(c, OAUTH_STATE_COOKIE)
  const native = getCookie(c, OAUTH_NATIVE_COOKIE)
  const codeChallenge = getCookie(c, DESKTOP_CHALLENGE_COOKIE)
  const next = getCookie(c, OAUTH_NEXT_COOKIE)
  const clearOauthCookies = () => {
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' })
    deleteCookie(c, OAUTH_NATIVE_COOKIE, { path: '/' })
    deleteCookie(c, DESKTOP_CHALLENGE_COOKIE, { path: '/' })
    deleteCookie(c, OAUTH_NEXT_COOKIE, { path: '/' })
  }
  if (oauthError || !code || !state || !expectedState || state !== expectedState) {
    clearOauthCookies()
    return c.redirect('/?error=1')
  }
  try {
    clearOauthCookies()
    if (native === 'desktop' && !isDesktopChallenge(codeChallenge)) return c.redirect('/?error=1')
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
    // Outlives the session: a signed-in-here-before hint for the landing CTA.
    setCookie(c, RETURNING_COOKIE, '1', {
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: RETURNING_TTL_SECONDS,
    })
    if (native === 'desktop') {
      if (!isDesktopChallenge(codeChallenge)) return c.redirect('/?error=1')
      const handoff = await createDesktopHandoffToken(user.dropboxAccountId, secret, codeChallenge)
      return c.redirect(`${DESKTOP_CALLBACK}?handoff=${encodeURIComponent(handoff)}`)
    }
    if (native === '1') {
      const handoff = await createNativeHandoffToken(user.dropboxAccountId, secret)
      return c.redirect(`in.thecontrarian.manorama://auth/callback?handoff=${encodeURIComponent(handoff)}`)
    }
    if (next) {
      try {
        if (new URL(next).origin === url.origin) return c.redirect(next)
      } catch { /* fall through to the dashboard */ }
    }
    return c.redirect(`/${user.ownerSlug}`)
  } catch {
    return c.redirect('/?error=1')
  }
})
