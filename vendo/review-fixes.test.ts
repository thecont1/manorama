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

  test('renderer loads the Vendo client only after its mount root is emitted', () => {
    const renderer = readFileSync(`${repoRoot}/app/routes/_renderer.tsx`, 'utf8')
    expect(renderer.indexOf('<div id="vendo-root" />')).toBeGreaterThan(-1)
    expect(renderer.indexOf('<Script src="/app/vendo-client.tsx"')).toBeGreaterThan(
      renderer.indexOf('<div id="vendo-root" />'),
    )
  })
})
