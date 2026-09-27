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

export type DesktopSession = { token: string; ownerSlug: string }

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
  const url = new URL(`/auth/${provider}`, `${normalizeApiBase(apiBase)}/`)
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

type ExchangeResponse = { token?: string; ownerSlug?: string; error?: string }

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
    throw new Error('Sign-in could not be completed. Please try again.')
  }
  return { token: payload.token, ownerSlug: typeof payload.ownerSlug === 'string' ? payload.ownerSlug : '' }
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
      ? { token: parsed.token, ownerSlug: typeof parsed.ownerSlug === 'string' ? parsed.ownerSlug : '' }
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
  await openUrl(buildDesktopAuthUrl(provider, apiBase, challenge))
}

export const completeDesktopSignIn = async (url: string, apiBase: string): Promise<DesktopSession> => {
  const handoff = handoffFromDeepLink(url)
  if (!handoff) throw new Error('Sign-in could not be completed. Please try again.')
  const pending = pendingSignIn
  if (!pending) throw new Error('Sign-in could not be completed. Please try again.')
  const session = await exchangeDesktopHandoff(handoff, pending.verifier, apiBase)
  pendingSignIn = null
  await storeSession(session)
  return session
}

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
): Promise<() => Promise<void>> => {
  const handle = (url: string) => {
    void completeDesktopSignIn(url, apiBase).then(onSignedIn).catch((reason: unknown) => {
      onError(reason instanceof Error && reason.message.trim() ? reason.message : 'Sign-in could not be completed. Please try again.')
    })
  }
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  const unlistenDeepLink = await onOpenUrl((urls) => {
    for (const url of urls) handle(url)
  })
  const { listen } = await import('@tauri-apps/api/event')
  const unlistenColdStart = await listen<string>('manorama://deep-link', (event) => handle(event.payload))
  return async () => {
    unlistenDeepLink()
    unlistenColdStart()
  }
}
