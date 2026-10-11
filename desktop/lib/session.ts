import { pkceChallenge } from '../../app/lib/auth-flows'
import type { AuthProvider } from '../../app/lib/identity-repository'

/**
 * Desktop sign-in: PKCE in the webview, OAuth in the SYSTEM browser, and a
 * one-minute deep-link handoff exchanged at /api/auth/desktop/exchange.
 *
 * The Tauri seams (opener, deep-link events, the private store) are all
 * lazy `await import`s so every pure function in this file — verifier,
 * challenge, URL building, handoff parsing, the exchange request — runs in
 * `bun test` with no plugin mocks.
 */

export type { AuthProvider }

/** The scheme the OAuth callback redirects to — mirrors DESKTOP_CALLBACK in
 *  app/lib/desktop-auth.ts (kept local so the jose import stays server-side). */
export const DESKTOP_CALLBACK_URL = 'in.thecontrarian.manorama.desktop://auth/callback'

export const DESKTOP_AUTH_PROVIDERS: readonly AuthProvider[] = ['apple', 'google', 'dropbox']

const SESSION_FILE = 'session.json'

/** `tier` is the account's plan, answered by the exchange alongside the token.
 *  It is optional because a session persisted before the field existed is
 *  still a valid session — the account pane simply omits the plan sentence
 *  until the next sign-in rather than guessing Free. */
export type DesktopSession = { token: string; ownerSlug: string; tier?: 'free' | 'pro' }

const parseTier = (value: unknown): 'free' | 'pro' | undefined =>
  value === 'pro' || value === 'free' ? value : undefined

/** One place decides the session's shape, so the exchange and the stored file
 *  cannot disagree about which fields exist. */
const withTier = (
  token: string,
  ownerSlug: string,
  tier: unknown,
): DesktopSession => {
  const plan = parseTier(tier)
  return { token, ownerSlug, ...(plan ? { tier: plan } : {}) }
}

type PendingSignIn = { verifier: string; provider: AuthProvider; startedAt: number }

/** In-memory verifier for the in-flight flow. The handoff is purpose-bound
 *  to this challenge, so a verifier that only lives in RAM cannot be
 *  replayed after the app quits — a cold-start callback lands on the
 *  paste-the-link fallback with a fresh attempt. */
let pendingSignIn: PendingSignIn | null = null

export const normalizeApiBase = (value: string): string => value.replace(/\/+$/, '')

const randomBase64Url = (bytes: number): string => {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** 32 bytes → 43 base64url chars: inside the RFC 7636 43–128 verifier window
 *  and matching the server's APP_CHALLENGE_PATTERN for the S256 it yields. */
export const generateCodeVerifier = (): string => randomBase64Url(32)

export { pkceChallenge }

export const buildDesktopAuthUrl = (provider: AuthProvider, apiBase: string, codeChallenge: string): string => {
  const origin = new URL(normalizeApiBase(apiBase))
  const local = origin.protocol === 'http:' && origin.port === '5173' && ['localhost', '127.0.0.1'].includes(origin.hostname)
  // A loopback test build uses an explicit development-account browser door,
  // not a pretend provider login. Production always uses real system OAuth.
  const url = new URL(local ? '/.dev-seed/desktop-login' : `/auth/${provider}`, `${normalizeApiBase(apiBase)}/`)
  url.searchParams.set('native', 'desktop')
  url.searchParams.set('code_challenge', codeChallenge)
  return url.toString()
}

/**
 * Extracts the handoff token from a deep link, or null for anything that is
 * not our scheme+host+path — an arbitrary in.thecontrarian.manorama.desktop://
 * URL must never reach the exchange.
 */
export const handoffFromDeepLink = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'in.thecontrarian.manorama.desktop:') return null
  if (parsed.hostname !== 'auth' || parsed.pathname !== '/callback') return null
  const handoff = parsed.searchParams.get('handoff')?.trim()
  return handoff || null
}

type ExchangeResponse = { token?: string; ownerSlug?: string; tier?: string; error?: string }

/**
 * POST {apiBase}/api/auth/desktop/exchange — the verifier proves this app
 * started the flow the handoff was minted for. Any failure maps to the
 * generic sign-in message; the server's 401 body is not user-copyable.
 */
export const exchangeDesktopHandoff = async (
  handoffToken: string,
  codeVerifier: string,
  apiBase: string,
  fetcher: typeof fetch = fetch,
): Promise<DesktopSession> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/auth/desktop/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffToken, codeVerifier }),
  })
  const payload = (await response.json().catch(() => ({}))) as ExchangeResponse
  if (!response.ok || typeof payload.token !== 'string' || !payload.token) {
    if (response.status === 401) throw new Error('This sign-in link has expired or does not match this app. Start sign-in again in this window.')
    if (response.status >= 500) throw new Error('Sign-in is temporarily unavailable. Please try again shortly.')
    throw new Error('Sign-in could not be completed. Please try again.')
  }
  return withTier(
    payload.token,
    typeof payload.ownerSlug === 'string' ? payload.ownerSlug : '',
    payload.tier,
  )
}

// --- Tauri seams (lazy imports: never evaluated by tests) ---

const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args)

