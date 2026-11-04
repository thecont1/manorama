import { afterEach, describe, expect, mock, test } from 'bun:test'
import { NativeGalleryKeyStore } from './gallery-key-store'

const keyed = 'https://mega.nz/folder/AbCdEf12#secret'
const galleryId = '0123456789abcdef'
const image = { id: 'mega-node1', ref: 'node1', filename: 'one.jpg', src: '', media: { kind: 'encrypted' as const, provider: 'mega' as const, sourceKind: 'folder' as const, sourceId: 'AbCdEf12', nodeId: 'node1' }, contentVersion: 'a'.repeat(64), width: 4000, height: 3000, alt: '', c2pa: true, placeholder: 'data:image/svg+xml,x' }
const memoryStore = () => {
  const values = new Map<string, string>()
  return new NativeGalleryKeyStore({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value) },
    removeItem: async (key) => { values.delete(key) },
  })
}

describe('native encrypted gallery orchestration', () => {
  afterEach(() => { mock.restore() })

  test('create persists the key by immutable id and refresh reuses it without exposing it', async () => {
    const store = memoryStore()
    const disposed = { count: 0 }
    const session = {
      provider: 'mega' as const, sourceUrl: 'https://mega.nz/folder/AbCdEf12', title: 'Encrypted', images: [image],
      materialize: async () => { throw new Error('unused') }, dispose: () => { disposed.count += 1 },
    }
    mock.module('./gallery-key-store', () => ({ nativeGalleryKeyStore: () => store }))
    mock.module('../../app/lib/encrypted-client', () => ({ openEncryptedSource: async (source: string) => {
      expect(source).toBe(keyed)
      return session
    } }))
    const bodies: string[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return Response.json({ galleryUrl: '/owner/encrypted', gallery: { id: galleryId, slug: 'encrypted' } }, { status: 201 })
    }) as typeof fetch
    try {
      const { createEncryptedGallery, refreshEncryptedGallery } = await import('./encrypted-gallery')
      expect(await createEncryptedGallery('https://manorama.xyz', keyed)).toEqual({ owner: 'owner', slug: 'encrypted', galleryId })
      expect(await store.get(galleryId)).toBe(keyed)
      await refreshEncryptedGallery('https://manorama.xyz', 'encrypted', galleryId)
      expect(disposed.count).toBe(2)
      expect(bodies).toHaveLength(2)
      for (const body of bodies) {
        expect(body).not.toContain('#secret')
        expect(JSON.parse(body).url).toBeUndefined()
        expect(JSON.parse(body).manifest.sourceUrl).toBe(session.sourceUrl)
      }
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('refresh without a key fails locked without opening a provider session', async () => {
    const store = memoryStore()
    let opened = false
    mock.module('./gallery-key-store', () => ({ nativeGalleryKeyStore: () => store }))
    mock.module('../../app/lib/encrypted-client', () => ({ openEncryptedSource: async () => { opened = true; throw new Error('must not open') } }))
    const { refreshEncryptedGallery, EncryptedSourceLockedError } = await import('./encrypted-gallery')
    await expect(refreshEncryptedGallery('https://manorama.xyz', 'encrypted', galleryId)).rejects.toBeInstanceOf(EncryptedSourceLockedError)
    expect(opened).toBe(false)
  })
})
