import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('bundled Vendo runtime profile', () => {
  test('exposes all eight Manorama tools', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    expect(vendoProfile.tools?.map((tool) => tool.name).sort()).toEqual([
      'host_create_gallery',
      'host_delete_gallery',
      'host_get_dropbox_file',
      'host_get_dropbox_thumbnail',
      'host_list_galleries',
      'host_refresh_gallery',
      'host_scan_dropbox_folder',
      'host_update_gallery',
    ])
  })

  test('carries a non-placeholder operator brief', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    expect(vendoProfile.brief).toBeDefined()
    expect(vendoProfile.brief!.length).toBeGreaterThan(500)
    expect(vendoProfile.brief!).not.toContain('Describe this product')
  })

  test('policy piece is the authoritative guard policy document', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    const policy = vendoProfile.policy
    expect(policy?.rules?.length).toBeGreaterThanOrEqual(6)
    const venueRules = policy!.rules!.filter((r) => 'venue' in r.match)
    const riskRules = policy!.rules!.filter((r) => 'risk' in r.match)
    expect(venueRules.length).toBeGreaterThanOrEqual(2)
    // Venue rules must precede risk rules: the guard's #policySays is
    // first-match-wins, so a leading read→run rule would let MCP reads run.
    const firstRisk = policy!.rules!.findIndex((r) => 'risk' in r.match)
    const lastVenue = policy!.rules!.map((r) => 'venue' in r.match).lastIndexOf(true)
    expect(lastVenue).toBeLessThan(firstRisk)
  })

  test('applies the overrides piece (risk grades) on top of the machine tools layer', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    const graded = vendoProfile.tools!.filter((tool) => tool.risk !== undefined)
    expect(graded.length).toBeGreaterThanOrEqual(1)
    const deleteTool = vendoProfile.tools!.find((tool) => tool.name.endsWith('delete_gallery'))
    expect(deleteTool?.risk).toBe('destructive')
  })

  test('theme piece parses with the Manorama color surface', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    expect(vendoProfile.theme?.colors?.accent).toBeDefined()
    expect(vendoProfile.theme?.typography?.fontFamily).toBeDefined()
  })

  test('a malformed profile file fails loudly at import time', async () => {
    const mod = await import('../vendo/profile')
    expect(typeof mod.assertProfileIntegrity).toBe('function')
    // A policy with no rules at all must throw, not fail soft.
    expect(() => mod.assertProfileIntegrity({ tools: [], policy: { rules: [] } })).toThrow()
    // A tools layer missing the host namespace must throw.
    expect(() => mod.assertProfileIntegrity({ tools: [], policy: undefined })).toThrow()
  })

  test('profile matches the on-disk .vendo files it replaces', async () => {
    const { vendoProfile } = await import('../vendo/profile')
    const onDisk = JSON.parse(readFileSync(`${repoRoot}/.vendo/tools.json`, 'utf8'))
    expect(vendoProfile.tools?.length).toBe(onDisk.tools.length)
    const onDiskPolicy = JSON.parse(readFileSync(`${repoRoot}/.vendo/policy.json`, 'utf8'))
    expect(vendoProfile.policy?.rules).toEqual(onDiskPolicy.rules)
    const brief = readFileSync(`${repoRoot}/.vendo/brief.md`, 'utf8')
    expect(vendoProfile.brief).toBe(brief)
  })
})