export const getSession = async (): Promise<DesktopSession | null> => {
  try {
    const contents = await invoke<string | null>('read_private_file', { name: SESSION_FILE })
    if (!contents) return null
    const parsed = JSON.parse(contents) as Partial<DesktopSession>
    return typeof parsed.token === 'string' && parsed.token.trim()
      ? withTier(parsed.token, typeof parsed.ownerSlug === 'string' ? parsed.ownerSlug : '', parsed.tier)
      : null
  } catch {
    return null
  }
}

const storeSession = async (session: DesktopSession): Promise<void> =>
  invoke('write_private_file', { name: SESSION_FILE, contents: JSON.stringify(session) })

export const clearSession = async (): Promise<void> => {
  try {
    await invoke('delete_private_file', { name: SESSION_FILE })
  } catch {
    // Already absent is the desired signed-out state.
  }
}

/**
 * Starts a sign-in: holds the verifier in memory and hands the URL to the
 * SYSTEM browser via the opener plugin. In-webview OAuth is forbidden — the
 * app never sees provider credentials.
 */
export const beginDesktopSignIn = async (provider: AuthProvider, apiBase: string): Promise<void> => {
  const verifier = generateCodeVerifier()
  const challenge = await pkceChallenge(verifier)
  pendingSignIn = { verifier, provider, startedAt: Date.now() }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  try {
    await openUrl(buildDesktopAuthUrl(provider, apiBase, challenge))
  } catch {
    pendingSignIn = null
    throw new Error('The browser could not open. Please try sign-in again from this app.')
  }
}

/** The OS, the deep-link plugin and a pasted callback can deliver the same
 * URL concurrently. They must share a completion, not race a cleared verifier
 * and overwrite a successful account with a spurious sign-in error. */
export const createDesktopSignInCompleter = (dependencies: {
  pending: () => PendingSignIn | null
  exchange: typeof exchangeDesktopHandoff
  store: (session: DesktopSession) => Promise<void>
  consume: (pending: PendingSignIn) => void
}) => {
  const completions = new Map<string, Promise<DesktopSession>>()
  return (url: string, apiBase: string): Promise<DesktopSession> => {
    const handoff = handoffFromDeepLink(url)
    if (!handoff) return Promise.reject(new Error('That is not a manorama sign-in link. Start sign-in from this app.'))
    const key = `${normalizeApiBase(apiBase)}:${handoff}`
    const existing = completions.get(key)
    if (existing) return existing
    const pending = dependencies.pending()
    if (!pending) return Promise.reject(new Error('Start sign-in in this app window first, then return to the same window. If the app restarted, start again.'))
    const completion = (async () => {
      try {
        const session = await dependencies.exchange(handoff, pending.verifier, apiBase)
        // The verifier is retained until persistence succeeds, so a disk
        // failure does not make a retry indistinguishable from a foreign link.
        await dependencies.store(session)
        dependencies.consume(pending)
        return session
      } catch (reason) {
        completions.delete(key)
        throw reason
      }
    })()
    completions.set(key, completion)
    // Only a small session-local replay window is needed; never persist the
    // handoff or verifier. Pending work is not evicted.
    void completion.then(() => {
      if (completions.size > 8) completions.delete(completions.keys().next().value!)
    }, () => {})
    return completion
  }
}

export const completeDesktopSignIn = createDesktopSignInCompleter({
  pending: () => pendingSignIn,
  exchange: exchangeDesktopHandoff,
  store: storeSession,
  consume: (pending) => { if (pendingSignIn === pending) pendingSignIn = null },
})

/**
 * Wires deep-link delivery: the plugin's onOpenUrl for the already-running
 * instance, plus the app's own event for cold-start launch URLs forwarded
 * by the Rust setup. Both land on the same handler.
 *
 * Dev-build note: on macOS a `tauri dev` binary carries no .app bundle, so
 * LaunchServices cannot route the scheme to it — the paste-the-link
 * fallback in the UI is the supported path until a bundled build exists.
 */
export const installDesktopAuth = async (
  apiBase: string,
  onSignedIn: (session: DesktopSession) => void,
  onError: (message: string) => void,
  onOtherUrl?: (url: string) => void,
): Promise<() => Promise<void>> => {
  const deliveries = new Set<string>()
  const handle = (url: string) => {
    // Non-handoff URLs on our scheme — provider OAuth redirects under
    // //oauth/* — route to the caller's handler rather than erroring a
    // sign-in that was never theirs to complete.
    if (!handoffFromDeepLink(url)) {
      onOtherUrl?.(url)
      return
    }
    if (deliveries.has(url)) return
    deliveries.add(url)
    void completeDesktopSignIn(url, apiBase).then(onSignedIn).catch((reason: unknown) => {
      deliveries.delete(url)
      onError(reason instanceof Error && reason.message.trim() ? reason.message : 'Sign-in could not be completed. Please try again.')
    })
  }
  const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')
  const unlistenDeepLink = await onOpenUrl((urls) => {
    for (const url of urls) handle(url)
  })
  const { listen } = await import('@tauri-apps/api/event')
  const unlistenColdStart = await listen<string>('manorama://deep-link', (event) => handle(event.payload))
  // Rust setup can emit before this hydrated listener mounts. Reading the
  // current URLs after installation closes that race; delivery is deduped.
  for (const url of await getCurrent().catch(() => null) ?? []) handle(url)
  return async () => {
    unlistenDeepLink()
    unlistenColdStart()
  }
}
