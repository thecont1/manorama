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

  test('a Proton Drive share URL is detected as proton', () => {
    expect(encryptedProviderForUrl('https://drive.proton.me/urls/AbCdEfGh#secretpassword')).toBe('proton')
  })

  test('provider branches stay dynamically imported — the dispatch file holds no network code', () => {
    const dispatch = source.indexOf('encryptedProviderForUrl(sourceUrl)')
    const megaBranch = source.indexOf("provider === 'mega'")
    const megaImport = source.indexOf("import('./mega-client')")
    const enteBranch = source.indexOf("provider === 'ente'")
    const enteImport = source.indexOf("import('./ente-client')")
    const protonBranch = source.indexOf("provider === 'proton'")
    const protonImport = source.indexOf("import('./proton-client')")
    expect(dispatch).toBeGreaterThan(-1)
    // Provider detection runs before any branch, each branch lazily imports
    // its own client module, and the dispatch file itself holds no fetch —
    // provider crypto stays out of the Worker graph.
    expect(dispatch).toBeLessThan(megaBranch)
    expect(megaBranch).toBeLessThan(megaImport)
    expect(enteBranch).toBeGreaterThan(-1)
    expect(enteBranch).toBeLessThan(enteImport)
    expect(protonBranch).toBeGreaterThan(-1)
    expect(protonBranch).toBeLessThan(protonImport)
    expect(source.match(/import\(/g)).toHaveLength(3)
    expect(source).not.toContain('fetch(')
  })

  test('unrecognized links fall through to provider guidance', () => {
    expect(source).toContain('Use a complete MEGA, Ente or Proton Drive public link')
  })
})
