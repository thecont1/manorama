import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import type { AuthProvider } from '../../app/lib/identity-repository'

export type { AuthProvider }

type NativeTokenResponse = { token?: string; ownerSlug?: string }
const SESSION_TOKEN_KEY = 'manorama.session-token'
const OWNER_SLUG_KEY = 'manorama.owner-slug'
const PENDING_QUICK_ADD_KEY = 'manorama.pending-quick-add'
export const NATIVE_CALLBACK_URL = 'in.thecontrarian.manorama://auth/callback'
export type NativeGallerySelection =
  | { owner: string; slug: string }
  | { kind: 'quick-add'; sourceUrl: string }

const supportedQuickAddSource = (sourceUrl: string): boolean => {
  try {
    const source = new URL(sourceUrl)
    if (source.protocol !== 'https:') return false
    const host = source.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'dropbox.com') return /^\/(?:scl\/fo|sh)\//.test(source.pathname)
    if (host === 'drive.google.com') {
      return /^\/drive\/folders\//.test(source.pathname) || (source.pathname === '/open' && Boolean(source.searchParams.get('id')))
    }
    if (host === 'icloud.com') return source.pathname.startsWith('/sharedalbum/')
    if (host === 'share.icloud.com') return source.pathname.startsWith('/photos/')
    if (host === 'mega.nz' || host === 'mega.co.nz') return /^\/(?:folder|collection)\//.test(source.pathname)
    return false
  } catch {
    return false
  }
}

/** Rebuild the source from the intentionally wrapped Manorama path. Provider
 * URLs themselves never reach this parser because their hostname is checked
 * first; only a conscious `manorama.xyz/<provider-url>` action qualifies. */
export const quickAddSelectionFromDeepLink = (url: URL): NativeGallerySelection | null => {
  let candidate = url.pathname.replace(/^\/+/, '')
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // Keep malformed escapes opaque and reject them below if they do not form a URL.
  }
  candidate = candidate.replace(/^(https?):\/+/i, '$1://')
  if (!/^https?:\/\//i.test(candidate)) return null
  const sourceUrl = `${candidate}${url.search}${url.hash}`
  return supportedQuickAddSource(sourceUrl) ? { kind: 'quick-add', sourceUrl } : null
}

/** Accept only public Manorama gallery URLs. Auth callbacks and arbitrary
 * external HTTPS links must never be turned into gallery selections. */
export const gallerySelectionFromDeepLink = (
  rawUrl: string,
  apiBase = 'https://manorama.xyz',
): NativeGallerySelection | null => {
  try {
    const url = new URL(rawUrl)
    const expected = new URL(`${apiBase.replace(/\/+$/, '')}/`)
    if (url.protocol !== 'https:' || url.hostname !== expected.hostname) return null
    const quickAdd = quickAddSelectionFromDeepLink(url)
    if (quickAdd) return quickAdd
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || url.search || url.hash) return null
    const [owner, slug] = parts
    if (!owner || !slug || !/^[a-z0-9-]+$/i.test(owner) || !/^[a-z0-9-]+$/i.test(slug)) return null
    return { owner, slug }
  } catch {
    return null
  }
}

export const authErrorMessage = (reason: unknown): string =>
  reason instanceof Error && reason.message.trim() ? reason.message : 'Sign-in could not be completed. Please try again.'

export const getSessionToken = async (): Promise<string | undefined> => {
  try {
    const token = await SecureStorage.getItem(SESSION_TOKEN_KEY)
    return token?.trim() || undefined
  } catch {
    return undefined
  }
}

export const setSessionToken = async (token: string): Promise<void> => {
  const trimmed = token.trim()
  if (!trimmed) return
  await SecureStorage.setItem(SESSION_TOKEN_KEY, trimmed)
}

const clearOwnerSlug = async (): Promise<void> => {
  try {
    await SecureStorage.removeItem(OWNER_SLUG_KEY)
  } catch {
    // A missing slug is already the desired signed-out state.
  }
}

export const clearSessionToken = async (): Promise<void> => {
  try {
    await SecureStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // A missing token is already the desired signed-out state.
  }
  // The owner slug only has meaning beside a live token; tearing the
  // session down clears both so a different account can never inherit it.
  await clearOwnerSlug()
  await clearPendingQuickAdd()
}

/** The public URL stem the account's own galleries live under, persisted
 *  at exchange time so the app can build `{owner}/{slug}` selections. */
export const getOwnerSlug = async (): Promise<string | undefined> => {
  try {
    const slug = await SecureStorage.getItem(OWNER_SLUG_KEY)
    return slug?.trim() || undefined
  } catch {
    return undefined
  }
}

export const setOwnerSlug = async (slug: string): Promise<void> => {
  const trimmed = slug.trim()
  if (!trimmed) return
  await SecureStorage.setItem(OWNER_SLUG_KEY, trimmed)
}

