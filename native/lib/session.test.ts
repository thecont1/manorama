import { describe, expect, test } from 'bun:test'
import { NATIVE_CALLBACK_URL, __private__, authErrorMessage, beginProviderSignIn } from './session'

describe('beginProviderSignIn', () => {
  test('opens the chosen provider auth route with the native handoff flag', async () => {
    const opened: string[] = []
    const realWindow = globalThis.window
    // The Capacitor web fallback calls window.open; stub it to capture the URL.
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: { open: (url: string) => { opened.push(url); return null } },
    })
    try {
      await beginProviderSignIn('apple', 'https://manorama.xyz/')
      await beginProviderSignIn('google', 'https://manorama.xyz')
      await beginProviderSignIn('dropbox', 'https://manorama.xyz')
      expect(opened).toEqual([
        'https://manorama.xyz/auth/apple?native=1',
        'https://manorama.xyz/auth/google?native=1',
        'https://manorama.xyz/auth/dropbox?native=1',
      ])
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: realWindow })
    }
  })
})

describe('native OAuth callback', () => {
  test('uses the manorama custom scheme and auth host', () => {
    const url = new URL(`${NATIVE_CALLBACK_URL}?handoff=abc`)
    expect(url.protocol).toBe('in.thecontrarian.manorama:')
    expect(url.hostname).toBe('auth')
    expect(url.searchParams.get('handoff')).toBe('abc')
  })

  test('ignores unrelated deep links before making a request', async () => {
    const fetcher = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch
    try {
      expect(await __private__.exchangeHandoff('https://manorama.xyz/', 'https://manorama.xyz')).toBe(false)
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = fetcher
    }
  })

  test('propagates secure-storage failure after a valid exchange', async () => {
    const fetcher = globalThis.fetch
    const localStorage = globalThis.localStorage
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token: 'signed-session-token' }), { status: 200 })
    ) as typeof fetch
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { setItem: () => { throw new Error('Secure storage is unavailable') } },
    })
    try {
      await expect(
        __private__.exchangeHandoff(`${NATIVE_CALLBACK_URL}?handoff=abc`, 'https://manorama.xyz'),
      ).rejects.toThrow('Secure storage is unavailable')
      expect(authErrorMessage(new Error('Secure storage is unavailable'))).toBe('Secure storage is unavailable')
    } finally {
      globalThis.fetch = fetcher
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
    }
  })
})
