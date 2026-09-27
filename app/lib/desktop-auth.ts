import { jwtVerify, SignJWT } from 'jose'
import { NATIVE_HANDOFF_TTL_SECONDS, sessionKey } from './dropbox-session'

export const DESKTOP_CALLBACK = 'in.thecontrarian.manorama.desktop://auth/callback'
export const DESKTOP_CHALLENGE_COOKIE = 'manorama_oauth_desktop_challenge'

export const isDesktopChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export const desktopCodeChallenge = async (verifier: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const DESKTOP_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

export const createDesktopHandoffToken = (dropboxAccountId: string, secret: string, codeChallenge: string) => {
  if (!isDesktopChallenge(codeChallenge)) throw new Error('A desktop handoff requires a valid code challenge')
  return new SignJWT({ sub: dropboxAccountId, typ: 'desktop-handoff', codeChallenge })
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
