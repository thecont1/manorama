import { jwtVerify, SignJWT } from 'jose'
import type { MiddlewareHandler } from 'hono'
import { getUserByAccountId, type UserRepositoryEnv } from './user-repository'

/**
 * Manorama's session layer. A Dropbox OAuth sign-in mints an HS256 JWT
 * (signed with HOST_API_JWT_SECRET) into the `manorama_session` cookie.
 * The token carries only the immutable account ID as `sub`;
 * everything user-visible (owner slug, tier) is loaded fresh from the
 * user repository on every request, so a slug or tier change applies
 * immediately without re-issuing cookies.
 *
 * The signing secret must be at least 32 bytes in UTF-8 — generate it
 * with a CSPRNG (e.g. `openssl rand -hex 32`). Shorter values are rejected
 * to prevent weak-key JWT signing.
 */

export const SESSION_COOKIE = 'manorama_session'
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
export const NATIVE_HANDOFF_TTL_SECONDS = 60

/** Long-lived marker set after a successful OAuth callback so the landing
 * page can greet returning visitors with "Sign in" instead of the generic
 * "Sign Up or Sign In" copy. It is only a UX hint — never auth. */
export const RETURNING_COOKIE = 'manorama_returning'
export const RETURNING_TTL_SECONDS = 365 * 24 * 60 * 60

export type ManoramaSession = {
  /** Stable principal: the account ID, never an email. */
  id: `account:${string}`
  /** The raw account ID — the repository owner key. */
  accountId: string
  ownerSlug: string
  name: string
  email?: string
  tier: 'free' | 'pro'
}

export type SessionEnv = {
  HOST_API_JWT_SECRET?: string
  /** Legacy immutable account ID allowed to use the private operations console. */
  MASTER_ACCOUNT_ID?: string
  /** Immutable Dropbox subject allowed to use the private operations console. */
  MASTER_DROPBOX_SUBJECT?: string
} & UserRepositoryEnv

/** Hono env for routes that read the session variable and the session
 * bindings (secret + D1). */
export type HonoSessionEnv = {
  Variables: { manoramaSession: ManoramaSession }
  Bindings: SessionEnv
}

const MIN_SECRET_BYTES = 32

/** Encodes the signing secret, rejecting values whose UTF-8 encoding is
 *  shorter than 32 bytes. Both signing and verification use this gate so
 *  a weak secret fails consistently rather than silently. Exported for the
 *  sibling token minters in desktop-auth, which share the same key. */
export const sessionKey = (secret: string) => {
  const trimmed = secret.trim()
  const bytes = new TextEncoder().encode(trimmed)
  if (bytes.length < MIN_SECRET_BYTES) {
    throw new Error(`HOST_API_JWT_SECRET must be at least ${MIN_SECRET_BYTES} bytes`)
  }
  return bytes
}

/** Signs a session token for an account ID. */
export const createSessionToken = (accountId: string, secret: string) =>
  new SignJWT({ sub: accountId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionKey(secret))

/** A one-minute, purpose-bound token that is safe to carry through the native
 * custom URL scheme. It is exchanged for the normal bearer session over HTTPS;
 * the long-lived session token never appears in the deep link. */
export const createNativeHandoffToken = (accountId: string, secret: string) =>
  new SignJWT({ sub: accountId, typ: 'native-handoff' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${NATIVE_HANDOFF_TTL_SECONDS}s`)
    .sign(sessionKey(secret))

export const verifyNativeHandoffToken = async (token: string, secret: string) => {
  const { payload } = await jwtVerify(token, sessionKey(secret), { algorithms: ['HS256'] })
  if (payload.typ !== 'native-handoff') return null
  return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
}

const verifySessionToken = async (token: string, secret: string) => {
  const { payload } = await jwtVerify(token, sessionKey(secret), { algorithms: ['HS256'] })
  if (payload.typ !== undefined) return null
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

const bearerValue = (request: Request) => {
  const authorization = request.headers.get('Authorization')
  if (!authorization) return undefined
  const match = authorization.match(/^Bearer[ \t]+(.+)/i)
  return match?.[1].trim() || undefined
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
  const token = request.headers.get('Authorization') !== null
    ? bearerValue(request)
    : cookieValue(request, SESSION_COOKIE)
  if (!token) return null
  let accountId: string | null
  try {
    accountId = await verifySessionToken(token, secret)
  } catch {
    return null
  }
  if (!accountId) return null
  const user = await getUserByAccountId(accountId, env)
  if (!user) return null
  const session: ManoramaSession = {
    id: `account:${user.accountId}`,
    accountId: user.accountId,
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

/** Master controls bind to an immutable provider subject, never to an editable
 * slug, display name, or password. The legacy account-ID binding remains only
 * so existing deployments do not lose access during the one-time migration.
 * Missing configuration or identity storage fails closed. */
export const isMasterAccount = async (session: Pick<ManoramaSession, 'accountId'>, env: SessionEnv): Promise<boolean> => {
  const masterAccountId = env.MASTER_ACCOUNT_ID?.trim()
  if (masterAccountId && session.accountId === masterAccountId) return true

  const dropboxSubject = env.MASTER_DROPBOX_SUBJECT?.trim()
  if (!dropboxSubject || !env.DB) return false
  try {
    const row = await env.DB
      .prepare('SELECT account_id FROM auth_identities WHERE provider = ? AND provider_subject = ?')
      .bind('dropbox', dropboxSubject)
      .first<{ account_id: string }>()
    return row?.account_id === session.accountId
  } catch {
    return false
  }
}

export const requireMasterSession = (): MiddlewareHandler<HonoSessionEnv> =>
  async (c, next) => {
    const env = accessEnvOf(c)
    const session = await resolveManoramaSession(c.req.raw, env)
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    if (!(await isMasterAccount(session, env))) return c.json({ error: 'Master access required' }, 403)
    c.set('manoramaSession', session)
    await next()
  }
