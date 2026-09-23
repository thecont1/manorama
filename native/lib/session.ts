import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'

type NativeTokenResponse = {
  token?: string
  ownerSlug?: string
}

const SESSION_TOKEN_KEY = 'manorama.session-token'
export const NATIVE_CALLBACK_URL = 'in.thecontrarian.manorama://auth/callback'

/**
 * The mobile session is a Worker-issued bearer token stored in iOS Keychain or
 * Android Keystore. The plugin's localStorage web implementation is only a
 * development fallback; native builds never use browser storage for tokens.
 */
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

export const clearSessionToken = async (): Promise<void> => {
  try {
    await SecureStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // A missing token is already the desired signed-out state.
  }
}

export const beginDropboxSignIn = async (apiBase: string): Promise<void> => {
  const url = new URL('/auth/dropbox', `${apiBase.replace(/\/+$/, '')}/`)
  url.searchParams.set('native', '1')
  await Browser.open({
    url: url.toString(),
    toolbarColor: '#0a0a0a',
    presentationStyle: 'fullscreen',
  })
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
  if (!handoffToken) return false

  const response = await fetch(`${apiBase.replace(/\/+$/, '')}/api/auth/native/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffToken }),
  })
  const payload = await response.json().catch(() => ({})) as NativeTokenResponse & { error?: string }
  if (!response.ok || !payload.token) throw new Error(payload.error || 'Native sign-in could not be completed')
  await setSessionToken(payload.token)
  await Browser.close().catch(() => undefined)
  return true
}

/** Installs both cold-start and warm deep-link handling for the OAuth return. */
export const installNativeAuth = async (apiBase: string): Promise<() => Promise<void>> => {
  const listener = await App.addListener('appUrlOpen', ({ url }) => {
    void exchangeHandoff(url, apiBase)
      .then((handled) => {
        if (handled && typeof window !== 'undefined') window.location.reload()
      })
      .catch(() => undefined)
  })
  const launch = await App.getLaunchUrl()
  if (launch?.url) {
    await exchangeHandoff(launch.url, apiBase)
      .then((handled) => {
        if (handled && typeof window !== 'undefined') window.location.reload()
      })
      .catch(() => undefined)
  }
  return async () => listener.remove()
}

export const __private__ = { exchangeHandoff }
