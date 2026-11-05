import { describe, expect, test } from 'bun:test'
import {
  contentVersionIsValid,
  encryptedGalleryGate,
  encryptedProviderForUrl,
  encryptedSourceFromGalleryHash,
  galleryHashForSource,
  galleryIdFromGalleryHash,
  galleryUrlWithPreservedHash,
  isEncryptedSourceUrl,
  keylessSourceUrl,
  manifestIsEncryptedSource,
  mediaReferenceIsValid,
  protonIdentityFromUrl,
  validatePublishedDimensions,
} from './encrypted-source'

const keyed = 'https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA'
const protonKeyed = 'https://drive.proton.me/urls/AbCdEf12_Gh#secretpassword'

describe('encrypted source URL fragment channel', () => {
  test('round-trips provider, handle, and secret through a gallery fragment', () => {
    const hash = galleryHashForSource(keyed)
    expect(hash.startsWith('#source=')).toBe(true)
    expect(hash).not.toContain('#a2V5')
    expect(encryptedSourceFromGalleryHash(hash)).toBe(keyed)
  })

  test('carries an optional immutable gallery id for native key custody', () => {
    const hash = galleryHashForSource(keyed, '0123456789abcdef')
    expect(encryptedSourceFromGalleryHash(hash)).toBe(keyed)
    expect(galleryIdFromGalleryHash(hash)).toBe('0123456789abcdef')
    expect(galleryIdFromGalleryHash(galleryHashForSource(keyed))).toBeNull()
    expect(galleryIdFromGalleryHash('#gallery=slug')).toBeNull()
  })

  test('rejects missing, malformed, and unencrypted fragments', () => {
    expect(encryptedSourceFromGalleryHash('')).toBeNull()
    expect(encryptedSourceFromGalleryHash('#photo=3')).toBeNull()
    expect(encryptedSourceFromGalleryHash(galleryHashForSource('https://dropbox.com/sh/a/b'))).toBeNull()
    expect(encryptedSourceFromGalleryHash('#source=%23bad')).toBeNull()
  })

  test('keyless identity retains only provider and handle', () => {
    expect(keylessSourceUrl(keyed)).toBe('https://mega.nz/folder/AbCdEf12')
    // Legacy spellings carry the handle inside the fragment — keyless must
    // still resolve to the canonical provider URL, not a bare host.
    expect(keylessSourceUrl('https://mega.nz/#F!AbCdEf12!secret')).toBe('https://mega.nz/folder/AbCdEf12')
    expect(keylessSourceUrl('https://mega.co.nz/#C!AbCdEf12!secret')).toBe('https://mega.nz/collection/AbCdEf12')
    expect(isEncryptedSourceUrl(keylessSourceUrl(keyed))).toBe(true)
    expect(isEncryptedSourceUrl('https://dropbox.com/sh/a/b')).toBe(false)
  })

  test('proton identity is the /urls/ path token; the fragment is secret-only', () => {
    expect(protonIdentityFromUrl(protonKeyed)).toEqual({ kind: 'urls', id: 'AbCdEf12_Gh' })
    expect(protonIdentityFromUrl('https://drive.proton.me/urls/AbCdEf12_Gh/')).toEqual({ kind: 'urls', id: 'AbCdEf12_Gh' })
    expect(protonIdentityFromUrl('https://www.drive.proton.me/urls/AbCdEf12_Gh#pw')).toEqual({ kind: 'urls', id: 'AbCdEf12_Gh' })
    expect(encryptedProviderForUrl(protonKeyed)).toBe('proton')
    expect(isEncryptedSourceUrl(protonKeyed)).toBe(true)
    // A keyed proton link still round-trips through the gallery fragment.
    expect(encryptedSourceFromGalleryHash(galleryHashForSource(protonKeyed))).toBe(protonKeyed)
    // Not a share: wrong host, wrong path, http.
    expect(protonIdentityFromUrl('https://drive.proton.me/u/0/folders/x')).toBeNull()
    expect(protonIdentityFromUrl('https://proton.me/drive/urls/AbCdEf12_Gh')).toBeNull()
    expect(protonIdentityFromUrl('http://drive.proton.me/urls/AbCdEf12_Gh#pw')).toBeNull()
    expect(protonIdentityFromUrl('https://drive.proton.me/urls/')).toBeNull()
  })

  test('keyless proton identity drops the fragment password and any query', () => {
    expect(keylessSourceUrl(protonKeyed)).toBe('https://drive.proton.me/urls/AbCdEf12_Gh')
    expect(keylessSourceUrl('https://drive.proton.me/urls/AbCdEf12_Gh/?ignored=1#pw')).toBe('https://drive.proton.me/urls/AbCdEf12_Gh')
    expect(keylessSourceUrl('https://drive.proton.me/urls/AbCdEf12_Gh')).toBe('https://drive.proton.me/urls/AbCdEf12_Gh')
    expect(isEncryptedSourceUrl(keylessSourceUrl(protonKeyed))).toBe(true)
  })

  test('history rewrites preserve a source fragment unless one is explicitly supplied', () => {
    expect(galleryUrlWithPreservedHash('/owner/gallery?photo=2', '#source=secret', '/owner/gallery')).toBe('/owner/gallery#source=secret')
    expect(galleryUrlWithPreservedHash('/owner/gallery?photo=2', '#source=secret')).toBe('/owner/gallery?photo=2#source=secret')
    expect(galleryUrlWithPreservedHash('/owner/gallery?photo=2', '#source=secret', '/owner/gallery#position=2')).toBe('/owner/gallery#position=2')
  })
})

