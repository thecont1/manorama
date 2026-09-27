import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import type { IdentityInput } from './identity-repository'

export type AuthorizationInput = {
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
}

export type CodeExchangeInput = {
  redirectUri: string
  code: string
  nonce: string
  codeVerifier: string
  user?: unknown
}

export type ProviderIdentityResult = {
  identity: IdentityInput
  refreshToken?: string
}

export type OidcDependencies = {
  fetch?: typeof fetch
  keyResolver?: JWTVerifyGetKey
}

const FETCH_TIMEOUT_MS = 10_000

const VERIFY_ERROR = 'Sign-in could not be verified'
const EXCHANGE_ERROR = 'Sign-in could not be completed'

export const isAuthorizationCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value)

export const validRedirectUri = (redirectUri: string, allowLoopbackHttp = false) => {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  if (url.protocol === 'https:') return true
  return allowLoopbackHttp && url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

const remoteResolvers = new Map<string, JWTVerifyGetKey>()
export const remoteKeyResolver = (jwksUrl: string): JWTVerifyGetKey => {
  let resolver = remoteResolvers.get(jwksUrl)
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: FETCH_TIMEOUT_MS })
    remoteResolvers.set(jwksUrl, resolver)
  }
  return resolver
}

export const verifyOidcToken = async (
  token: string,
  keyResolver: JWTVerifyGetKey,
  expected: { issuer: string | string[]; clientId: string; nonce: string },
): Promise<JWTPayload> => {
  const nonce = expected.nonce
  if (typeof nonce !== 'string' || !nonce.trim()) throw new Error(VERIFY_ERROR)
  const { payload } = await jwtVerify(token, keyResolver, {
    algorithms: ['RS256'],
    issuer: expected.issuer,
    audience: expected.clientId,
    requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'],
  })
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 1024
    || payload.nonce !== nonce
    || typeof payload.iat !== 'number' || payload.iat > Math.floor(Date.now() / 1000) + 60
    || (payload.azp !== undefined && payload.azp !== expected.clientId)
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== expected.clientId)) {
    throw new Error(VERIFY_ERROR)
  }
  return payload
}

export const verifiedEmailClaim = (payload: JWTPayload): string | undefined => {
  if (payload.email_verified !== true && payload.email_verified !== 'true') return undefined
  if (typeof payload.email !== 'string') return undefined
  const email = payload.email.trim()
  return email && email.length <= 320 ? email : undefined
}

export const boundedName = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim().slice(0, 120)
  return trimmed || undefined
}

export const exchangeOidcCode = async (
  tokenUrl: string,
  form: URLSearchParams,
  fetcher: typeof fetch = fetch,
): Promise<{ idToken: string; refreshToken?: string }> => {
  const response = await fetcher(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(EXCHANGE_ERROR)
  const json = await response.json().catch(() => null)
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(EXCHANGE_ERROR)
  const { id_token: idToken, refresh_token: refreshToken } = json as {
    id_token?: unknown
    refresh_token?: unknown
  }
  if (typeof idToken !== 'string' || !idToken) throw new Error(EXCHANGE_ERROR)
  return {
    idToken,
    ...(typeof refreshToken === 'string' && refreshToken ? { refreshToken } : {}),
  }
}
