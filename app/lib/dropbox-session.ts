import { jwtVerify, SignJWT } from 'jose'
import type { MiddlewareHandler } from 'hono'
import { getUserByDropboxId, type UserRepositoryEnv } from './user-repository'

/**
 * Manorama's session layer. A Dropbox OAuth sign-in mints an HS256 JWT
 * (signed with HOST_API_JWT_SECRET) into the `manorama_session` cookie.
 * The token carries only the immutable Dropbox account ID as `sub`;
 * everything user-visible (owner slug, tier) is loaded fresh from the
 * user repository on every request, so a slug or tier change applies
 * immediately without re-issuing cookies.
 */

export const SESSION_COOKIE = 'manorama_session'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export type ManoramaSession = {
  /** Stable principal: the Dropbox account ID, never an email. */
  id: `dropbox:${string}`
  /** The raw Dropbox account ID — the repository owner key. */
  dropboxAccountId: string
  ownerSlug: string
  name: string
  email?: string
  tier: 'free'
}

export type SessionEnv = {
  HOST_API_JWT_SECRET?: string
} & UserRepositoryEnv

/** Hono env for routes that read the session variable and the session
 * bindings (secret + D1). */
export type HonoSessionEnv = {
  Variables: { manoramaSession: ManoramaSession }
  Bindings: SessionEnv
}

const sessionKey = (secret: string) => new TextEncoder().encode(secret)

/** Signs a session token for a Dropbox account ID. */
export const createSessionToken = (dropboxAccountId: string, secret: string) =>
  new SignJWT({ sub: dropboxAccountId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionKey(secret))

const verifySessionToken = async (token: string, secret: string) => {
  const { payload } = await jwtVerify(token, sessionKey(secret))
  return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
}

const cookieValue = (request: Request, name: string) => {
  const cookie = request.headers.get('Cookie')
  if (!cookie) return undefined
  for (const part of cookie.split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0) continue
    if (part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim()
  }
  return undefined
}

/** process.env when the runtime has one (Node/vite dev); never carries
 *  anything on Workers, where c.env bindings are authoritative. */
const processEnv = () => (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {}

export const accessEnvOf = (c: { env: unknown }): SessionEnv => ({
  ...processEnv(),
  ...((c.env ?? {}) as SessionEnv),
})

/**
 * Resolves the signed-in user for a request, or null when the request
 * carries no trustworthy identity. Fail-closed by design: a missing
 * secret, missing cookie, invalid/expired token, or a deleted account
 * all resolve to null.
 */
export async function resolveManoramaSession(
  request: Request,
  env: SessionEnv,
): Promise<ManoramaSession | null> {
  const secret = env.HOST_API_JWT_SECRET?.trim()
  if (!secret) return null
  const token = cookieValue(request, SESSION_COOKIE)
  if (!token) return null
  let dropboxAccountId: string | null
  try {
    dropboxAccountId = await verifySessionToken(token, secret)
  } catch {
    return null
  }
  if (!dropboxAccountId) return null
  const user = await getUserByDropboxId(dropboxAccountId, env)
  if (!user) return null
  const session: ManoramaSession = {
    id: `dropbox:${user.dropboxAccountId}`,
    dropboxAccountId: user.dropboxAccountId,
    ownerSlug: user.ownerSlug,
    name: user.displayName,
    tier: user.tier,
  }
  if (user.email) session.email = user.email
  return session
}

/**
 * The management-API gate: resolves the session and refuses the request
 * with 401 JSON when there is none. On success the session is available
 * to later handlers as `c.get('manoramaSession')`. One boundary for the
 * whole route group — no per-handler auth checks.
 */
export const requireSession = (): MiddlewareHandler<HonoSessionEnv> =>
  async (c, next) => {
    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    c.set('manoramaSession', session)
    await next()
  }
