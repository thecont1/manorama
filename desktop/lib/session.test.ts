import { describe, expect, test } from 'bun:test'
import {
  buildDesktopAuthUrl,
  exchangeDesktopHandoff,
  generateCodeVerifier,
  handoffFromDeepLink,
  normalizeApiBase,
  pkceChallenge,
  DESKTOP_AUTH_PROVIDERS,
  createDesktopSignInCompleter,
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
  test('uses the explicit seeded-account browser door only on approved loopback origins', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(new URL(buildDesktopAuthUrl('dropbox', origin, 'challenge')).pathname).toBe('/.dev-seed/desktop-login')
    }
    for (const origin of ['http://localhost:9999', 'https://localhost:5173', 'https://manorama.xyz']) {
      expect(new URL(buildDesktopAuthUrl('dropbox', origin, 'challenge')).pathname).toBe('/auth/dropbox')
    }
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

  test('distinguishes rejected sign-in links from malformed exchange responses', async () => {
    const { fetcher: unauthorized } = captureFetch(new Response(JSON.stringify({ error: 'no' }), { status: 401 }))
    await expect(exchangeDesktopHandoff('h', 'v', 'https://manorama.xyz', unauthorized)).rejects.toThrow(
      'This sign-in link has expired or does not match this app. Start sign-in again in this window.',
    )
    const { fetcher: noToken } = captureFetch(new Response(JSON.stringify({ ownerSlug: 'x' }), { status: 200 }))
    await expect(exchangeDesktopHandoff('h', 'v', 'https://manorama.xyz', noToken)).rejects.toThrow(
      'Sign-in could not be completed. Please try again.',
    )
    const { fetcher: unavailable } = captureFetch(new Response('{}', { status: 503 }))
    await expect(exchangeDesktopHandoff('h', 'v', 'https://manorama.xyz', unavailable)).rejects.toThrow('temporarily unavailable')
  })
})

describe('desktop sign-in callback completion', () => {
  const url = 'in.thecontrarian.manorama.desktop://auth/callback?handoff=one'
  const session = { token: 'bearer', ownerSlug: 'mahesh' }

  test('concurrent and replayed deliveries exchange and persist exactly once', async () => {
    let pending: { verifier: string; provider: 'dropbox'; startedAt: number } | null = { verifier: 'secret-verifier', provider: 'dropbox', startedAt: 1 }
    let exchanges = 0
    let stores = 0
    const complete = createDesktopSignInCompleter({
      pending: () => pending,
      exchange: async (_handoff, verifier) => { expect(verifier).toBe('secret-verifier'); exchanges++; await Promise.resolve(); return session },
      store: async () => { stores++ },
      consume: () => { pending = null },
    })
    const first = complete(url, 'https://manorama.xyz')
    expect(complete(url, 'https://manorama.xyz/')).toBe(first)
    expect(await first).toEqual(session)
    expect(await complete(url, 'https://manorama.xyz')).toEqual(session)
    expect(exchanges).toBe(1)
    expect(stores).toBe(1)
    expect(pending).toBeNull()
  })

  test('storage failure keeps the verifier and a retry can complete', async () => {
    let pending: { verifier: string; provider: 'dropbox'; startedAt: number } | null = { verifier: 'v', provider: 'dropbox', startedAt: 1 }
    let stores = 0
    const complete = createDesktopSignInCompleter({
      pending: () => pending,
      exchange: async () => session,
      store: async () => { if (++stores === 1) throw new Error('Disk unavailable') },
      consume: () => { pending = null },
    })
    await expect(complete(url, 'https://manorama.xyz')).rejects.toThrow('Disk unavailable')
    expect(pending).not.toBeNull()
    expect(await complete(url, 'https://manorama.xyz')).toEqual(session)
    expect(pending).toBeNull()
  })

  test('a cold callback asks for a new app-initiated flow without exchanging', async () => {
    let exchanges = 0
    const complete = createDesktopSignInCompleter({
      pending: () => null,
      exchange: async () => { exchanges++; return session },
      store: async () => {}, consume: () => {},
    })
    await expect(complete(url, 'https://manorama.xyz')).rejects.toThrow('Start sign-in in this app window first')
    expect(exchanges).toBe(0)
  })

  test('completion of an old flow cannot consume the newer verifier', async () => {
    const old = { verifier: 'old', provider: 'dropbox' as const, startedAt: 1 }
    const newer = { verifier: 'new', provider: 'google' as const, startedAt: 2 }
    let pending: typeof old | typeof newer | null = old
    let resolve!: (value: typeof session) => void
    const complete = createDesktopSignInCompleter({
      pending: () => pending,
      exchange: () => new Promise(done => { resolve = done }),
      store: async () => {},
      consume: flow => { if (pending === flow) pending = null },
    })
    const work = complete(url, 'https://manorama.xyz')
    pending = newer
    resolve(session)
    await work
    expect(pending).toBe(newer)
  })
})
