import { pkceChallenge } from '../../../app/lib/auth-flows'
import { uploadProviderLabel, type UploadProviderId } from './types'

/**
 * Provider write authorization — the OAuth half of the upload lane.
 *
 * This is a SECOND, independent authorization from Manorama sign-in: the
 * system browser goes straight to the provider's authorize endpoint with
 * an installed-app authorization-code + PKCE flow, and the tokens that come
 * back (in `providers.json` via the private-store commands) are used ONLY
 * for provider API calls. The Manorama session token never rides along.
 *
 * Redirect paths differ by provider:
 *  - Dropbox supports custom schemes, so it redirects to
 *    `in.thecontrarian.manorama.desktop://oauth/dropbox` — the same scheme
 *    sign-in already registers.
 *  - Google's installed-app clients only allow the loopback form, so the
 *    app binds `http://127.0.0.1:<port>` in Rust (the `oauth_loopback_*`
 *    commands) and the browser delivers the code there directly.
 *
 * Both flows share the state+nonce+PKCE binding kept in `pendingOAuth`:
 * single-use, in memory, and bound to the provider that opened it — this
 * deliberately does NOT go through the Worker's auth_flows, which exist
 * for sign-in identity only.
 *
 * As in session.ts, every Tauri seam is a lazy `await import` so the pure
 * parts — URL building, redirect parsing, token request shapes — run
 * unchanged in `bun test`.
 */

export const PROVIDERS_FILE = 'providers.json'

const DESKTOP_SCHEME = 'in.thecontrarian.manorama.desktop:'

export const DROPBOX_AUTHORIZE_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize'
export const DROPBOX_TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token'
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Least privilege: file-level access to files this app created — never
 *  full-drive scope, and deliberately NOT mixed with an openid request. */
export const DRIVE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** Files larger than this need Dropbox upload sessions. The slice hard-caps
 *  here instead — the clear error is honest and sessions are the documented
 *  next step, not a silent degradation. */
export const DROPBOX_MAX_SINGLE_UPLOAD_BYTES = 140 * 1024 * 1024

/** Public client identifiers injected at build time — these identify the
 *  OAuth APP, they are not secrets (installed-app flows cannot hold one).
 *  Empty means the build ships the provider disabled. */
