import { createRoute } from 'honox/factory'
import { setCookie } from 'hono/cookie'
import { callbackUrl, dropboxAuthorizeUrl, newState, OAUTH_STATE_COOKIE, type DropboxOauthEnv } from '../../lib/dropbox-oauth'

export default createRoute((c) => {
  try {
    const state = newState()
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    })
    return c.redirect(dropboxAuthorizeUrl(callbackUrl(c.req.raw), state, (c.env ?? {}) as DropboxOauthEnv))
  } catch {
    return c.redirect('/?error=1')
  }
})
