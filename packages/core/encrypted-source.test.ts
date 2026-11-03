import { describe, expect, test } from 'bun:test'
import {
  contentVersionIsValid,
  encryptedGalleryGate,
  encryptedSourceFromGalleryHash,
  galleryHashForSource,
  galleryUrlWithPreservedHash,
  isEncryptedSourceUrl,
  keylessSourceUrl,
  manifestIsEncryptedSource,
  mediaReferenceIsValid,
  validatePublishedDimensions,
} from './encrypted-source'

const keyed = 'https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA'

describe('encrypted source URL fragment channel', () => {
  test('round-trips provider, handle, and secret through a gallery fragment', () => {
    const hash = galleryHashForSource(keyed)
    expect(hash.startsWith('#source=')).toBe(true)
    expect(hash).not.toContain('#a2V5')
    expect(encryptedSourceFromGalleryHash(hash)).toBe(keyed)
  })

  test('rejects missing, malformed, and unencrypted fragments', () => {
    expect(encryptedSourceFromGalleryHash('')).toBeNull()
    expect(encryptedSourceFromGalleryHash('#photo=3')).toBeNull()
    expect(encryptedSourceFromGalleryHash(galleryHashForSource('https://dropbox.com/sh/a/b'))).toBeNull()
    expect(encryptedSourceFromGalleryHash('#source=%23bad')).toBeNull()
  })

  test('keyless identity retains only provider and handle', () => {
    expect(keylessSourceUrl(keyed)).toBe('https://mega.nz/folder/AbCdEf12')
    expect(isEncryptedSourceUrl(keylessSourceUrl(keyed))).toBe(true)
    expect(isEncryptedSourceUrl('https://dropbox.com/sh/a/b')).toBe(false)
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
})

describe('transitional encrypted gallery gate', () => {
  const legacy = { sourceUrl: keyed, manifestVersion: 1, legacyServerDecrypt: true }
  test('only an owner receives the stored legacy capability', () => {
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: true })).toEqual({ client: true, legacySourceUrl: keyed })
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false })).toEqual({ client: false })
  })
  test('retirement or a disabled server path requires the client gate', () => {
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false, keyRetiredAt: '2026-01-01' }).client).toBe(true)
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false, legacyServerDecrypt: false }).client).toBe(true)
    expect(encryptedGalleryGate({ ...legacy, viewerOwner: false, keyRetiredAt: '2026-01-01' }).legacySourceUrl).toBeUndefined()
  })
  test('a version-2 manifest always takes the client gate, even mid-migration', () => {
    // Converted on one device: keyless media refs with the source key still
    // stored. The server could not render those refs even for a visitor.
    expect(encryptedGalleryGate({ sourceUrl: keyed, manifestVersion: 2, viewerOwner: false, legacyServerDecrypt: true }).client).toBe(true)
    expect(encryptedGalleryGate({ sourceUrl: keyed, manifestVersion: 2, viewerOwner: true, legacyServerDecrypt: true }).legacySourceUrl).toBe(keyed)
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
