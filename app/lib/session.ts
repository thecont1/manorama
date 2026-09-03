import { createRemoteJWKSet, jwtVerify } from 'jose'

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
}

/** Verifies an Access JWT against expected issuer/audience and returns its
 *  claims. Throws on any failure — callers translate that to null. */
export type AccessJwtVerifier = (
  token: string,
  checks: { issuer: string; audience: string },
) => Promise<{ sub?: unknown; email?: unknown }>

export const accessIssuer = (teamDomain: string) => `https://${teamDomain}.cloudflareaccess.com`
export const accessJwksUrl = (issuer: string) => `${issuer.replace(/\/+$/, '')}/cdn-cgi/access/certs`

const jwksClients = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

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

/** Test seam: drop the JWKS cache. Production code never calls this. */
export const resetAccessJwksCache = () => jwksClients.clear()

const defaultVerifier: AccessJwtVerifier = (token, { issuer, audience }) =>
  jwtVerify(token, cachedJwksClient(issuer), { issuer, audience })
    .then(({ payload }) => payload as { sub?: unknown; email?: unknown })

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
  verifier: AccessJwtVerifier = defaultVerifier,
): Promise<ManoramaSession | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim()
  const audience = env.CF_ACCESS_AUD?.trim()
  if (!teamDomain || !audience) return null
  const token = accessAssertion(request)
  if (!token) return null
  const issuer = accessIssuer(teamDomain)
  try {
    const claims = await verifier(token, { issuer, audience })
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null
    const session: ManoramaSession = { id: `cf-access:${claims.sub}` }
    if (typeof claims.email === 'string' && claims.email.length > 0) session.email = claims.email
    return session
  } catch {
    return null
  }
}
