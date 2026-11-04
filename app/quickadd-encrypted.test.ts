import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createGallery } from './quickadd'
import { encryptedSourceFromGalleryHash } from '../packages/core/encrypted-source'

const globals = globalThis as any

describe('encrypted quick-add', () => {
  afterEach(() => { mock.restore() })

  test('submits only a keyless manifest, stores the key, and navigates with its fragment', async () => {
    const source = 'https://mega.nz/folder/AbCdEf12#secret'
    let disposed = false
    const session = {
      provider: 'mega', sourceUrl: 'https://mega.nz/folder/AbCdEf12', title: 'Encrypted',
      images: [{ id: 'mega-node1' }],
      materialize: async () => { throw new Error('unused') },
      dispose: () => { disposed = true },
    }
    mock.module('./lib/encrypted-client', () => ({ openEncryptedSource: async () => session }))
    const values = new Map<string, string>()
    const persistent = new Map<string, string>()
    const navigated: string[] = []
    let body = ''
    const previous = { location: globals.location, sessionStorage: globals.sessionStorage, localStorage: globals.localStorage, document: globals.document, fetch: globals.fetch }
    globals.location = { href: 'https://manorama.xyz/quick', replace: (url: string) => { navigated.push(url) } }
    globals.sessionStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    globals.localStorage = {
      getItem: (key: string) => persistent.get(key) ?? null,
      setItem: (key: string, value: string) => { persistent.set(key, value) },
      removeItem: (key: string) => { persistent.delete(key) },
    }
    globals.document = { querySelector: () => null }
    globals.fetch = async (_input: unknown, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return new Response(JSON.stringify({ galleryUrl: '/test-owner/encrypted', gallery: { id: '0123456789abcdef', slug: 'encrypted' } }), { status: 409 })
    }
    try {
      await createGallery(source, { dataset: {} } as HTMLElement)
      const submitted = JSON.parse(body)
      expect(submitted.url).toBeUndefined()
      expect(submitted.manifest.sourceUrl).toBe('https://mega.nz/folder/AbCdEf12')
      expect(body).not.toContain('#secret')
      expect(disposed).toBe(true)
      expect(navigated).toHaveLength(1)
      expect(encryptedSourceFromGalleryHash(new URL(navigated[0]!, 'https://manorama.xyz').hash)).toBe(source)
      expect(values.get('manorama.gallery-key.v1.0123456789abcdef')).toBe(source)
      expect(persistent.size).toBe(0)
    } finally {
      Object.assign(globals, previous)
    }
  })

  test('a failing key store does not swallow a successful create', async () => {
    const source = 'https://mega.nz/folder/AbCdEf12#secret'
    const session = {
      provider: 'mega', sourceUrl: 'https://mega.nz/folder/AbCdEf12', title: 'Encrypted',
      images: [{ id: 'mega-node1' }],
      materialize: async () => { throw new Error('unused') },
      dispose: () => {},
    }
    mock.module('./lib/encrypted-client', () => ({ openEncryptedSource: async () => session }))
    const navigated: string[] = []
    const previous = { location: globals.location, sessionStorage: globals.sessionStorage, localStorage: globals.localStorage, document: globals.document, fetch: globals.fetch }
    globals.location = { href: 'https://manorama.xyz/quick', replace: (url: string) => { navigated.push(url) } }
    globals.sessionStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => {},
    }
    globals.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    globals.document = { querySelector: () => null }
    globals.fetch = async () => new Response(JSON.stringify({ galleryUrl: '/test-owner/encrypted', gallery: { id: '0123456789abcdef', slug: 'encrypted' } }), { status: 409 })
    try {
      await createGallery(source, { dataset: {} } as HTMLElement)
      expect(navigated).toHaveLength(1)
      expect(navigated[0]).toContain('#source=')
    } finally {
      Object.assign(globals, previous)
    }
  })
})