describe('published encrypted manifest rules', () => {
  test('accepts normal and panorama dimensions within the layout clamp', () => {
    expect(validatePublishedDimensions(4000, 3000)).toBe(true)
    expect(validatePublishedDimensions(5400, 540)).toBe(true)
  })

  test('rejects zero, negative, fractional, oversized, and extreme-aspect dimensions', () => {
    for (const [width, height] of [[0, 10], [-1, 10], [1.5, 10], [100001, 10], [1, 10000], [10000, 1]] as const) {
      expect(validatePublishedDimensions(width, height)).toBe(false)
    }
  })

  test('content versions are fixed-length opaque digests', () => {
    expect(contentVersionIsValid('a'.repeat(64))).toBe(true)
    expect(contentVersionIsValid('A'.repeat(64))).toBe(false)
    expect(contentVersionIsValid('raw-size-123')).toBe(false)
  })

  test('encrypted references are keyless and provider-scoped', () => {
    expect(mediaReferenceIsValid({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'Node_123', previewId: 'Preview_123' })).toBe(true)
    expect(mediaReferenceIsValid({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'abc#secret', nodeId: 'node' })).toBe(false)
    expect(mediaReferenceIsValid({ kind: 'http', url: 'javascript:alert(1)' })).toBe(false)
    expect(mediaReferenceIsValid({ kind: 'http', url: '/api/drive/file?id=abc' })).toBe(true)
  })

  test('proton references pin sourceKind urls and the nodeUid alphabet', () => {
    const ref = { kind: 'encrypted', provider: 'proton', sourceKind: 'urls', sourceId: 'AbCdEf12_Gh', nodeId: 'vol-ume_01~NodeId=-XY' }
    expect(mediaReferenceIsValid(ref)).toBe(true)
    expect(mediaReferenceIsValid({ ...ref, previewId: 'vol-ume_01~NodeId=-XY' })).toBe(true)
    // A fragment or path separator must never ride inside a published ref.
    expect(mediaReferenceIsValid({ ...ref, nodeId: 'vol~node#secret' })).toBe(false)
    expect(mediaReferenceIsValid({ ...ref, nodeId: 'vol~node/secret' })).toBe(false)
    expect(mediaReferenceIsValid({ ...ref, sourceKind: 'album' })).toBe(false)
    expect(mediaReferenceIsValid({ ...ref, previewId: 'other~uid' })).toBe(false)
    expect(mediaReferenceIsValid({ kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbCdEf12', nodeId: 'vol~tilde' })).toBe(false)
  })
})

describe('encrypted gallery gate', () => {
  const legacy = { sourceUrl: keyed, manifestVersion: 1 }
  test('only an owner receives the stored legacy capability', () => {
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: true })).toEqual({ client: true, legacySourceUrl: keyed })
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false })).toEqual({ client: false })
  })
  test('retirement requires the client gate', () => {
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false, keyRetiredAt: '2026-01-01' }).client).toBe(true)
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false, keyRetiredAt: '2026-01-01' }).legacySourceUrl).toBeUndefined()
  })
  test('a version-2 manifest always takes the client gate, even mid-migration', () => {
    // Converted on one device: keyless media refs with the source key still
    // stored. The server could not render those refs even for a visitor.
    expect(encryptedGalleryGate({ sourceUrl: keyed, manifestVersion: 2, viewerOwner: false }).client).toBe(true)
    expect(encryptedGalleryGate({ sourceUrl: keyed, manifestVersion: 2, viewerOwner: true }).legacySourceUrl).toBe(keyed)
  })
  test('a manifest reports encrypted through its source or any media reference', () => {
    expect(manifestIsEncryptedSource({ sourceUrl: keyed })).toBe(true)
    expect(manifestIsEncryptedSource({ sourceUrl: keylessSourceUrl(keyed) })).toBe(true)
    expect(manifestIsEncryptedSource({ sourceUrl: 'https://dropbox.com/sh/a/b' })).toBe(false)
    expect(manifestIsEncryptedSource({ images: [{ media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'Ab', nodeId: 'n' } }] })).toBe(true)
    expect(manifestIsEncryptedSource({ images: [{ media: { kind: 'http', url: '/api/drive/file?id=x' } }] })).toBe(false)
    expect(manifestIsEncryptedSource({})).toBe(false)
  })
})
