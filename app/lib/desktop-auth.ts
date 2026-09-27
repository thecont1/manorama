import { jwtVerify, SignJWT } from 'jose'
import { pkceChallenge } from './auth-flows'
import { NATIVE_HANDOFF_TTL_SECONDS, sessionKey } from './session'

/**
 * The desktop (Tauri) sign-in handoff. The OAuth callback cannot mint a
 * bearer session into the app directly, so it redirects to the desktop
 * URL scheme carrying a one-minute, purpose-bound token that embeds the
 * app's PKCE code_challenge. The app then POSTs the token plus its secret
 * verifier to /api/auth/desktop/exchange and gets the normal session —
 * the token is worthless to anyone who does not hold the verifier.
 */

export const DESKTOP_CALLBACK = 'in.thecontrarian.manorama.desktop://auth/callback'

export const isDesktopChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export const desktopCodeChallenge = pkceChallenge

const DESKTOP_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

export const createDesktopHandoffToken = (accountId: string, secret: string, codeChallenge: string) => {
  if (!isDesktopChallenge(codeChallenge)) throw new Error('A desktop handoff requires a valid code challenge')
  return new SignJWT({ sub: accountId, typ: 'desktop-handoff', codeChallenge })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${NATIVE_HANDOFF_TTL_SECONDS}s`)
    .sign(sessionKey(secret))
}

export const verifyDesktopHandoffToken = async (token: string, secret: string, verifier: string) => {
  if (typeof verifier !== 'string' || !DESKTOP_VERIFIER_PATTERN.test(verifier)) return null
  try {
    const { payload } = await jwtVerify(token, sessionKey(secret), { algorithms: ['HS256'] })
    if (payload.typ !== 'desktop-handoff') return null
    if (!isDesktopChallenge(payload.codeChallenge)) return null
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    return (await desktopCodeChallenge(verifier)) === payload.codeChallenge ? payload.sub : null
  } catch {
    return null
  }
}
