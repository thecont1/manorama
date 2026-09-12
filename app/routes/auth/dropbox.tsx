import { createRoute } from 'honox/factory'
import { setCookie } from 'hono/cookie'
import { callbackUrl, dropboxAuthorizeUrl, newState, OAUTH_NEXT_COOKIE, OAUTH_STATE_COOKIE, type DropboxOauthEnv } from '../../lib/dropbox-oauth'
import { accessEnvOf } from '../../lib/dropbox-session'

export default createRoute((c) => {
  try {
    const state = newState()
    const cookieOpts = {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax' as const,
      path: '/',
      maxAge: 600,
    }
    setCookie(c, OAUTH_STATE_COOKIE, state, cookieOpts)
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
