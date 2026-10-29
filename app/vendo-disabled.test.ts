import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('vendo is not a development gate', () => {
  test('package scripts do not run vendo', () => {
    const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf8')) as { scripts: Record<string, string> }
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(name.startsWith('vendo')).toBe(false)
      expect(command).not.toContain('vendo sync')
      expect(command).not.toContain('vendo:check')
    }
  })

  test('verify workflow does not invoke vendo', () => {
    const workflow = readFileSync(`${repoRoot}/.github/workflows/verify.yml`, 'utf8')
    expect(workflow).not.toContain('vendo')
  })
})
