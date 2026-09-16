import { describe, expect, test } from 'bun:test'
import { detectSource, scanSource, UNRECOGNIZED_LINK_MESSAGE } from './sources'

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
