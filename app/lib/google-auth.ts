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

export type GoogleAuthEnv = {
  GOOGLE_AUTH_CLIENT_ID?: string
  GOOGLE_AUTH_CLIENT_SECRET?: string
}

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

const configured = (env: GoogleAuthEnv) =>
  Boolean(env.GOOGLE_AUTH_CLIENT_ID?.trim() && env.GOOGLE_AUTH_CLIENT_SECRET?.trim())

export const googleAuthorizeUrl = (input: AuthorizationInput, env: GoogleAuthEnv): string => {
  if (!configured(env)) throw new Error('Google sign-in is not configured')
  if (!input.state.trim() || !input.nonce.trim() || !validRedirectUri(input.redirectUri, true)
    || !CHALLENGE_PATTERN.test(input.codeChallenge)) {
    throw new Error('Invalid sign-in request')
  }
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', env.GOOGLE_AUTH_CLIENT_ID!)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export const fetchGoogleIdentity = async (
  input: CodeExchangeInput,
  env: GoogleAuthEnv,
  deps: OidcDependencies = {},
): Promise<ProviderIdentityResult> => {
  if (!configured(env)) throw new Error('Google sign-in is not configured')
  if (!isAuthorizationCode(input.code) || !VERIFIER_PATTERN.test(input.codeVerifier)
    || !input.nonce.trim() || !validRedirectUri(input.redirectUri, true)) {
    throw new Error('Google sign-in could not be completed')
  }
  const tokens = await exchangeOidcCode(GOOGLE_TOKEN_URL, new URLSearchParams({
    code: input.code,
    client_id: env.GOOGLE_AUTH_CLIENT_ID!,
    client_secret: env.GOOGLE_AUTH_CLIENT_SECRET!,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
  }), deps.fetch)
  const payload = await verifyOidcToken(
    tokens.idToken,
    deps.keyResolver ?? remoteKeyResolver(GOOGLE_JWKS_URL),
    { issuer: GOOGLE_ISSUERS, clientId: env.GOOGLE_AUTH_CLIENT_ID!, nonce: input.nonce },
  )
  const identity: IdentityInput = { provider: 'google', subject: payload.sub! }
  const email = verifiedEmailClaim(payload)
  if (email) identity.email = email
  const name = boundedName(payload.name)
  if (name) identity.displayName = name
  return { identity }
}
