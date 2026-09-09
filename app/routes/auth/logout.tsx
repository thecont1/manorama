import { deleteCookie } from 'hono/cookie'
import { SESSION_COOKIE } from '../../lib/dropbox-session'

const signOut = (c: Parameters<typeof deleteCookie>[0]) => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  return c.redirect('/')
}

// honox registers a default export as GET only, and method exports as
// handler arrays; the dashboard's sign-out form posts, so both verbs
// point at the same handler.
export const GET = [signOut]
export const POST = [signOut]
