import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { encryptedProviderForUrl } from '../../packages/core/encrypted-source'

// openEncryptedSource itself cannot be imported here: other specs mock.module
// this specifier, and module mocks persist for the whole test process. The
// refusal is pinned structurally instead — the guard source precedes the only
// import that could open a network path.
const source = readFileSync(new URL('./encrypted-client.ts', import.meta.url).pathname, 'utf8')

describe('openEncryptedSource provider gate', () => {
  test('an Ente album URL is detected as ente', () => {
    expect(encryptedProviderForUrl('https://albums.ente.io/?t=AbCdEfGh')).toBe('ente')
  })

  test('ente is refused at the provider gate — no network path opens for it', () => {
    const dispatch = source.indexOf('encryptedProviderForUrl(sourceUrl)')
    const megaBranch = source.indexOf("provider === 'mega'")
    const megaImport = source.indexOf("import('./mega-client')")
    const enteRefusal = source.indexOf("provider === 'ente'")
    expect(dispatch).toBeGreaterThan(-1)
    // Provider detection runs before any provider branch, the only dynamic
    // import is the mega client inside the mega branch, and the file holds no
    // fetch — so an ente URL exits via the refusal without touching a network.
    expect(dispatch).toBeLessThan(megaBranch)
    expect(megaBranch).toBeLessThan(megaImport)
    expect(enteRefusal).toBeGreaterThan(-1)
    expect(source).toContain('Ente public albums are not supported yet')
    expect(source.match(/import\(/g)).toHaveLength(1)
    expect(source).not.toContain('fetch(')
  })

  test('unrecognized links fall through to MEGA-only guidance', () => {
    expect(source).toContain('Use a complete MEGA public album link')
  })
})
