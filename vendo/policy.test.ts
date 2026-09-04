import { describe, expect, test } from 'bun:test'
import { createGuard, createStore } from '@vendoai/vendo/server'
import type { RunContext, ToolDescriptor, ToolCall } from '@vendoai/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const policyFile = JSON.parse(readFileSync(`${repoRoot}/.vendo/policy.json`, 'utf8')) as {
  format: string
  rules?: { match: Record<string, string>; action: string }[]
  directions?: string[]
}

// The same inline policy the composition passes to guard() — rules and
// directions come verbatim from .vendo/policy.json, exactly as vendo/server.ts does.
const policy = createGuard({
  store: createStore(),
  policy: {
    rules: policyFile.rules as never,
    directions: policyFile.directions,
  },
})

const tools = JSON.parse(readFileSync(`${repoRoot}/.vendo/tools.json`, 'utf8')) as {
  tools: { name: string; risk: string; description: string; inputSchema: Record<string, unknown> }[]
}
const overrides = JSON.parse(readFileSync(`${repoRoot}/.vendo/overrides.json`, 'utf8')) as {
  tools: Record<string, { risk?: string }>
}
const effectiveRisk = (name: string) =>
  overrides.tools[name]?.risk ?? tools.tools.find((t) => t.name === name)?.risk

const descriptorFor = (name: string): ToolDescriptor => ({
  name,
  description: tools.tools.find((t) => t.name === name)!.description,
  inputSchema: tools.tools.find((t) => t.name === name)!.inputSchema,
  risk: effectiveRisk(name)!,
} as ToolDescriptor)

const callFor = (name: string): ToolCall => ({ id: `test-${name}`, tool: name, args: {} }) as ToolCall

const ctx = (venue: RunContext['venue']): RunContext => ({
  venue,
  presence: 'present',
  principal: { kind: 'user', subject: 'owner-1' },
}) as RunContext

const check = async (tool: string, venue: RunContext['venue'] = 'chat') => {
  const decision = await policy.check(callFor(tool), descriptorFor(tool), ctx(venue))
  return decision.action
}

describe('Vendo guard policy decisions (chat venue)', () => {
  test('reads run automatically for authenticated users', async () => {
    for (const tool of ['host_list_galleries', 'host_scan_dropbox_folder', 'host_get_dropbox_thumbnail', 'host_get_dropbox_file']) {
      expect(await check(tool)).toBe('run')
    }
  })

  test('metadata writes ask', async () => {
    expect(await check('host_update_gallery')).toBe('ask')
  })

  test('create and refresh ask', async () => {
    expect(await check('host_create_gallery')).toBe('ask')
    expect(await check('host_refresh_gallery')).toBe('ask')
  })

  test('delete always asks and stays destructive', async () => {
    expect(await check('host_delete_gallery')).toBe('ask')
  })

  test('ungraded tools never run silently', async () => {
    const ungraded = tools.tools.filter((t) => effectiveRisk(t.name) === 'ungraded')
    for (const tool of ungraded) {
      expect(await check(tool.name)).not.toBe('run')
    }
  })
})

describe('Vendo guard policy decisions (stricter venues)', () => {
  test('MCP venue asks even for reads', async () => {
    expect(await check('host_list_galleries', 'mcp')).not.toBe('run')
  })

  test('automation venue asks for writes', async () => {
    expect(await check('host_update_gallery', 'automation')).toBe('ask')
  })
})
