import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { consumeAuthFlow, createAuthFlow, pkceChallenge, type AuthFlow } from './auth-flows'
import { appleAuthorizeUrl, fetchAppleIdentity, type AppleAuthEnv } from './apple-auth'
import { createDesktopHandoffToken, DESKTOP_CALLBACK } from './desktop-auth'
import { dropboxAuthorizeUrl, fetchDropboxAccount, type DropboxOauthEnv } from './dropbox-oauth'
import { fetchGoogleIdentity, googleAuthorizeUrl, type GoogleAuthEnv } from './google-auth'
import {
  AccountDisabledError,
  findAccountByIdentity,
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
  createPendingAccountToken,
  createSessionToken,
  resolveManoramaSession,
  verifyLinkHandoffToken,
  verifyPendingAccountToken,
  RETURNING_COOKIE,
  RETURNING_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './session'
import { setLastSeenCountry, type UserRecord } from './user-repository'

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
  intent: { intent: 'signin' | 'link'; accountId?: string; native?: '1' } = { intent: 'signin' },
) => {
  const env = accessEnvOf(c)
  const linking = intent.intent === 'link'
  const flow = await createAuthFlow({
    provider,
    intent: intent.intent,
    accountId: intent.accountId,
    // Web linking re-verifies the browser session at the callback, so a
    // query-string handoff is meaningless there — ignore rather than reject
    // it. A client link arrives pre-bound: caller passes native explicitly.
    native: linking ? intent.native ?? '' : c.req.query('native') ?? '',
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
 *  link intent only when the caller already holds a valid session. A
 *  `?link={token}` value is the client handoff twin — minted behind a bearer
 *  session for one minute — for browsers that hold no manorama cookie. */
export const providerAuthEntry = async (c: Context, provider: AuthProvider) => {
  const link = c.req.query('link')
  if (link === '1') {
    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
    if (!session) return c.redirect('/?error=1')
    return startProviderAuth(c, provider, { intent: 'link', accountId: session.accountId })
  }
  if (link) {
    const secret = accessEnvOf(c).HOST_API_JWT_SECRET?.trim()
    const accountId = secret ? await verifyLinkHandoffToken(link, secret).catch(() => null) : null
    if (!accountId) return c.redirect('/?error=1')
    return startProviderAuth(c, provider, { intent: 'link', accountId, native: '1' })
  }
  return startProviderAuth(c, provider)
}

const finishFailure = (c: Context) => c.redirect('/?error=1')

/** The sign-in tail shared by the OAuth callback and the pending-account
 * confirm step: country, cookies, then the handoff/next/dashboard choice. */
const completeSignIn = async (
  c: Context,
  user: UserRecord,
  flow: Pick<AuthFlow, 'native' | 'nextUrl' | 'appChallenge'>,
  env: ReturnType<typeof accessEnvOf>,
  secret: string,
) => {
  const requestUrl = new URL(c.req.url)
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
}

const PROVIDER_LABEL: Record<AuthProvider, string> = { apple: 'Apple', dropbox: 'Dropbox', google: 'Google' }

const esc = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

/** The pause page for a provider identity that maps to no manorama account.
 * Self-contained HTML — it renders before any route renderer is involved. */
const pendingAccountPage = async (
  c: Context,
  identity: IdentityInput,
  flow: AuthFlow,
  secret: string,
) => {
  const token = await createPendingAccountToken({
    provider: identity.provider,
    subject: identity.subject,
    name: identity.displayName,
    email: identity.email,
    next: flow.nextUrl,
    native: flow.native || undefined,
    appChallenge: flow.appChallenge,
  }, secret)
  const provider = PROVIDER_LABEL[identity.provider]
  // Declining lands back where sign-in can be retried: the ops door keeps
  // its provider buttons anonymous, everywhere else it's the landing page.
  const decline = flow.nextUrl?.startsWith('/opman') ? flow.nextUrl : '/'
  c.header('Cache-Control', 'no-store')
  return c.html(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>manorama — new sign-in</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#111312;color:#e8e6e3;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif}
.card{max-width:30rem;padding:2.5rem 2rem;text-align:center}
.card img{width:15rem;height:auto;margin-bottom:1.75rem;transform:translateX(-9.2%)}
h1{font-size:1.5rem;font-weight:600;margin:0 0 1rem}
p{color:#b9b5ae;line-height:1.55;margin:0 0 1rem;font-size:.95rem}
p.note{color:#8a867e;font-size:.85rem}
.actions{display:flex;flex-direction:column;gap:.75rem;margin-top:1.75rem}
.btn{display:block;border-radius:999px;min-height:52px;line-height:52px;text-align:center;
font-size:1rem;font-weight:600;text-decoration:none;cursor:pointer;border:none;width:100%;box-sizing:border-box}
.create{background:#e8e6e3;color:#111312}
.back{background:transparent;color:#b9b5ae;border:1px solid #3a3d3b}
</style></head><body><main class="card">
<img src="/manorama-merged-logo.png" alt="manorama">
<h1>This ${esc(provider)} sign-in is new to manorama.</h1>
<p class="note">If you already keep galleries here, this probably isn&rsquo;t the sign-in you used
before &mdash; go back and pick the provider you signed in with last time.</p>
<div class="actions">
<form method="post" action="/auth/confirm-account">
<input type="hidden" name="token" value="${esc(token)}">
<button class="btn create" type="submit">Create a new account</button>
</form>
<a class="btn back" href="${esc(decline)}">Go back</a>
</div></main></body></html>`)
}

/** POST /auth/confirm-account — the interstitial's create button. The
 * token proves the identity came out of a real provider round-trip; on
 * success the shared sign-in tail mints the session and redirects. */
export const confirmPendingAccount = async (c: Context) => {
  const env = accessEnvOf(c)
  const secret = env.HOST_API_JWT_SECRET?.trim()
  const form = await c.req.parseBody().catch(() => null)
  const token = secret && form && typeof form.token === 'string'
    ? await verifyPendingAccountToken(form.token, secret).catch(() => null)
    : null
  if (!token) return finishFailure(c)
  try {
    const user = await upsertIdentitySignIn({
      provider: token.provider,
      subject: token.subject,
      displayName: token.name,
      email: token.email,
    }, env)
    return completeSignIn(c, user, {
      native: token.native === '1' || token.native === 'desktop' ? token.native : '',
      nextUrl: token.next,
      appChallenge: token.appChallenge,
    }, env, secret!)
  } catch (error) {
    if (error instanceof IdentityStorageUnavailableError) {
      c.header('Cache-Control', 'no-store')
      return c.text('Sign-in is temporarily unavailable', 503)
    }
    if (error instanceof AccountDisabledError) {
      c.header('Cache-Control', 'no-store')
      return c.text('This account has been disabled. Contact the manorama operator if that looks wrong.', 403)
    }
    return finishFailure(c)
  }
}

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
  const env = accessEnvOf(c)
  const flow = params.state ? await consumeAuthFlow(params.state, env).catch(() => null) : null
  if (!flow || flow.provider !== provider) return finishFailure(c)
  if (params.error || !params.code) return finishFailure(c)
  const secret = env.HOST_API_JWT_SECRET?.trim()
  if (!secret) return finishFailure(c)

  // A web link flow must still belong to the browser that started it — check
  // the session before spending the authorization code. A client link flow
  // was pre-bound by its link handoff and returns through the custom scheme.
  let linkSessionAccount: { accountId: string; ownerSlug: string } | null = null
  const nativeLink = flow.intent === 'link' && flow.native === '1'
  if (flow.intent === 'link' && !nativeLink) {
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
          return c.redirect(nativeLink ? `${NATIVE_CALLBACK}?link=conflict` : `/${linkSessionAccount!.ownerSlug}?link=conflict`)
        }
        throw error
      }
      const country = ((c.req.raw as { cf?: { country?: unknown } }).cf?.country ?? '').toString().toUpperCase()
      await setLastSeenCountry(flow.accountId!, country, env).catch(() => {})
      return c.redirect(nativeLink ? `${NATIVE_CALLBACK}?linked=${provider}` : `/${linkSessionAccount!.ownerSlug}?linked=${provider}`)
    }

    // A first-time provider identity used to mint an empty account on the
    // spot — the person landed in an empty dashboard and thought their
    // galleries were gone. Pause instead: confirm creation, or go back and
    // pick the provider the existing account already knows.
    const existing = await findAccountByIdentity(identity.provider, identity.subject, env)
    if (!existing) return pendingAccountPage(c, identity, flow, secret)
    const user = await upsertIdentitySignIn(identity, env)
    return completeSignIn(c, user, flow, env, secret)
  } catch (error) {
    if (error instanceof IdentityStorageUnavailableError) {
      c.header('Cache-Control', 'no-store')
      return c.text('Sign-in is temporarily unavailable', 503)
    }
    if (error instanceof AccountDisabledError) {
      c.header('Cache-Control', 'no-store')
      return c.text('This account has been disabled. Contact the manorama operator if that looks wrong.', 403)
    }
    return finishFailure(c)
  }
}
