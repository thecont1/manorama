import { afterEach, describe, expect, mock, test } from 'bun:test'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import type { GalleryManifest } from '../../app/lib/imagesource'
import { EncryptedSourceLockedError } from './encrypted-gallery'
import { openGalleryNetworkFirst, type OfflineGalleryStore } from './offline-gallery'

const manifest: GalleryManifest = {
  slug: 'encrypted', title: 'Encrypted', caption: '', date: '',
  images: [{ id: 'mega-node1', ref: 'node1', filename: 'one.jpg', src: '', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'node1' }, contentVersion: 'a'.repeat(64), width: 4000, height: 3000, alt: '', c2pa: true, placeholder: '' }],
}

describe('network-first encrypted galleries', () => {
  afterEach(() => { mock.restore() })
  test('shares one session with the vault fill and disposes it with the lease', async () => {
    let disposed = false
    const session = { provider: 'mega' as const, sourceUrl: 'https://mega.nz/folder/AbCdEf12', title: 'Encrypted', images: manifest.images, materialize: async () => { throw new Error('unused') }, dispose: () => { disposed = true } }
    mock.module('../../app/lib/encrypted-client', () => ({ openEncryptedSource: async () => session }))
    let shared: unknown
    const store: OfflineGalleryStore = {
      cache: async (_selection, _gallery, _signal, _progress, _ready, encryptedSession) => { shared = encryptedSession; return { status: 'complete', images: 1 } },
      inspect: async () => ({ status: 'missing', images: 0 }), open: async () => undefined, invalidate: async () => {},
      listGalleries: async () => [], readThumbnail: async () => undefined, gridGallery: async () => undefined, listGridGalleries: async () => [], purgeGallery: async () => {}, purgeAll: async () => {},
    }
    const result = await openGalleryNetworkFirst({
      selection: { owner: 'owner', slug: 'encrypted', galleryId: '0123456789abcdef', sourceUrl: 'https://mega.nz/folder/AbCdEf12#secret' },
      fetchOnline: async () => ({ manifest, settings: defaultGallerySettings(manifest) }), store,
    })
    expect(result.encryptedResolver).toBeDefined()
    expect(shared).toBe(session)
    expect(await result.cacheFill).toEqual({ status: 'complete', images: 1 })
    result.dispose?.()
    expect(disposed).toBe(true)
  })

  test('a locked gallery keeps its typed error so the caller can delegate to the web', async () => {
    mock.module('./gallery-key-store', () => ({ nativeGalleryKeyStore: () => ({ get: async () => null }) }))
    const store: OfflineGalleryStore = {
      cache: async () => ({ status: 'complete', images: 1 }),
      inspect: async () => ({ status: 'missing', images: 0 }), open: async () => undefined, invalidate: async () => {},
      listGalleries: async () => [], readThumbnail: async () => undefined, gridGallery: async () => undefined, listGridGalleries: async () => [], purgeGallery: async () => {}, purgeAll: async () => {},
    }
    await expect(openGalleryNetworkFirst({
      selection: { owner: 'owner', slug: 'encrypted', galleryId: '0123456789abcdef' },
      fetchOnline: async () => ({ manifest, settings: defaultGallerySettings(manifest) }), store,
    })).rejects.toBeInstanceOf(EncryptedSourceLockedError)
  })

  test('a locked gallery still opens its vaulted copy', async () => {
    mock.module('./gallery-key-store', () => ({ nativeGalleryKeyStore: () => ({ get: async () => null }) }))
    const lease = { manifest, settings: defaultGallerySettings(manifest), source: 'offline' as const, dispose: () => {} }
    const store: OfflineGalleryStore = {
      cache: async () => ({ status: 'complete', images: 1 }),
      inspect: async () => ({ status: 'missing', images: 0 }), open: async () => lease, invalidate: async () => {},
      listGalleries: async () => [], readThumbnail: async () => undefined, gridGallery: async () => undefined, listGridGalleries: async () => [], purgeGallery: async () => {}, purgeAll: async () => {},
    }
    const result = await openGalleryNetworkFirst({
      selection: { owner: 'owner', slug: 'encrypted', galleryId: '0123456789abcdef' },
      fetchOnline: async () => ({ manifest, settings: defaultGallerySettings(manifest) }), store,
    })
    expect(result.source).toBe('offline')
  })
})