const envValue = (name: string): string => {
  const bag = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  const value = bag?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

export const providerClientId = (provider: UploadProviderId): string =>
  envValue(provider === 'dropbox' ? 'MANORAMA_DESKTOP_DROPBOX_CLIENT_ID' : 'MANORAMA_DESKTOP_GOOGLE_CLIENT_ID')

/** Google desktop-client secret — public by design in Google's installed-app
 *  model (the docs say it "is not expected to stay secret"), so it may be
 *  injected at build time like the client id. Some desktop clients accept
 *  secret-less exchanges; leaving it empty sends none. Dropbox never gets
 *  one — its PKCE flow is client_id only. */
export const providerClientSecret = (provider: UploadProviderId): string =>
  provider === 'drive' ? envValue('MANORAMA_DESKTOP_GOOGLE_CLIENT_SECRET') : ''

/** Optional clientId override keeps the empty-means-disabled rule pure
 *  enough to assert in tests without touching build env. */
export const providerConfigured = (provider: UploadProviderId, clientId = providerClientId(provider)): boolean =>
  clientId.length > 0

export const providerRedirectUri = (provider: UploadProviderId, loopbackPort?: number): string =>
  provider === 'dropbox'
    ? 'in.thecontrarian.manorama.desktop://oauth/dropbox'
    : `http://127.0.0.1:${loopbackPort ?? 0}`

export type ProviderAuthorizeArgs = {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

export const buildProviderAuthorizeUrl = (
  provider: UploadProviderId,
  args: ProviderAuthorizeArgs,
): string => {
  const url = new URL(provider === 'dropbox' ? DROPBOX_AUTHORIZE_ENDPOINT : GOOGLE_AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (provider === 'dropbox') {
    // Offline access — the refresh token is what providers.json stores.
    url.searchParams.set('token_access_type', 'offline')
  } else {
    url.searchParams.set('scope', DRIVE_UPLOAD_SCOPE)
    url.searchParams.set('access_type', 'offline')
    // Guarantees a refresh token on re-consent, not just first consent.
    url.searchParams.set('prompt', 'consent')
  }
  return url.toString()
}

// --- Redirect parsing -----------------------------------------------------

export type ProviderRedirect =
  | { provider: UploadProviderId; code: string; state: string }
  | { provider: UploadProviderId; error: string }

const OAUTH_PATH_PROVIDERS: Record<string, UploadProviderId> = {
  '/dropbox': 'dropbox',
  '/drive': 'drive',
}

const isLoopbackHost = (url: URL): boolean =>
  (url.protocol === 'http:' || url.protocol === 'https:') &&
  (url.hostname === '127.0.0.1' || url.hostname === 'localhost')

/**
 * Parses a redirect from either delivery path — the custom scheme
 * (`…://oauth/{provider}`) or a pasted/Google loopback URL — into a
 * provider-bound code+state. Anything else is null, and a provider error
 * response keeps the provider tag so the UI can say WHICH flow declined.
 */
export const parseProviderRedirect = (input: string): ProviderRedirect | null => {
  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return null
  }
  let provider: UploadProviderId | null = null
  if (parsed.protocol === DESKTOP_SCHEME && parsed.hostname === 'oauth') {
    provider = OAUTH_PATH_PROVIDERS[parsed.pathname] ?? null
  } else if (isLoopbackHost(parsed)) {
    // Installed-app Google clients only allow the loopback redirect.
    provider = 'drive'
  }
  if (!provider) return null
  const providerError = parsed.searchParams.get('error')?.trim()
  if (providerError) return { provider, error: providerError }
  const code = parsed.searchParams.get('code')?.trim()
  const state = parsed.searchParams.get('state')?.trim()
  if (!code || !state) return { provider, error: 'missing_code' }
  return { provider, code, state }
}

/** True when a deep link belongs to a provider OAuth flow — used by the
 *  deep-link router to split auth/callback handoffs from oauth/* redirects. */
export const isProviderDeepLink = (input: string): boolean => {
  try {
    const parsed = new URL(input.trim())
    return parsed.protocol === DESKTOP_SCHEME && parsed.hostname === 'oauth'
  } catch {
    return false
  }
}

// --- Token exchange / refresh (pure request shapes + one fetch each) ------

export type StoredProviderTokens = {
  accessToken: string
  refreshToken?: string
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number
}

/** The form body shared by both token endpoints: grant, code, client id,
 *  the PKCE verifier, and the redirect the code was minted for. A
 *  client_secret is attached only when the build provides one (see
 *  `providerClientSecret`) — never invented, never defaulted. */
export const tokenExchangeParams = (
  args: { code: string; codeVerifier: string; clientId: string; redirectUri: string; clientSecret?: string },
): URLSearchParams => {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  })
  if (args.clientSecret) params.set('client_secret', args.clientSecret)
  return params
}

export const tokenRefreshParams = (
  args: { refreshToken: string; clientId: string; clientSecret?: string },
): URLSearchParams => {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
  if (args.clientSecret) params.set('client_secret', args.clientSecret)
  return params
}

const tokenEndpoint = (provider: UploadProviderId): string =>
  provider === 'dropbox' ? DROPBOX_TOKEN_ENDPOINT : GOOGLE_TOKEN_ENDPOINT

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

const postTokenRequest = async (
  provider: UploadProviderId,
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<StoredProviderTokens> => {
  const response = await fetcher(tokenEndpoint(provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  const payload = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error(`${uploadProviderLabel(provider)} authorization could not be completed.`)
  }
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refreshToken: payload.refresh_token }
      : {}),
    // Providers that omit expires_in get a conservative one-hour validity —
    // the refresh path is the same either way.
    expiresAt: Date.now() + (typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600) * 1000,
  }
}

export const exchangeCodeForTokens = (
  provider: UploadProviderId,
  args: { code: string; codeVerifier: string; clientId: string; redirectUri: string; clientSecret?: string },
  fetcher: typeof fetch = fetch,
): Promise<StoredProviderTokens> =>
  postTokenRequest(provider, tokenExchangeParams(args), fetcher)