export const getPendingQuickAdd = async (): Promise<string | undefined> => {
  try {
    const sourceUrl = await SecureStorage.getItem(PENDING_QUICK_ADD_KEY)
    return sourceUrl && supportedQuickAddSource(sourceUrl) ? sourceUrl : undefined
  } catch {
    return undefined
  }
}

export const setPendingQuickAdd = async (sourceUrl: string): Promise<void> => {
  if (supportedQuickAddSource(sourceUrl)) await SecureStorage.setItem(PENDING_QUICK_ADD_KEY, sourceUrl)
}

export const clearPendingQuickAdd = async (): Promise<void> => {
  try {
    await SecureStorage.removeItem(PENDING_QUICK_ADD_KEY)
  } catch {
    // A missing pending import is already the desired state.
  }
}

export const getSessionAppUserId = async (): Promise<string | undefined> => {
  const token = await getSessionToken()
  const encodedPayload = token?.split('.')[1]
  if (!encodedPayload) return undefined
  try {
    const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub : undefined
  } catch {
    return undefined
  }
}

export const beginProviderSignIn = async (provider: AuthProvider, apiBase: string): Promise<void> => {
  const url = new URL(`/auth/${provider}`, `${apiBase.replace(/\/+$/, '')}/`)
  url.searchParams.set('native', '1')
  await Browser.open({ url: url.toString(), toolbarColor: '#0a0a0a', presentationStyle: 'fullscreen' })
}

/** getLaunchUrl answers the URL that most recently opened the app, so a
 *  remount after window.location.reload() sees a completed sign-in's handoff
 *  again. The claim has to live in sessionStorage — module state dies with the
 *  reload — or every exchange reloads into the next one forever. */
const HANDLED_HANDOFF_KEY = 'manorama.native.handoff'
const handledHandoffs = new Set<string>()

const claimHandoff = (token: string): boolean => {
  if (handledHandoffs.has(token)) return false
  try {
    if (globalThis.sessionStorage?.getItem(HANDLED_HANDOFF_KEY) === token) return false
    globalThis.sessionStorage?.setItem(HANDLED_HANDOFF_KEY, token)
  } catch {
    // Storage can be unavailable; the in-memory set still dedupes within this mount.
  }
  handledHandoffs.add(token)
  return true
}

const releaseHandoff = (token: string): void => {
  handledHandoffs.delete(token)
  try {
    if (globalThis.sessionStorage?.getItem(HANDLED_HANDOFF_KEY) === token) {
      globalThis.sessionStorage.removeItem(HANDLED_HANDOFF_KEY)
    }
  } catch {
    // A missed release just leaves the token claimed; a fresh sign-in mints a new one.
  }
}

const exchangeHandoff = async (url: string, apiBase: string): Promise<boolean> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'in.thecontrarian.manorama:' || parsed.hostname !== 'auth') return false
  const handoffToken = parsed.searchParams.get('handoff')?.trim()
  if (!handoffToken || !claimHandoff(handoffToken)) return false
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, '')}/api/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoffToken }),
    })
    const payload = await response.json().catch(() => ({})) as NativeTokenResponse & { error?: string }
    if (!response.ok || !payload.token) throw new Error(payload.error || 'Native sign-in could not be completed')
    try {
      await setSessionToken(payload.token)
      // The exchange always answers with the account's owner slug; dropping a
      // stale one matters when a previous sign-in outlived its token.
      if (payload.ownerSlug) await setOwnerSlug(payload.ownerSlug)
      else await clearOwnerSlug()
    } finally {
      await Browser.close().catch(() => undefined)
    }
    return true
  } catch (error) {
    // A failed exchange releases the claim so a redelivered URL can retry.
    releaseHandoff(handoffToken)
    throw error
  }
}

export const installNativeAuth = async (
  apiBase: string,
  onError?: (message: string) => void,
  onGalleryOpen?: (selection: NativeGallerySelection) => void,
): Promise<() => Promise<void>> => {
  const reportError = (reason: unknown) => onError?.(authErrorMessage(reason))
  const handleUrl = (url: string) => {
    const selection = gallerySelectionFromDeepLink(url, apiBase)
    if (selection) {
      if ('kind' in selection && selection.kind === 'quick-add') void setPendingQuickAdd(selection.sourceUrl)
      onGalleryOpen?.(selection)
      return
    }
    void exchangeHandoff(url, apiBase)
      .then((handled) => {
        if (handled && typeof window !== 'undefined') window.location.reload()
      })
      .catch(reportError)
  }
  const listener = await App.addListener('appUrlOpen', ({ url }) => handleUrl(url))
  const launch = await App.getLaunchUrl()
  if (launch?.url) handleUrl(launch.url)
  return async () => listener.remove()
}

export const __private__ = {
  exchangeHandoff,
  /** Clears the in-memory claim set so tests can simulate a page reload,
   *  which wipes module state but preserves sessionStorage. */
  resetHandledHandoffs: () => handledHandoffs.clear(),
}
