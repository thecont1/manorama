import { createRoute } from 'honox/factory'
import { deleteCookie, setCookie } from 'hono/cookie'
import { callbackUrl, dropboxAuthorizeUrl, newState, OAUTH_NATIVE_COOKIE, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE, type DropboxOauthEnv } from '../../lib/dropbox-oauth'
import { accessEnvOf } from '../../lib/dropbox-session'
import { DESKTOP_CHALLENGE_COOKIE, isDesktopChallenge } from '../../lib/desktop-auth'

export default createRoute((c) => {
  try {
    c.header('Cache-Control', 'no-store')
    deleteCookie(c, OAUTH_NATIVE_COOKIE, { path: '/' })
    deleteCookie(c, OAUTH_NEXT_COOKIE, { path: '/' })
    deleteCookie(c, DESKTOP_CHALLENGE_COOKIE, { path: '/' })
    const state = newState()
    const cookieOpts = {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax' as const,
      path: '/',
      maxAge: 600,
    }
    setCookie(c, OAUTH_STATE_COOKIE, state, cookieOpts)
    const native = c.req.query('native')
    if (native === '1') {
      setCookie(c, OAUTH_NATIVE_COOKIE, '1', cookieOpts)
    } else if (native === 'desktop') {
      const codeChallenge = c.req.query('code_challenge')
      if (!isDesktopChallenge(codeChallenge)) return c.redirect('/?error=1')
      setCookie(c, OAUTH_NATIVE_COOKIE, 'desktop', cookieOpts)
      setCookie(c, DESKTOP_CHALLENGE_COOKIE, codeChallenge, cookieOpts)
    }
    const next = c.req.query('next')
    if (next) {
      try {
        if (new URL(next).origin === new URL(c.req.url).origin) {
          setCookie(c, OAUTH_NEXT_COOKIE, next, cookieOpts)
        }
      } catch { /* ignore malformed next */ }
    }
    return c.redirect(dropboxAuthorizeUrl(callbackUrl(c.req.raw), state, accessEnvOf(c) as DropboxOauthEnv))
  } catch {
    return c.redirect('/?error=1')
  }
})
