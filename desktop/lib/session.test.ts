import { describe, expect, test } from 'bun:test'
import {
  buildDesktopAuthUrl,
  exchangeDesktopHandoff,
  generateCodeVerifier,
  handoffFromDeepLink,
  normalizeApiBase,
  pkceChallenge,
  DESKTOP_AUTH_PROVIDERS,
} from './session'

describe('PKCE', () => {
  test('verifier is 43 base64url characters inside the RFC 7636 window', () => {
    for (let i = 0; i < 20; i++) {
      const verifier = generateCodeVerifier()
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
    }
    expect(new Set(Array.from({ length: 10 }, generateCodeVerifier)).size).toBe(10)
  })

  test('challenge matches the RFC 7636 S256 test vector', async () => {
    // From RFC 7636 appendix B — the same transform auth-flows.ts performs.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  test('verifier → challenge roundtrip is stable and b64url', async () => {
    const verifier = generateCodeVerifier()
    const challenge = await pkceChallenge(verifier)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).not.toContain('+')
    expect(challenge).not.toContain('/')
    expect(challenge).not.toContain('=')
  })
})

describe('buildDesktopAuthUrl', () => {
  test('targets the provider auth route with the desktop handoff params', () => {
    for (const provider of DESKTOP_AUTH_PROVIDERS) {
      const url = buildDesktopAuthUrl(provider, 'https://manorama.xyz/', 'CHALLENGE_CHALLENGE_CHALLENGE_CHALLENGE_43')
      expect(url).toBe(`https://manorama.xyz/auth/${provider}?native=desktop&code_challenge=CHALLENGE_CHALLENGE_CHALLENGE_CHALLENGE_43`)
    }
    expect(normalizeApiBase('https://manorama.xyz///')).toBe('https://manorama.xyz')
  })
})

describe('handoffFromDeepLink', () => {
  test('accepts only our scheme, host, and path', () => {
    expect(handoffFromDeepLink('in.thecontrarian.manorama.desktop://auth/callback?handoff=abc123')).toBe('abc123')
    expect(handoffFromDeepLink('https://manorama.xyz/auth/callback?handoff=abc')).toBeNull()
    expect(handoffFromDeepLink('in.thecontrarian.manorama.desktop://evil/callback?handoff=abc')).toBeNull()
    expect(handoffFromDeepLink('in.thecontrarian.manorama.desktop://auth/other?handoff=abc')).toBeNull()
    expect(handoffFromDeepLink('in.thecontrarian.manorama.desktop://auth/callback')).toBeNull()
    expect(handoffFromDeepLink('not a url')).toBeNull()
    expect(handoffFromDeepLink('in.thecontrarian.manorama.desktop://auth/callback.evil?handoff=abc')).toBeNull()
  })
})

describe('exchangeDesktopHandoff', () => {
  const captureFetch = (response: Response) => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return response
    }) as typeof fetch
    return { calls, fetcher }
  }

  test('POSTs handoffToken and codeVerifier to the desktop exchange', async () => {
    const { calls, fetcher } = captureFetch(
      new Response(JSON.stringify({ token: 'session-token', ownerSlug: 'owner' }), { status: 200 }),
    )
    const session = await exchangeDesktopHandoff('handoff-token', 'verifier-value', 'https://manorama.xyz/', fetcher)
    expect(session).toEqual({ token: 'session-token', ownerSlug: 'owner' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://manorama.xyz/api/auth/desktop/exchange')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      handoffToken: 'handoff-token',
      codeVerifier: 'verifier-value',
    })
    // Exactly these two fields — nothing else rides along.
    expect(Object.keys(JSON.parse(calls[0]!.init?.body as string)).sort()).toEqual(['codeVerifier', 'handoffToken'])
  })

  test('rejects failures and missing tokens with the generic message', async () => {
    const { fetcher: unauthorized } = captureFetch(new Response(JSON.stringify({ error: 'no' }), { status: 401 }))
    await expect(exchangeDesktopHandoff('h', 'v', 'https://manorama.xyz', unauthorized)).rejects.toThrow(
      'Sign-in could not be completed. Please try again.',
    )
    const { fetcher: noToken } = captureFetch(new Response(JSON.stringify({ ownerSlug: 'x' }), { status: 200 }))
    await expect(exchangeDesktopHandoff('h', 'v', 'https://manorama.xyz', noToken)).rejects.toThrow(
      'Sign-in could not be completed. Please try again.',
    )
  })
})