export const refreshAccessToken = (
  provider: UploadProviderId,
  args: { refreshToken: string; clientId: string; clientSecret?: string },
  fetcher: typeof fetch = fetch,
): Promise<StoredProviderTokens> =>
  postTokenRequest(provider, tokenRefreshParams(args), fetcher)

// --- providers.json via the private-store commands (lazy seams) -----------

const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args)

type ProvidersFile = Partial<Record<UploadProviderId, StoredProviderTokens>>

const readProvidersFile = async (): Promise<ProvidersFile> => {
  try {
    const contents = await invoke<string | null>('read_private_file', { name: PROVIDERS_FILE })
    if (!contents) return {}
    const parsed = JSON.parse(contents) as ProvidersFile
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

const writeProvidersFile = async (file: ProvidersFile): Promise<void> =>
  invoke('write_private_file', { name: PROVIDERS_FILE, contents: JSON.stringify(file) })

export const loadProviderTokens = async (provider: UploadProviderId): Promise<StoredProviderTokens | null> => {
  const stored = (await readProvidersFile())[provider]
  return stored && typeof stored.accessToken === 'string' && stored.accessToken ? stored : null
}

const storeProviderTokens = async (provider: UploadProviderId, tokens: StoredProviderTokens): Promise<void> => {
  const file = await readProvidersFile()
  file[provider] = tokens
  await writeProvidersFile(file)
}

export const clearProviderTokens = async (provider: UploadProviderId): Promise<void> => {
  const file = await readProvidersFile()
  if (!(provider in file)) return
  delete file[provider]
  try {
    await writeProvidersFile(file)
  } catch {
    // Absent is the desired disconnected state.
  }
}

/**
 * A usable access token: the stored one while it has >60s left, else a
 * refresh. The refresh token is only ever replaced — if the response omits
 * it, the stored one stays.
 */
export const accessTokenFor = async (
  provider: UploadProviderId,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const stored = await loadProviderTokens(provider)
  if (!stored) {
    throw new Error(`Connect ${uploadProviderLabel(provider)} first.`)
  }
  if (stored.expiresAt > Date.now() + 60_000) return stored.accessToken
  if (!stored.refreshToken) {
    throw new Error(`${uploadProviderLabel(provider)} needs to be connected again.`)
  }
  const refreshed = await refreshAccessToken(provider, {
    refreshToken: stored.refreshToken,
    clientId: providerClientId(provider),
    clientSecret: providerClientSecret(provider) || undefined,
  }, fetcher)
  const merged: StoredProviderTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
  }
  await storeProviderTokens(provider, merged)
  return merged.accessToken
}

// --- The connect flow ------------------------------------------------------

const randomBase64Url = (bytes: number): string => {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export const generateState = (): string => randomBase64Url(24)
export const generateVerifier = (): string => randomBase64Url(32)

type PendingOAuth = {
  provider: UploadProviderId
  state: string
  verifier: string
  redirectUri: string
  resolve: () => void
  reject: (error: Error) => void
}

/** Single-use, provider-bound, in-memory — a cold-start redirect lands on
 *  a missing pending and becomes a "start Connect again" message, never a
 *  replayed exchange. */
let pendingOAuth: PendingOAuth | null = null

const failPending = (error: Error): void => {
  const pending = pendingOAuth
  pendingOAuth = null
  pending?.reject(error)
}

const settlePending = (): void => {
  const pending = pendingOAuth
  pendingOAuth = null
  pending?.resolve()
}

/**
 * Completes whichever provider flow is waiting — the ONLY path from a
 * redirect to stored tokens. The pending is single-use: every outcome
 * (success, state mismatch, wrong provider, provider error) consumes it,
 * settling or rejecting the connect promise either way, and the thrown
 * error doubles as the paste-fallback message.
 */
export const completeProviderConnect = async (url: string): Promise<void> => {
  const fail = (message: string): Error => {
    const error = new Error(message)
    failPending(error)
    return error
  }
  const pending = pendingOAuth
  if (!pending) throw fail('No provider connection is waiting — start Connect again.')
  const redirect = parseProviderRedirect(url)
  if (!redirect) throw fail('That redirect link was not recognized.')
  if (redirect.provider !== pending.provider) {
    throw fail('That redirect is for a different provider — start Connect again.')
  }
  if ('error' in redirect) {
    throw fail(`${uploadProviderLabel(pending.provider)} authorization was declined.`)
  }
  if (redirect.state !== pending.state) {
    throw fail('The authorization response did not match this app — start Connect again.')
  }
  try {
    const tokens = await exchangeCodeForTokens(pending.provider, {
      code: redirect.code,
      codeVerifier: pending.verifier,
      clientId: providerClientId(pending.provider),
      clientSecret: providerClientSecret(pending.provider) || undefined,
      redirectUri: pending.redirectUri,
    })
    await storeProviderTokens(pending.provider, tokens)
  } catch (error) {
    const err = error instanceof Error ? error : new Error('The provider connection could not be completed.')
    failPending(err)
    throw err
  }
  settlePending()
}

/** Deep-link entry point — called by the session.ts router for every URL
 *  on our scheme that is not the sign-in handoff. Returns true when the
 *  URL belonged to a provider flow (success or failure both settle the
 *  pending connect promise). */
export const handleProviderDeepLink = (url: string): boolean => {
  if (!isProviderDeepLink(url)) return false
  // completeProviderConnect settles or rejects the pending itself — the
  // catch only swallows the rethrow that the paste path needs.
  void completeProviderConnect(url).catch(() => {})
  return true
}

export const cancelProviderConnect = (): void => {
  // A Drive flow also has a Rust listener parked in accept() — release it
  // or the thread and port stay held until the server-side timeout.
  if (pendingOAuth?.provider === 'drive') void invoke('oauth_loopback_cancel').catch(() => {})
  failPending(new Error('The connection was cancelled.'))
}

const openSystem = async (url: string): Promise<void> =>
  (await import('@tauri-apps/plugin-opener')).openUrl(url)

/**
 * Opens the provider's authorize page in the SYSTEM browser and resolves
 * once tokens are stored. For Drive the completion arrives on the Rust
 * loopback listener; for Dropbox on the custom-scheme deep link routed
 * through `handleProviderDeepLink`. Either path can also be completed by
 * pasting the redirect into `completeProviderConnect`.
 */
export const connectProvider = async (provider: UploadProviderId): Promise<void> => {
  const clientId = providerClientId(provider)
  if (!clientId) {
    throw new Error(`${uploadProviderLabel(provider)} is not configured in this build.`)
  }
  if (pendingOAuth) {
    throw new Error('A provider connection is already waiting — finish or cancel it first.')
  }
  const state = generateState()
  const verifier = generateVerifier()
  const challenge = await pkceChallenge(verifier)
  let redirectUri: string
  let awaitLoopback: (() => Promise<string>) | null = null
  if (provider === 'drive') {
    // Google's recommended installed-app path: an ephemeral loopback port
    // owned by a Rust TcpListener — no scheme registration needed and no
    // fixed port to collide with.
    const port = await invoke<number>('oauth_loopback_begin')
    redirectUri = `http://127.0.0.1:${port}`
    awaitLoopback = () =>
      invoke<string>('oauth_loopback_finish').then((target) => `http://127.0.0.1:${port}${target}`)
  } else {
    redirectUri = providerRedirectUri('dropbox')
  }
  const done = new Promise<void>((resolve, reject) => {
    pendingOAuth = { provider, state, verifier, redirectUri, resolve, reject }
  })
  try {
    await openSystem(buildProviderAuthorizeUrl(provider, { clientId, redirectUri, state, codeChallenge: challenge }))
  } catch (error) {
    if (provider === 'drive') void invoke('oauth_loopback_cancel').catch(() => {})
    failPending(error instanceof Error ? error : new Error('The system browser could not be opened.'))
    return done
  }
  if (awaitLoopback) {
    void awaitLoopback()
      .then(completeProviderConnect)
      .catch((error: unknown) =>
        failPending(error instanceof Error ? error : new Error('The provider connection could not be completed.')),
      )
  }
  return done
}
