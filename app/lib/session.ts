import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose'
import { exportJWK as joseExportJWK } from 'jose/key/export'
import type { JSONWebKeySet } from 'jose'
import type { MiddlewareHandler } from 'hono'

/**
 * Manorama's single owner-identity resolver: Cloudflare Access.
 *
 * Access authenticates the visitor in front of the origin and attaches a
 * signed RS256 JWT (`Cf-Access-Jwt-Assertion` header, or the
 * `CF_Authorization` cookie). Verification here checks issuer, audience,
 * signature, expiry/not-before, and the immutable `sub` claim — anything
 * else (anonymous, malformed, expired, mis-signed, wrong application)
 * resolves to null and callers must refuse the request.
 */
export type ManoramaSession = {
  /** Stable identity: the Access token's immutable subject, never an email. */
  id: `cf-access:${string}`
  /** Verified email claim, only when the token carries a non-empty one. */
  email?: string
}

export type AccessEnv = {
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  /** The owner slug that the admin gate locks behind Access auth. Falls back
   *  to 'thecontrarian' when unset. */
  OWNER_SLUG?: string
  /** Dev/test-only: an inline JWKS document verified instead of the team's
   *  remote certs endpoint — local development and Playwright fixtures have
   *  no Cloudflare Access in front of them. Every check (issuer, audience,
   *  signature, expiry, sub) is identical; production never sets this. */
  CF_ACCESS_JWKS?: string
}

/** Verifies an Access JWT against expected issuer/audience and returns its
 *  claims. Throws on any failure — callers translate that to null. */
export type AccessJwtVerifier = (
  token: string,
  checks: { issuer: string; audience: string },
) => Promise<{ sub?: unknown; email?: unknown }>

export const accessIssuer = (teamDomain: string) => `https://${teamDomain}.cloudflareaccess.com`
export const accessJwksUrl = (issuer: string) => `${issuer.replace(/\/+$/, '')}/cdn-cgi/access/certs`

type KeySource = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>

const jwksClients = new Map<string, KeySource>()

/** The remote JWKS client for one Access team, cached per issuer. Only this
 *  crypto helper is cached — never a request, session, or user. */
export const cachedJwksClient = (issuer: string) => {
  let client = jwksClients.get(issuer)
  if (!client) {
    client = createRemoteJWKSet(new URL(accessJwksUrl(issuer)))
    jwksClients.set(issuer, client)
  }
  return client
}

/** Test seam: export a CryptoKey's public JWK (for building inline dev/test
 *  JWKS documents). Production code never calls this. */
export const exportPublicJwk = (key: CryptoKey) => joseExportJWK(key)

/** Test seam: drop the JWKS cache. Production code never calls this. */
export const resetAccessJwksCache = () => jwksClients.clear()

const verifierWith = (keys: KeySource): AccessJwtVerifier => (token, { issuer, audience }) =>
  jwtVerify(token, keys, { issuer, audience })
    .then(({ payload }) => payload as { sub?: unknown; email?: unknown })

const remoteVerifier = (issuer: string) => verifierWith(cachedJwksClient(issuer))

/** The verifier for one environment: the inline dev JWKS when configured,
 *  the team's remote JWKS otherwise. Null when the inline document is
 *  malformed — fail closed. */
const verifierForEnv = (env: AccessEnv, issuer: string): AccessJwtVerifier | null => {
  const inline = env.CF_ACCESS_JWKS?.trim()
  if (!inline) return remoteVerifier(issuer)
  let client = jwksClients.get(inline)
  if (client === undefined) {
    try {
      client = createLocalJWKSet(JSON.parse(inline) as JSONWebKeySet)
    } catch {
      return null
    }
    jwksClients.set(inline, client)
  }
  return verifierWith(client)
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

/** The raw Access JWT: the per-request assertion header first, then the
 *  browser cookie. Both are verified through the exact same path. */
export const accessAssertion = (request: Request) =>
  request.headers.get('Cf-Access-Jwt-Assertion')?.trim() || cookieValue(request, 'CF_Authorization') || undefined

/**
 * Resolves the Cloudflare Access session for a request, or null when the
 * request carries no trustworthy owner identity. Fail-closed by design:
 * missing configuration, missing token, or any verification failure is null.
 */
export async function resolveManoramaSession(
  request: Request,
  env: AccessEnv,
  verifier?: AccessJwtVerifier,
): Promise<ManoramaSession | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim()
  const audience = env.CF_ACCESS_AUD?.trim()
  if (!teamDomain || !audience) return null
  const token = accessAssertion(request)
  if (!token) return null
  const issuer = accessIssuer(teamDomain)
  const effectiveVerifier = verifier ?? verifierForEnv(env, issuer)
  if (effectiveVerifier === null) return null
  try {
    const claims = await effectiveVerifier(token, { issuer, audience })
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null
    const session: ManoramaSession = { id: `cf-access:${claims.sub}` }
    if (typeof claims.email === 'string' && claims.email.length > 0) session.email = claims.email
    return session
  } catch {
    return null
  }
}

/** Hono env shape once the session gate below has run. */
export type SessionEnv = { Variables: { manoramaSession: ManoramaSession } }

/** process.env when the runtime has one (Node/vite dev); never carries
 *  anything on Workers, where c.env bindings are authoritative. */
const processEnv = () => (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {}

/** The Access configuration for a request: platform env wins, process env is
 *  the dev-server fallback. */
export const accessEnvOf = (c: { env: unknown }): AccessEnv => ({
  ...processEnv(),
  ...((c.env ?? {}) as AccessEnv),
})

/**
 * The management-API gate: resolves the Access session and refuses the
 * request with 401 JSON when there is none. On success the session is
 * available to later handlers as `c.get('manoramaSession')`. One boundary
 * for the whole route group — no per-handler auth checks.
 */
export const requireSession = (verifier?: AccessJwtVerifier): MiddlewareHandler<SessionEnv> =>
  async (c, next) => {
    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c), verifier)
    if (!session) return c.json({ error: 'Authentication required' }, 401)
    c.set('manoramaSession', session)
    await next()
  }

