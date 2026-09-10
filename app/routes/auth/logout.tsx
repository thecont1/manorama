import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '../../lib/dropbox-session'

const signOut = (c: Parameters<typeof deleteCookie>[0]) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.redirect('/')
}

// The dashboard's sign-out form posts here; method exports are handler
// arrays in honox.
export const POST = [signOut]
