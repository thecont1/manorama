import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { consumeAuthFlow, createAuthFlow, pkceChallenge, type AuthFlow } from './auth-flows'
import { appleAuthorizeUrl, fetchAppleIdentity, type AppleAuthEnv } from './apple-auth'
import { createDesktopHandoffToken, DESKTOP_CALLBACK } from './desktop-auth'
import { dropboxAuthorizeUrl, fetchDropboxAccount, type DropboxOauthEnv } from './dropbox-oauth'
import { fetchGoogleIdentity, googleAuthorizeUrl, type GoogleAuthEnv } from './google-auth'
import {
  IdentityConflictError,
  IdentityStorageUnavailableError,
  linkIdentity,
  upsertIdentitySignIn,
  type AuthProvider,
  type IdentityInput,
} from './identity-repository'
import type { OidcDependencies } from './oidc'
import {
  accessEnvOf,
  createNativeHandoffToken,
  createSessionToken,
  resolveManoramaSession,
  RETURNING_COOKIE,
  RETURNING_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './session'
import { setLastSeenCountry } from './user-repository'

/**
 * The shared halves of the /auth/{provider} routes. All three providers
 * run the same transaction: `startProviderAuth` opens an auth_flows row
 * and redirects to the provider; `finishProviderAuth` consumes the row
 * (single-use, before any provider call), verifies the identity, and
 * lands on a session cookie, a native/desktop handoff, or an error
 * redirect. Nothing about the flow rides in cookies, so Apple's
 * cross-site form_post works unchanged.
 */

const NATIVE_CALLBACK = 'in.thecontrarian.manorama://auth/callback'

type ProviderEnv = DropboxOauthEnv & GoogleAuthEnv & AppleAuthEnv

const callbackUri = (provider: AuthProvider, requestUrl: string) =>
  new URL(`/auth/${provider}/callback`, requestUrl).toString()

const authorizeUrl = async (
  provider: AuthProvider,
  flow: { state: string; nonce: string; codeVerifier?: string },
  redirectUri: string,
  env: ProviderEnv,
): Promise<string> => {
  switch (provider) {
    case 'dropbox':
      return dropboxAuthorizeUrl(redirectUri, flow.state, env)
    case 'google':
      return googleAuthorizeUrl({
        redirectUri,
        state: flow.state,
        nonce: flow.nonce,
        codeChallenge: await pkceChallenge(flow.codeVerifier!),
      }, env)
    case 'apple':
      // Apple's authorize request uses response_mode form_post and no PKCE.
      return appleAuthorizeUrl({ redirectUri, state: flow.state, nonce: flow.nonce, codeChallenge: '' }, env)
  }
}

const fetchIdentity = async (
  provider: AuthProvider,
  flow: AuthFlow,
  exchange: { redirectUri: string; code: string; user?: unknown },
  env: ProviderEnv,
  deps: OidcDependencies,
): Promise<IdentityInput> => {
  switch (provider) {
    case 'dropbox': {
      const account = await fetchDropboxAccount(exchange.code, exchange.redirectUri, env, deps.fetch)
      const identity: IdentityInput = {
        provider: 'dropbox',
        subject: account.dropboxAccountId,
        displayName: account.displayName,
      }
      if (account.email) identity.email = account.email
      return identity
    }
    case 'google':
      return (await fetchGoogleIdentity({
        redirectUri: exchange.redirectUri,
        code: exchange.code,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier ?? '',
      }, env, deps)).identity
    case 'apple':
      // Apple's refresh token is deliberately discarded here — there is no
      // encrypted revocation store yet, so keeping it would be all risk.
      return (await fetchAppleIdentity({
        redirectUri: exchange.redirectUri,
        code: exchange.code,
        nonce: flow.nonce,
        codeVerifier: '',
        user: exchange.user,
      }, env, deps)).identity
  }
}

/**
 * GET /auth/{provider}: opens a flow and redirects to the provider's
 * authorize endpoint. `?link=1` is resolved one level up in
 * providerAuthEntry — this only sees an explicit intent. `native`,
 * `code_challenge` and `next` are read from the query; a missing provider
 * configuration (and any validation failure) lands on the generic error
 * redirect rather than leaking which piece is absent.
 */
export const startProviderAuth = async (
  c: Context,
  provider: AuthProvider,
  intent: { intent: 'signin' | 'link'; accountId?: string } = { intent: 'signin' },
) => {
  const env = accessEnvOf(c)
  const linking = intent.intent === 'link'
  const flow = await createAuthFlow({
    provider,
    intent: intent.intent,
    accountId: intent.accountId,
    // Linking re-verifies the browser session at the callback, so handoff
    // parameters are meaningless there — ignore rather than reject them.
    native: linking ? '' : c.req.query('native') ?? '',
    appChallenge: linking ? undefined : c.req.query('code_challenge'),
    next: c.req.query('next'),
  }, env).catch(() => null)
  if (!flow) return c.redirect('/?error=1')
  const redirectUri = callbackUri(provider, c.req.url)
  try {
    return c.redirect(await authorizeUrl(provider, flow, redirectUri, env as ProviderEnv))
  } catch {
    return c.redirect('/?error=1')
  }
}

/** The route-level entry for GET /auth/{provider}: `?link=1` upgrades to a
 *  link intent only when the caller already holds a valid session. */
export const providerAuthEntry = async (c: Context, provider: AuthProvider) => {
  if (c.req.query('link') === '1') {
    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
    if (!session) return c.redirect('/?error=1')
    return startProviderAuth(c, provider, { intent: 'link', accountId: session.accountId })
  }
  return startProviderAuth(c, provider)
}

const finishFailure = (c: Context) => c.redirect('/?error=1')

/**
 * The provider callback. The state row is consumed first — before the
 * error/code checks and before any network call — so a replayed, expired,
 * or foreign-provider state can never reach the token exchange. `deps`
 * lets tests inject the fetch and JWKS resolver; production routes omit it.
 */
export const finishProviderAuth = async (
  c: Context,
  provider: AuthProvider,
  params: { code?: string | undefined; state?: string | undefined; error?: string | undefined; user?: unknown },
  deps: OidcDependencies = {},
) => {
  const requestUrl = new URL(c.req.url)
  const env = accessEnvOf(c)
  const flow = params.state ? await consumeAuthFlow(params.state, env).catch(() => null) : null
  if (!flow || flow.provider !== provider) return finishFailure(c)
  if (params.error || !params.code) return finishFailure(c)
  const secret = env.HOST_API_JWT_SECRET?.trim()
  if (!secret) return finishFailure(c)

  // A link flow must still belong to the browser that started it — check
  // the session before spending the authorization code.
  let linkSessionAccount: { accountId: string; ownerSlug: string } | null = null
  if (flow.intent === 'link') {
    const session = await resolveManoramaSession(c.req.raw, env)
    if (!session || session.accountId !== flow.accountId) return finishFailure(c)
    linkSessionAccount = session
  }

  try {
    const identity = await fetchIdentity(provider, flow, {
      redirectUri: callbackUri(provider, c.req.url),
      code: params.code,
      user: params.user,
    }, env as ProviderEnv, deps)

    if (flow.intent === 'link') {
      try {
        await linkIdentity(flow.accountId!, identity, env)
      } catch (error) {
        if (error instanceof IdentityConflictError) {
          return c.redirect(`/${linkSessionAccount!.ownerSlug}?link=conflict`)
        }
        throw error
      }
      const country = ((c.req.raw as { cf?: { country?: unknown } }).cf?.country ?? '').toString().toUpperCase()
      await setLastSeenCountry(flow.accountId!, country, env).catch(() => {})
      return c.redirect(`/${linkSessionAccount!.ownerSlug}?linked=${provider}`)
    }

    const user = await upsertIdentitySignIn(identity, env)
    const country = ((c.req.raw as { cf?: { country?: unknown } }).cf?.country ?? '').toString().toUpperCase()
    await setLastSeenCountry(user.accountId, country, env).catch(() => {})
    const token = await createSessionToken(user.accountId, secret)
    const cookieOpts = {
      httpOnly: true,
      secure: requestUrl.protocol === 'https:',
      sameSite: 'Lax' as const,
      path: '/',
    }
    setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_TTL_SECONDS })
    // Outlives the session: a signed-in-here-before hint for the landing CTA.
    setCookie(c, RETURNING_COOKIE, '1', { ...cookieOpts, maxAge: RETURNING_TTL_SECONDS })

    if (flow.native === '1') {
      const handoff = await createNativeHandoffToken(user.accountId, secret)
      return c.redirect(`${NATIVE_CALLBACK}?handoff=${encodeURIComponent(handoff)}`)
    }
    if (flow.native === 'desktop') {
      const handoff = await createDesktopHandoffToken(user.accountId, secret, flow.appChallenge ?? '')
      return c.redirect(`${DESKTOP_CALLBACK}?handoff=${encodeURIComponent(handoff)}`)
    }
    if (flow.nextUrl) {
      try {
        // Stored raw at create time; the same-origin check happens here,
        // at the only place the value can do harm. Path-relative URLs
        // resolve against our own origin and always pass.
        if (new URL(flow.nextUrl, requestUrl.origin).origin === requestUrl.origin) {
          return c.redirect(flow.nextUrl)
        }
      } catch { /* fall through to the dashboard */ }
    }
    return c.redirect(`/${user.ownerSlug}`)
  } catch (error) {
    if (error instanceof IdentityStorageUnavailableError) {
      c.header('Cache-Control', 'no-store')
      return c.text('Sign-in is temporarily unavailable', 503)
    }
    console.error('auth-finish-error', provider, error)
    return finishFailure(c)
  }
}
