import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { extractProtonLink } from './proton-client'

describe('extractProtonLink', () => {
  test('splits a public link into path token and fragment password', () => {
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh#secretpassword'))
      .toEqual({ token: 'AbCdEf12_Gh', password: 'secretpassword' })
  })

  test('accepts a trailing slash and a query; the fragment stays the secret', () => {
    const link = extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh/?x=1#pw')
    expect(link).toEqual({ token: 'AbCdEf12_Gh', password: 'pw' })
  })

  test('refuses keyless, non-share, wrong-host, and non-https input', () => {
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh')).toBeNull()
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh#')).toBeNull()
    expect(extractProtonLink('https://drive.proton.me/u/0/folders/xyz#pw')).toBeNull()
    expect(extractProtonLink('https://example.com/urls/AbCdEf12_Gh#pw')).toBeNull()
    expect(extractProtonLink('http://drive.proton.me/urls/AbCdEf12_Gh#pw')).toBeNull()
    expect(extractProtonLink('not a link')).toBeNull()
  })
})

// The SDK and crypto stack must stay behind dynamic imports so they never
// enter the Worker graph (the architecture test scans this, but the pinned
// surface lives here too: a static SDK import would pull megabytes of crypto
// into every test process that touches this module).
describe('proton-client module surface', () => {
  const source = readFileSync(new URL('./proton-client.ts', import.meta.url).pathname, 'utf8')

  test('the drive-sdk is only ever a dynamic import or a type import', () => {
    // A static runtime import (`import { x } from '@protontech/…'`) would
    // bind the crypto graph at module load; `import type` is erased.
    const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)[^;\n]*['"]@protontech/gm)]
    expect(runtimeImports).toEqual([])
    expect(source).toContain("import('@protontech/drive-sdk')")
    expect(source).toContain("import('@protontech/crypto/srp')")
    expect(source).toContain("from '@protontech/drive-sdk'")
  })

  test('stamps the honest third-party appversion identity', () => {
    expect(source).toContain('x-pm-appversion')
    expect(source).toMatch(/external-drive-manorama@/)
  })
})
