import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = (path: string) => readFileSync(`${root}/${path}`, 'utf8')

const listSources = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listSources(`${dir}/${entry.name}`))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.test.tsx')) out.push(`${dir}/${entry.name}`)
  }
  return out
}

// The modules that implement client-side decryption. They may import each
// other and be imported by islands and native; nothing else on the Worker
// surface may reference them, except the flagged switch in api.ts.
const DECRYPTOR_MODULES = [
  'mega-client', 'mega-crypto', 'mega-decrypt', 'mega-crypto.worker',
  'encrypted-client', 'encrypted-resolver', 'encrypted-display',
]
const isDecryptorSpecifier = (spec: string) =>
  DECRYPTOR_MODULES.some((name) => spec === name || spec.endsWith(`/${name}`))
const importSpecifiers = (code: string) =>
  [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1])

describe('encrypted-source architecture guards', () => {
  test('shared contracts stay platform-free', () => {
    const core = source('packages/core/encrypted-source.ts')
    for (const forbidden of ['window.', 'document.', 'localStorage', 'sessionStorage', 'expo-', '@capacitor', 'node:']) {
      expect(core).not.toContain(forbidden)
    }
  })

  test('no Worker file outside the decryptor family imports a client decryptor', () => {
    const workerSurface = [
      'app/api.ts', 'app/server.ts',
      ...listSources('app/routes'),
      ...listSources('app/lib').filter((file) =>
        !DECRYPTOR_MODULES.some((name) => file === `app/lib/${name}.ts`)),
    ]
    const offenders = workerSurface
      .filter((file) => file !== 'app/api.ts')
      .filter((file) => importSpecifiers(source(file)).some(isDecryptorSpecifier))
    expect(offenders).toEqual([])
  })

  test('the flagged switch is the only decryptor consumer and it stays enumerated', () => {
    const decryptors = importSpecifiers(source('app/api.ts')).filter(isDecryptorSpecifier)
    // The switch needs exactly these: the gated fetch/decrypt path and the
    // MEGA base64url primitive used to validate k= params. Anything else is a
    // new decryptor copy and must not reappear unnoticed.
    expect(decryptors).toEqual(['./lib/mega-client', './lib/mega-crypto'])
    expect(source('app/api.ts')).toContain('SERVER_DECRYPT_RETIRED')
  })

  test('the server dispatcher routes MEGA to the client', () => {
    const dispatcher = source('app/lib/sources.ts')
    expect(dispatcher).toContain('MEGA sources are scanned on your device')
  })

  test('web key custody is session-only and keyed by immutable gallery id', () => {
    const store = source('app/lib/key-store.ts')
    expect(store).toContain('new WebGalleryKeyStore(sessionStorage)')
    expect(store).not.toContain('new WebGalleryKeyStore(localStorage)')
    expect(store).toContain('manorama.gallery-key.v1.')
  })
})
