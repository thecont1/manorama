import type { MiddlewareHandler } from 'hono'
import { accessEnvOf, requireSession, type AccessJwtVerifier } from './session'

/**
 * Guards the owner administration page (`/[owner]`) with the same Access
 * session gate as the management API, while leaving every other
 * single-segment path (public gallery slugs, assets) untouched. The page
 * handler additionally fails closed when no session was resolved.
 */
export const ownerAdminGate = (verifier?: AccessJwtVerifier): MiddlewareHandler =>
  async (c, next) => {
    const owner = c.req.param('owner')
    const expected = accessEnvOf(c).OWNER_SLUG || 'thecontrarian'
    if (owner === expected) return requireSession(verifier)(c, next)
    await next()
  }
