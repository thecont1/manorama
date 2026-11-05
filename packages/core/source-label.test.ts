import { describe, expect, test } from 'bun:test'
import { sourceLabelFor } from './source-label'

describe('sourceLabelFor', () => {
  test('names each provider host, proton included', () => {
    expect(sourceLabelFor('https://dropbox.com/scl/fo/a/b')).toBe('Dropbox')
    expect(sourceLabelFor('https://drive.google.com/drive/folders/x')).toBe('Google Drive')
    expect(sourceLabelFor('https://www.icloud.com/sharedalbum/#tok')).toBe('iCloud')
    expect(sourceLabelFor('https://mega.nz/folder/AbCdEf12')).toBe('MEGA')
    expect(sourceLabelFor('https://albums.ente.io/AbCdEf12')).toBe('Ente')
    expect(sourceLabelFor('https://drive.proton.me/urls/AbCdEf12_Gh')).toBe('Proton Drive')
  })

  test('falls back to the generic label for anything else', () => {
    expect(sourceLabelFor(undefined)).toBe('gallery')
    expect(sourceLabelFor('https://example.com/photos')).toBe('gallery')
    expect(sourceLabelFor('not a url')).toBe('local folder')
  })
})
