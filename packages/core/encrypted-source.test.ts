import { describe, expect, test } from 'bun:test'
import {
  contentVersionIsValid,
  encryptedSourceFromGalleryHash,
  galleryHashForSource,
  galleryIdFromGalleryHash,
  galleryUrlWithPreservedHash,
  isEncryptedSourceUrl,
  keylessSourceUrl,
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
