import type { D1Database } from '@cloudflare/workers-types'
import type { AuthProvider } from './identity-repository'
import type { UserRepositoryEnv } from './user-repository'

/**
 * Single-use server-side OAuth transactions. The provider redirect only
 * carries the `state` key; everything the callback needs — nonce, PKCE
 * verifier, native/desktop handoff flavour, post-login destination — sits
 * in `auth_flows` (D1) behind that key. Consuming is a DELETE, so a state
 * can never be replayed, and no OAuth state lives in cookies.
 */

export const AUTH_FLOW_TTL_SECONDS = 600

export type AuthFlowIntent = 'signin' | 'link'
export type AuthFlowNative = '' | '1' | 'desktop'

export type AuthFlow = {
  state: string
  provider: AuthProvider
  intent: AuthFlowIntent
  /** Set iff intent === 'link': the account the new identity binds to. */
  accountId?: string
  nonce: string
  /** Provider-side PKCE verifier (Google only). */
  codeVerifier?: string
  /** Desktop PKCE code_challenge the handoff token is bound to. */
  appChallenge?: string
  native: AuthFlowNative
  nextUrl?: string
}

export type AuthFlowInput = {
  provider: AuthProvider
  intent: AuthFlowIntent
  accountId?: string
  native?: string
  appChallenge?: string
  next?: string
}

const PROVIDERS: readonly string[] = ['dropbox', 'google', 'apple']
const APP_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const NEXT_MAX = 2048

const randomHex = (bytes: number) => {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('')
}

const randomBase64Url = (bytes: number) => {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** RFC 7636 S256: BASE64URL(SHA-256(verifier)), 43 characters. */
export const pkceChallenge = async (verifier: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const checked = (input: AuthFlowInput) => {
  if (!PROVIDERS.includes(input.provider)) throw new Error('Unsupported identity provider')
  if (input.intent !== 'signin' && input.intent !== 'link') throw new Error('Unsupported auth intent')
  const native = input.native ?? ''
  if (native !== '' && native !== '1' && native !== 'desktop') throw new Error('Unsupported native handoff')
  const accountId = input.accountId?.trim() || undefined
  if (input.intent === 'link' && !accountId) throw new Error('Linking requires a signed-in account')
  // Linking is web-only for now: the callback re-verifies the browser
  // session, so a native or desktop handoff would be meaningless.
  if (input.intent === 'link' && native !== '') throw new Error('Linking is not available from a client handoff')
  const appChallenge = input.appChallenge?.trim() || undefined
  if (native === 'desktop') {
    // The callback cannot mint a desktop handoff without the app's
    // challenge bound into it — refuse the flow up front.
    if (!appChallenge || !APP_CHALLENGE_PATTERN.test(appChallenge)) {
      throw new Error('Invalid desktop code challenge')
    }
  } else if (appChallenge !== undefined) {
    throw new Error('A code challenge only applies to a desktop handoff')
  }
  const next = input.next?.trim() || undefined
  if (next && next.length > NEXT_MAX) throw new Error('Invalid post-sign-in destination')
  return {
    provider: input.provider,
    intent: input.intent,
    accountId,
    native: native as AuthFlowNative,
    appChallenge,
    nextUrl: next,
  }
}

// In-memory fallback for runtimes without the D1 binding (vite dev, tests).
const memoryFlows = new Map<string, AuthFlow & { expiresAtMs: number }>()

const d1Configured = (env?: UserRepositoryEnv): env is UserRepositoryEnv & { DB: D1Database } =>
  Boolean(env?.DB)

type FlowRow = {
  state: string
  provider: string
  intent: string
  account_id: string | null
  nonce: string
  code_verifier: string | null
  app_challenge: string | null
  native: string
  next_url: string | null
}

const rowToFlow = (row: FlowRow): AuthFlow => ({
  state: row.state,
  provider: row.provider as AuthProvider,
  intent: row.intent as AuthFlowIntent,
  nonce: row.nonce,
  native: row.native as AuthFlowNative,
  ...(row.account_id ? { accountId: row.account_id } : {}),
  ...(row.code_verifier ? { codeVerifier: row.code_verifier } : {}),
  ...(row.app_challenge ? { appChallenge: row.app_challenge } : {}),
  ...(row.next_url ? { nextUrl: row.next_url } : {}),
})

const purgeMemoryFlows = (nowMs: number) => {
  for (const [state, flow] of memoryFlows) {
    if (flow.expiresAtMs <= nowMs) memoryFlows.delete(state)
  }
}

/**
 * Opens a transaction. Google flows also get a PKCE code verifier; the
 * challenge derived from it is what Google sees, the verifier itself never
 * leaves this table until the callback exchanges the code.
 * Expired rows are purged opportunistically here — there is no sweeper.
 */
export const createAuthFlow = async (
  input: AuthFlowInput,
  env?: UserRepositoryEnv,
  ttlSeconds = AUTH_FLOW_TTL_SECONDS,
): Promise<{ state: string; nonce: string; codeVerifier?: string }> => {
  const flow = checked(input)
  const state = randomHex(32)
  const nonce = randomHex(32)
  // 32 bytes → 43 base64url characters: inside the RFC 7636 43–128 window.
  const codeVerifier = flow.provider === 'google' ? randomBase64Url(32) : undefined
  if (d1Configured(env)) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_flows WHERE expires_at <= datetime('now')"),
      env.DB.prepare(
        `INSERT INTO auth_flows
           (state, provider, intent, account_id, nonce, code_verifier, app_challenge, native, next_url, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      ).bind(
        state,
        flow.provider,
        flow.intent,
        flow.accountId ?? null,
        nonce,
        codeVerifier ?? null,
        flow.appChallenge ?? null,
        flow.native,
        flow.nextUrl ?? null,
        `${ttlSeconds >= 0 ? '+' : ''}${ttlSeconds} seconds`,
      ),
    ])
  } else {
    purgeMemoryFlows(Date.now())
    memoryFlows.set(state, {
      state,
      provider: flow.provider,
      intent: flow.intent,
      nonce,
      native: flow.native,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
      ...(flow.accountId ? { accountId: flow.accountId } : {}),
      ...(codeVerifier ? { codeVerifier } : {}),
      ...(flow.appChallenge ? { appChallenge: flow.appChallenge } : {}),
      ...(flow.nextUrl ? { nextUrl: flow.nextUrl } : {}),
    })
  }
  return { state, nonce, ...(codeVerifier ? { codeVerifier } : {}) }
}

/**
 * Closes a transaction exactly once. The DELETE … RETURNING is the
 * single-use guarantee: an unknown, consumed, or expired state all come
 * back null, and a consumed state is gone before any provider call runs.
 */
export const consumeAuthFlow = async (
  state: string,
  env?: UserRepositoryEnv,
): Promise<AuthFlow | null> => {
  if (typeof state !== 'string' || !state.trim()) return null
  if (d1Configured(env)) {
    const row = await env.DB.prepare(
      `DELETE FROM auth_flows WHERE state = ? AND expires_at > datetime('now')
       RETURNING state, provider, intent, account_id, nonce, code_verifier, app_challenge, native, next_url`,
    ).bind(state).first<FlowRow>()
    return row ? rowToFlow(row) : null
  }
  const flow = memoryFlows.get(state)
  memoryFlows.delete(state)
  if (!flow || flow.expiresAtMs <= Date.now()) return null
  const { expiresAtMs: _expiresAtMs, ...rest } = flow
  return rest
}

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetAuthFlowStore = () => {
  memoryFlows.clear()
}
