import { deleteCookie } from 'hono/cookie'
import { accessEnvOf, SESSION_COOKIE } from '../../lib/session'
import { sessionCookieDomain } from '../../lib/signin-host'

const signOut = (c: Parameters<typeof deleteCookie>[0]) => {
  // The session cookie is Domain-scoped when the sign-in host is
  // configured — the delete must carry the same Domain or it only clears
  // a host-only shadow and the real cookie survives.
  const domain = sessionCookieDomain(accessEnvOf(c))
  deleteCookie(c, SESSION_COOKIE, { path: '/', ...(domain ? { domain } : {}) })
  return c.redirect('/')
}

// The dashboard's sign-out form posts here; method exports are handler
// arrays in honox.
export const POST = [signOut]
