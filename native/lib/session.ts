const SESSION_TOKEN_KEY = 'manorama.session-token'

/** Storage seam for native auth. Issue #15 replaces this browser fallback with
 * Capacitor Preferences-backed secure storage without changing API callers. */
export const getSessionToken = (): string | undefined => {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const token = localStorage.getItem(SESSION_TOKEN_KEY)?.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

export const setSessionToken = (token: string): void => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token)
  } catch {
    // Storage failure must not break public galleries.
  }
}

export const clearSessionToken = (): void => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // Storage failure must not break public galleries.
  }
}
