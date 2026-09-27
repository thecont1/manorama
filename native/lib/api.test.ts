import { afterEach, describe, expect, test } from 'bun:test'
import { fetchAccountGalleries, fetchDeviceGalleries, fetchGallery, NativeGalleryHttpError } from './api'

const originalFetch = globalThis.fetch
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

const STORAGE_PREFIX = 'capacitor-storage_'
const TOKEN_KEY = `${STORAGE_PREFIX}manorama.session-token`

/** The SecureStorage web fallback persists under prefixed localStorage keys;
 *  the tests stand in for it the same way the browser preview does. */
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

type Call = { url: string; init?: RequestInit }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fetchSpy = (handler: (url: string) => Response) => {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    return handler(url)
  }) as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreLocalStorage()
})

describe('native gallery HTTP errors', () => {
  test('preserves the response status for non-OK gallery responses', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Gallery has gone' }), {
      status: 410,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    const opening = fetchGallery('https://manorama.xyz', 'photographer', 'quiet-light')

    await expect(opening).rejects.toBeInstanceOf(NativeGalleryHttpError)
    await expect(opening).rejects.toMatchObject({ status: 410, message: 'Gallery has gone' })
  })
})

describe('fetchAccountGalleries', () => {
  test('requests the session gallery list with the stored bearer token', async () => {
    const storage = installLocalStorage()
    storage.set(TOKEN_KEY, 'session-token-1')
    const summary = { slug: 'kashmir', title: 'Kashmir', imageCount: 12 }
    const calls = fetchSpy(() => json({ galleries: [summary] }))

    const galleries = await fetchAccountGalleries('https://manorama.xyz/')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://manorama.xyz/api/galleries')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    expect(galleries).toEqual([summary])
  })

  test('sends no Authorization header when no session is stored', async () => {
    installLocalStorage()
    const calls = fetchSpy(() => json({ galleries: [] }))

    const galleries = await fetchAccountGalleries('https://manorama.xyz')

    expect(calls[0].init?.headers).toBeUndefined()
    expect(galleries).toEqual([])
  })

  test('maps a non-OK response to NativeGalleryHttpError with the server message', async () => {
    installLocalStorage()
    fetchSpy(() => json({ error: 'The gallery list is temporarily unavailable' }, 503))

    const listing = fetchAccountGalleries('https://manorama.xyz')

    await expect(listing).rejects.toBeInstanceOf(NativeGalleryHttpError)
    await expect(listing).rejects.toMatchObject({ status: 503, message: 'The gallery list is temporarily unavailable' })
  })

  test('rejects a response without a galleries array', async () => {
    installLocalStorage()
    fetchSpy(() => json({}))

    await expect(fetchAccountGalleries('https://manorama.xyz')).rejects.toThrow('Gallery list response was incomplete')
  })
})

describe('fetchDeviceGalleries', () => {
  const device = {
    id: '12345678-1234-1234-1234-1234567890ab',
    title: 'Living room folder',
    sourceKind: 'folder',
    itemCount: 34,
    deviceId: '87654321-4321-4321-4321-ba0987654321',
    deviceLabel: "Mahesh's Mac Studio",
    publicGallerySlug: 'mac-light',
    updatedAt: '2026-10-01T00:00:00Z',
  }

  test('requests the bearer-only device catalogue with the stored token', async () => {
    const storage = installLocalStorage()
    storage.set(TOKEN_KEY, 'session-token-1')
    const calls = fetchSpy(() => json({ galleries: [device] }))

    const galleries = await fetchDeviceGalleries('https://manorama.xyz/')

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://manorama.xyz/api/device-galleries')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token-1')
    expect(galleries).toEqual([device])
  })

  test('maps a non-OK response to NativeGalleryHttpError', async () => {
    installLocalStorage()
    fetchSpy(() => json({ error: 'Authentication required' }, 401))

    const listing = fetchDeviceGalleries('https://manorama.xyz')

    await expect(listing).rejects.toBeInstanceOf(NativeGalleryHttpError)
    await expect(listing).rejects.toMatchObject({ status: 401, message: 'Authentication required' })
  })

  test('rejects a response without a galleries array', async () => {
    installLocalStorage()
    fetchSpy(() => json({ galleries: 'not-an-array' }))

    await expect(fetchDeviceGalleries('https://manorama.xyz')).rejects.toThrow('Device gallery list response was incomplete')
  })
})
