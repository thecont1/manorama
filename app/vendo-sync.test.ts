import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const toolsPath = `${repoRoot}/.vendo/tools.json`

const runSync = () =>
  execFileSync('bunx', ['vendo', 'sync', '--strict', '--no-ai'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()

const readTools = () => readFileSync(toolsPath, 'utf8')

describe('deterministic Vendo sync', () => {
  test('strict sync is idempotent: a second run produces no diff', () => {
    const first = readTools()
    runSync()
    const second = readTools()
    expect(second).toBe(first)
  })

  test('generated tools.json is valid JSON with the thirteen expected tool names', () => {
    const tools = JSON.parse(readTools()) as { format: string; tools: { name: string; risk: string }[] }
    expect(tools.format).toBe('vendo/tools@3')
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'host_create_gallery', 'host_delete_gallery', 'host_get_drive_file', 'host_get_drive_thumbnail',
      'host_get_dropbox_file', 'host_get_dropbox_thumbnail', 'host_get_icloud_image', 'host_get_mega_file',
      'host_get_mega_preview',
      'host_list_galleries', 'host_refresh_gallery', 'host_scan_gallery_source', 'host_update_gallery',
    ])
  })

  test('risk corrections live in overrides.json, not hand edits to tools.json', () => {
    const overrides = JSON.parse(readFileSync(`${repoRoot}/.vendo/overrides.json`, 'utf8')) as {
      format: string
      tools: Record<string, { risk?: string }>
    }
    expect(overrides.format).toBe('vendo/overrides@3')
    // Every tool carries an explicit grade: sync infers delete as destructive
    // (asserted below from tools.json); the other ten are host-authored here.
    const expected: Record<string, string> = {
      host_create_gallery: 'write',
      host_get_drive_file: 'read',
      host_get_drive_thumbnail: 'read',
      host_get_dropbox_file: 'read',
      host_get_dropbox_thumbnail: 'read',
      host_get_icloud_image: 'read',
      host_get_mega_file: 'read',
      host_get_mega_preview: 'read',
      host_list_galleries: 'read',
      host_refresh_gallery: 'write',
      host_scan_gallery_source: 'read',
      host_update_gallery: 'write',
    }
    for (const [name, risk] of Object.entries(expected)) {
      expect(overrides.tools[name]?.risk).toBe(risk)
    }
    // Sync's own destructive inference for delete must agree.
    const tools = JSON.parse(readTools()) as { tools: { name: string; risk: string }[] }
    expect(tools.tools.find((tool) => tool.name === 'host_delete_gallery')?.risk).toBe('destructive')
  })

  // NOTE: This is the most environment-sensitive test in the suite. It runs
  // two real `bunx vendo sync` subprocesses (strict rejection, then a plain
  // restore) that reconcile against the live contract, so subprocess I/O is
  // the dominant cost. A *timeout* (the 20s budget exceeded) is environmental:
  // slower or loaded machines stall the synchronous execFileSync call, which
  // also prevents bun's own test-timeout from firing. An *assertion* failure
  // (strict sync not rejecting, or plain sync not restoring) is a regression.
  // See the per-check comments below for the diagnostic guidance.
  test('hand edits to tools.json fail strict sync instead of being silently kept', () => {
    const pristine = readTools()
    const tampered = JSON.parse(pristine) as { tools: { name: string }[] }
    tampered.tools[0].name = 'hand_edited_name'
    writeFileSync(toolsPath, JSON.stringify(tampered, null, 2) + '\n')
    try {
      // Strict sync must loudly reject a hand-edited machine layer, not accept it.
      // An assertion failure here (strictRejected !== true) is a regression, not env flakiness.
      let strictRejected = false
      try { runSync() } catch { strictRejected = true }
      expect(strictRejected).toBe(true)
      // A plain (non-strict) sync re-extracts from the contract and repairs it.
      // An assertion failure here (readTools() != pristine, or execFileSync throwing) is a regression.
      execFileSync('bunx', ['vendo', 'sync', '--no-ai'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(readTools()).toBe(pristine)
    } finally {
      writeFileSync(toolsPath, pristine)
    }
  // This is the slowest test in the suite and the most likely to time out.
  // The 20s budget is generous, but the synchronous execFileSync means a
  // hanging subprocess also blocks bun's own test-timeout from firing. On a
  // *timeout*, re-running this single test in isolation is diagnostic (confirm
  // it then passes) -- but never assume env flakiness when an assertion fails;
  // see the comments at the strict rejection and plain restore checks.
  }, 20_000)

  test('package.json exposes vendo:sync and vendo:check scripts', () => {
    const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf8')) as { scripts: Record<string, string> }
    // sync regenerates BOTH the machine layer and the bundled profile module.
    expect(pkg.scripts['vendo:sync']).toContain('vendo sync --no-ai')
    expect(pkg.scripts['vendo:sync']).toContain('gen-vendo-profile')
    expect(pkg.scripts['vendo:check']).toContain('strict')
    expect(pkg.scripts['vendo:check']).toContain('--exit-code')
    // Drift gate must cover the generated profile too.
    expect(pkg.scripts['vendo:check']).toContain('profile.generated.ts')
  })
})
