import { describe, expect, test } from 'bun:test'
import {
  NATIVE_CALLBACK_URL,
  __private__,
  authErrorMessage,
  beginProviderSignIn,
  clearSessionToken,
  getOwnerSlug,
  getSessionToken,
  gallerySelectionFromDeepLink,
  setOwnerSlug,
} from './session'

const TOKEN_KEY = 'capacitor-storage_manorama.session-token'
const SLUG_KEY = 'capacitor-storage_manorama.owner-slug'
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

/** The SecureStorage web fallback keeps prefixed keys in localStorage;
 *  this stub mirrors it the way the browser preview does. */
const installLocalStorage = () => {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() { return data.size },
      clear: () => data.clear(),
    },
  })
  return data
}
const restoreLocalStorage = () => {
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  } else {
    delete (globalThis as Record<string, unknown>).localStorage
  }
}

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
  test('extracts only a two-segment public gallery link', () => {
    expect(gallerySelectionFromDeepLink('https://manorama.xyz/thecontrarian/italy')).toEqual({
      owner: 'thecontrarian',
      slug: 'italy',
    })
    expect(gallerySelectionFromDeepLink('https://manorama.xyz/auth/callback?handoff=x')).toBeNull()
    expect(gallerySelectionFromDeepLink('https://example.com/thecontrarian/italy')).toBeNull()
    expect(gallerySelectionFromDeepLink('https://manorama.xyz/thecontrarian/italy?mode=single')).toBeNull()
    expect(gallerySelectionFromDeepLink('in.thecontrarian.manorama://auth/callback')).toBeNull()
  })

  test('accepts only a deliberate Manorama wrapper around a supported cloud folder', () => {
    expect(gallerySelectionFromDeepLink(
      'https://manorama.xyz/https://www.dropbox.com/scl/fo/lf77cf8mbwls8nwbcvq/AHmaVMMaxe926qhJvOiOHtw?rlkey=dvtkshg5wmht49rmyvgklri26&dl=0',
    )).toEqual({
      kind: 'quick-add',
      sourceUrl: 'https://www.dropbox.com/scl/fo/lf77cf8mbwls8nwbcvq/AHmaVMMaxe926qhJvOiOHtw?rlkey=dvtkshg5wmht49rmyvgklri26&dl=0',
    })
    expect(gallerySelectionFromDeepLink('https://www.dropbox.com/scl/fo/folder/key?rlkey=read-key')).toBeNull()
    expect(gallerySelectionFromDeepLink('https://manorama.xyz/https://dropbox.com/')).toBeNull()
    expect(gallerySelectionFromDeepLink('https://manorama.xyz/ftp://dropbox.com/scl/fo/folder/key')).toBeNull()
  })

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

  const installSessionStorage = () => {
    const data = new Map<string, string>()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
        setItem: (key: string, value: string) => void data.set(key, String(value)),
        removeItem: (key: string) => void data.delete(key),
        clear: () => data.clear(),
      },
    })
    return { data, restore: () => {
      if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
      else delete (globalThis as Record<string, unknown>).sessionStorage
    } }
  }

  test('a handoff delivered twice on one mount exchanges once', async () => {
    installLocalStorage()
    const fetcher = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ token: 'signed-session-token' }), { status: 200 })
    }) as typeof fetch
    try {
      const url = `${NATIVE_CALLBACK_URL}?handoff=double-delivery`
      expect(await __private__.exchangeHandoff(url, 'https://manorama.xyz')).toBe(true)
      expect(await __private__.exchangeHandoff(url, 'https://manorama.xyz')).toBe(false)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = fetcher
      restoreLocalStorage()
    }
  })

  test('a handoff replayed by getLaunchUrl after reload does not re-exchange', async () => {
    installLocalStorage()
    const session = installSessionStorage()
    const fetcher = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ token: 'signed-session-token' }), { status: 200 })
    }) as typeof fetch
    try {
      const url = `${NATIVE_CALLBACK_URL}?handoff=launch-replay`
      expect(await __private__.exchangeHandoff(url, 'https://manorama.xyz')).toBe(true)
      // window.location.reload() wipes module state but keeps sessionStorage.
      __private__.resetHandledHandoffs()
      expect(await __private__.exchangeHandoff(url, 'https://manorama.xyz')).toBe(false)
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = fetcher
      session.restore()
      restoreLocalStorage()
    }
  })

  test('a failed exchange releases the handoff so a redelivery can retry', async () => {
    installLocalStorage()
    const fetcher = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return calls === 1
        ? new Response(JSON.stringify({ error: 'temporary' }), { status: 500 })
        : new Response(JSON.stringify({ token: 'signed-session-token' }), { status: 200 })
    }) as typeof fetch
    try {
      const url = `${NATIVE_CALLBACK_URL}?handoff=retry-me`
      await expect(__private__.exchangeHandoff(url, 'https://manorama.xyz')).rejects.toThrow()
      expect(await __private__.exchangeHandoff(url, 'https://manorama.xyz')).toBe(true)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = fetcher
      restoreLocalStorage()
    }
  })
})

describe('owner slug persistence', () => {
  test('persists the owner slug returned by the native exchange beside the token', async () => {
    const data = installLocalStorage()
    const fetcher = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token: 'signed-session-token', ownerSlug: 'quiet-owner' }), { status: 200 })
    ) as typeof fetch
    try {
      expect(await __private__.exchangeHandoff(`${NATIVE_CALLBACK_URL}?handoff=abc`, 'https://manorama.xyz')).toBe(true)
      expect(data.get(TOKEN_KEY)).toBe('signed-session-token')
      expect(data.get(SLUG_KEY)).toBe('quiet-owner')
      expect(await getSessionToken()).toBe('signed-session-token')
      expect(await getOwnerSlug()).toBe('quiet-owner')
    } finally {
      globalThis.fetch = fetcher
      restoreLocalStorage()
    }
  })

  test('drops a stale owner slug when an exchange answers without one', async () => {
    const data = installLocalStorage()
    data.set(SLUG_KEY, 'previous-owner')
    const fetcher = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token: 'signed-session-token' }), { status: 200 })
    ) as typeof fetch
    try {
      expect(await __private__.exchangeHandoff(`${NATIVE_CALLBACK_URL}?handoff=def`, 'https://manorama.xyz')).toBe(true)
      expect(await getOwnerSlug()).toBeUndefined()
      expect(data.has(SLUG_KEY)).toBe(false)
    } finally {
      globalThis.fetch = fetcher
      restoreLocalStorage()
    }
  })

  test('clearSessionToken removes the owner slug with the token', async () => {
    const data = installLocalStorage()
    data.set(TOKEN_KEY, 'signed-session-token')
    data.set(SLUG_KEY, 'quiet-owner')
    try {
      await clearSessionToken()
      expect(data.has(TOKEN_KEY)).toBe(false)
      expect(data.has(SLUG_KEY)).toBe(false)
      expect(await getSessionToken()).toBeUndefined()
      expect(await getOwnerSlug()).toBeUndefined()
    } finally {
      restoreLocalStorage()
    }
  })

  test('getOwnerSlug ignores blank or missing values', async () => {
    const data = installLocalStorage()
    try {
      expect(await getOwnerSlug()).toBeUndefined()
      await setOwnerSlug('   ')
      expect(await getOwnerSlug()).toBeUndefined()
      await setOwnerSlug('quiet-owner')
      expect(await getOwnerSlug()).toBe('quiet-owner')
      expect(data.get(SLUG_KEY)).toBe('quiet-owner')
    } finally {
      restoreLocalStorage()
    }
  })
})
