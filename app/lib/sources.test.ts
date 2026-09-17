import { describe, expect, test } from 'bun:test'
import { detectSource, embeddedSourceCandidate, scanSource, UNRECOGNIZED_LINK_MESSAGE } from './sources'

describe('detectSource', () => {
  test('recognizes Dropbox shared folder links', () => {
    expect(detectSource('https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=secret&dl=0')).toBe('dropbox')
    expect(detectSource('https://dropbox.com/sh/abc/def')).toBe('dropbox')
  })

  test('recognizes Google Drive folder links in their common spellings', () => {
    expect(detectSource('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp')).toBe('gdrive')
    expect(detectSource('https://drive.google.com/drive/u/2/folders/1AbCdEfGhIjKlMnOp?usp=sharing')).toBe('gdrive')
    expect(detectSource('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp')).toBe('gdrive')
  })

  test('recognizes iCloud shared album links in both spellings', () => {
    expect(detectSource('https://www.icloud.com/sharedalbum/#B0z5qAGN1JIFd3y')).toBe('icloud')
    expect(detectSource('https://share.icloud.com/photos/B0z5qAGN1JIFd3y')).toBe('icloud')
  })

  test('recognizes MEGA shared folder links in both spellings', () => {
    expect(detectSource('https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA')).toBe('mega')
    expect(detectSource('https://mega.co.nz/#F!AbCdEf12!a2V5LXNlY3JldA')).toBe('mega')
  })

  test('rejects everything else', () => {
    expect(detectSource('https://photos.google.com/share/abc')).toBeNull()
    expect(detectSource('https://onedrive.live.com/?id=abc')).toBeNull()
    expect(detectSource('https://icloud.com/photos')).toBeNull()
    expect(detectSource('https://www.icloud.com/iclouddrive/03c_T_Sxo0bE6AecC8_Ol21tw#Moral_Polis')).toBeNull()
    expect(detectSource('not a url')).toBeNull()
    expect(detectSource('ftp://dropbox.com/sh/x')).toBeNull()
    expect(detectSource('')).toBeNull()
  })
})

describe('scanSource', () => {
  test('rejects unrecognized links with the shared guidance', async () => {
    await expect(scanSource('https://example.com/photos', {})).rejects.toThrow(UNRECOGNIZED_LINK_MESSAGE)
  })

  test('rejects iCloud Drive links with the Shared Album guidance', async () => {
    await expect(scanSource('https://www.icloud.com/iclouddrive/03c_T_Sxo0bE6AecC8_Ol21tw#Moral_Polis', {}))
      .rejects.toThrow('iCloud Drive links cannot be read')
  })
})

describe('embeddedSourceCandidate', () => {
  test('recognizes a plain appended https URL', () => {
    const result = embeddedSourceCandidate('/https://www.dropbox.com/scl/fo/abc/xyz')
    expect(result).toEqual({ candidate: 'https://www.dropbox.com/scl/fo/abc/xyz', provider: 'dropbox' })
  })

  test('restores the scheme separator collapsed by path normalization', () => {
    // Browsers and proxies turn `https://x` into `https:/x` inside a path.
    expect(embeddedSourceCandidate('/https:/drive.google.com/drive/folders/1Ab')?.candidate)
      .toBe('https://drive.google.com/drive/folders/1Ab')
    expect(embeddedSourceCandidate('/https:///mega.nz/folder/AbCdEf12')?.provider).toBe('mega')
  })

  test('prepends https when the pasted link has no scheme', () => {
    const result = embeddedSourceCandidate('/dropbox.com/sh/abc/def')
    expect(result).toEqual({ candidate: 'https://dropbox.com/sh/abc/def', provider: 'dropbox' })
  })

  test('decodes a percent-encoded URL', () => {
    const result = embeddedSourceCandidate('/https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffo%2Fabc')
    expect(result?.candidate).toBe('https://www.dropbox.com/scl/fo/abc')
    expect(result?.provider).toBe('dropbox')
  })

  test('survives a malformed percent escape instead of throwing', () => {
    expect(() => embeddedSourceCandidate('/https://mega.nz/folder/100%')).not.toThrow()
    expect(embeddedSourceCandidate('/https://mega.nz/folder/100%')?.provider).toBe('mega')
  })

  test('recognizes every supported provider', () => {
    expect(embeddedSourceCandidate('/https://www.icloud.com/sharedalbum/')?.provider).toBe('icloud')
    expect(embeddedSourceCandidate('/https://share.icloud.com/photos/B0z5qAGN1JIFd3y')?.provider).toBe('icloud')
    expect(embeddedSourceCandidate('/https://mega.nz/folder/AbCdEf12')?.provider).toBe('mega')
    expect(embeddedSourceCandidate('/https://drive.google.com/drive/folders/1Ab')?.provider).toBe('gdrive')
  })

  test('recognizes an iCloud Drive link so the page can explain the difference', () => {
    expect(embeddedSourceCandidate('/https://www.icloud.com/iclouddrive/03c_T#Moral')?.provider).toBe('icloud')
  })

  test('never claims a gallery or owner slug', () => {
    // Slugs are [a-z0-9-] with no dot, so they can never look like a host.
    expect(embeddedSourceCandidate('/thecontrarian')).toBeNull()
    expect(embeddedSourceCandidate('/thecontrarian/kashmir')).toBeNull()
    expect(embeddedSourceCandidate('/auth/dropbox')).toBeNull()
    expect(embeddedSourceCandidate('/privacy')).toBeNull()
    expect(embeddedSourceCandidate('/api/galleries')).toBeNull()
  })

  test('rejects empty, slash-only, and non-provider input', () => {
    expect(embeddedSourceCandidate('')).toBeNull()
    expect(embeddedSourceCandidate('/')).toBeNull()
    expect(embeddedSourceCandidate('///')).toBeNull()
    expect(embeddedSourceCandidate('   ')).toBeNull()
    expect(embeddedSourceCandidate('/https://example.com/photos')).toBeNull()
    expect(embeddedSourceCandidate('/photos.google.com/share/abc')).toBeNull()
  })

  test('refuses to upgrade a non-http scheme', () => {
    expect(embeddedSourceCandidate('/ftp://dropbox.com/sh/x')).toBeNull()
    expect(embeddedSourceCandidate('/javascript:alert(1)')).toBeNull()
    expect(embeddedSourceCandidate('/data:text/html,hi')).toBeNull()
  })
})
