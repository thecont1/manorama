import { importPKCS8, SignJWT } from 'jose'
import type { IdentityInput } from './identity-repository'
import {
  boundedName,
  exchangeOidcCode,
  isAuthorizationCode,
  remoteKeyResolver,
  validRedirectUri,
  verifiedEmailClaim,
  verifyOidcToken,
  type AuthorizationInput,
  type CodeExchangeInput,
  type OidcDependencies,
  type ProviderIdentityResult,
} from './oidc'

export type AppleAuthEnv = {
  APPLE_CLIENT_ID?: string
  APPLE_TEAM_ID?: string
  APPLE_KEY_ID?: string
  APPLE_PRIVATE_KEY?: string
}

const APPLE_ISSUER = 'https://appleid.apple.com'
const APPLE_AUTHORIZE_URL = `${APPLE_ISSUER}/auth/authorize`
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`

const USER_JSON_MAX = 8_192

const configured = (env: AppleAuthEnv) =>
  Boolean(env.APPLE_CLIENT_ID?.trim() && env.APPLE_TEAM_ID?.trim()
    && env.APPLE_KEY_ID?.trim() && env.APPLE_PRIVATE_KEY?.trim())

export const createAppleClientSecret = async (env: AppleAuthEnv): Promise<string> => {
  if (!configured(env)) throw new Error('Apple sign-in is not configured')
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY!, 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID! })
    .setIssuer(env.APPLE_TEAM_ID!)
    .setSubject(env.APPLE_CLIENT_ID!)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

export const appleAuthorizeUrl = (input: AuthorizationInput, env: AppleAuthEnv): string => {
  if (!configured(env)) throw new Error('Apple sign-in is not configured')
  if (!input.state.trim() || !input.nonce.trim() || !validRedirectUri(input.redirectUri)) {
    throw new Error('Invalid sign-in request')
  }
  const url = new URL(APPLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', env.APPLE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'name email')
  url.searchParams.set('response_mode', 'form_post')
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  return url.toString()
}

const appleUserName = (user: unknown): string | undefined => {
  let parsed: unknown = user
  if (typeof user === 'string') {
    if (user.length > USER_JSON_MAX) return undefined
    try {
      parsed = JSON.parse(user)
    } catch {
      return undefined
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const name = (parsed as { name?: unknown }).name
  if (!name || typeof name !== 'object' || Array.isArray(name)) return undefined
  const { firstName, lastName } = name as { firstName?: unknown; lastName?: unknown }
  const joined = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
  return boundedName(joined)
}

export const fetchAppleIdentity = async (
  input: CodeExchangeInput,
  env: AppleAuthEnv,
  deps: OidcDependencies = {},
): Promise<ProviderIdentityResult> => {
  if (!configured(env)) throw new Error('Apple sign-in is not configured')
  if (!isAuthorizationCode(input.code) || !input.nonce.trim()
    || !validRedirectUri(input.redirectUri)) {
    throw new Error('Apple sign-in could not be completed')
  }
  const clientSecret = await createAppleClientSecret(env)
  const tokens = await exchangeOidcCode(APPLE_TOKEN_URL, new URLSearchParams({
    code: input.code,
    client_id: env.APPLE_CLIENT_ID!,
    client_secret: clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  }), deps.fetch)
  const payload = await verifyOidcToken(
    tokens.idToken,
    deps.keyResolver ?? remoteKeyResolver(APPLE_JWKS_URL),
    { issuer: APPLE_ISSUER, clientId: env.APPLE_CLIENT_ID!, nonce: input.nonce },
  )
  const identity: IdentityInput = { provider: 'apple', subject: payload.sub! }
  const email = verifiedEmailClaim(payload)
  if (email) identity.email = email
  const name = appleUserName(input.user)
  if (name) identity.displayName = name
  return {
    identity,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  }
}
