import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Vendo review fixes', () => {
  test('environment template names the model key consumed by the Vendo handlers', () => {
    const template = readFileSync(`${repoRoot}/.env.example`, 'utf8')
    expect(template).toContain('# VENDO_API_KEY=')
    expect(template).not.toContain('# ANTHROPIC_API_KEY=')
  })

  test('the authenticated admin page loads the Vendo client only after its mount root', () => {
    const ownerPage = readFileSync(`${repoRoot}/app/routes/[owner].tsx`, 'utf8')
    expect(ownerPage.indexOf('<div id="vendo-root" />')).toBeGreaterThan(-1)
    expect(ownerPage.indexOf('<Script src="/app/vendo-client.tsx"')).toBeGreaterThan(
      ownerPage.indexOf('<div id="vendo-root" />'),
    )
  })

  test('public pages no longer mount the Vendo surface globally', () => {
    const renderer = readFileSync(`${repoRoot}/app/routes/_renderer.tsx`, 'utf8')
    expect(renderer).not.toContain('vendo-root')
    expect(renderer).not.toContain('vendo-client')
  })

  test('the client mounts a detectable, typed Vendo surface', () => {
    const client = readFileSync(`${repoRoot}/app/vendo-client.tsx`, 'utf8')
    expect(client).toContain('<VendoProvider')
    expect(client).toContain('<VendoOverlay')
    expect(client).not.toContain('as any')
    expect(client).not.toContain('React.createElement')
  })
})
