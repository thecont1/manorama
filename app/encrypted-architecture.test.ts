import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = (path: string) => readFileSync(`${root}/${path}`, 'utf8')

describe('encrypted-source architecture guards', () => {
  test('shared contracts stay platform-free', () => {
    const core = source('packages/core/encrypted-source.ts')
    for (const forbidden of ['window.', 'document.', 'localStorage', 'sessionStorage', 'expo-', '@capacitor', 'node:']) {
      expect(core).not.toContain(forbidden)
    }
  })

  test('the server dispatcher and API do not import client decryptors', () => {
    const dispatcher = source('app/lib/sources.ts')
    const api = source('app/api.ts')
    expect(dispatcher).not.toContain("from './mega-public'")
    expect(dispatcher).toContain('MEGA sources are scanned on your device')
    expect(api).not.toContain("from './lib/mega-client'")
    expect(api).not.toContain('mega-crypto.worker')
    expect(api).toContain('SERVER_DECRYPT_RETIRED')
  })

  test('web key custody is session-only and keyed by immutable gallery id', () => {
    const store = source('app/lib/key-store.ts')
    expect(store).toContain('new WebGalleryKeyStore(sessionStorage)')
    expect(store).not.toContain('new WebGalleryKeyStore(localStorage)')
    expect(store).toContain('manorama.gallery-key.v1.')
  })
})
