import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const brief = readFileSync(`${repoRoot}/.vendo/brief.md`, 'utf8')

describe('Vendo operator brief', () => {
  test('is non-placeholder and substantive', () => {
    expect(brief.length).toBeGreaterThan(800)
    expect(brief).not.toContain('Describe this product')
  })

  test('covers product, users, and jobs per the plan contract', () => {
    expect(brief).toContain('Manorama')
    expect(brief).toContain('Dropbox')
    for (const section of ['## Product', '## Users', '## Jobs to help with']) {
      expect(brief).toContain(section)
    }
  })

  test('prescribes the newSlug rename contract and slug identity', () => {
    expect(brief).toContain('newSlug')
    expect(brief).toContain('resource identity')
  })

  test('protects photography semantics and C2PA', () => {
    expect(brief).toContain('C2PA')
    expect(brief).toContain('Never invent')
  })

  test('stays out of policy and knowledge territory', () => {
    // Approval behavior belongs in .vendo/policy.json; docs belong in knowledge sources.
    expect(brief).not.toMatch(/approval|confirm before (delete|rename)/i)
  })
})
