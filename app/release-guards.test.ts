import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const requireEnv = join(repoRoot, 'scripts', 'require-env.sh')
const androidWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'android-release.yml'), 'utf8')
const desktopWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'desktop-release.yml'), 'utf8')

// The spawned script gets a fully replaced environment — nothing ambient
// can leak a variable the test did not set.
const runRequireEnv = (names: string[], vars: Record<string, string>) => {
  const result = spawnSync(requireEnv, names, {
    env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', ...vars },
    encoding: 'utf8',
  })
  return { output: `${result.stdout ?? ''}${result.stderr ?? ''}`, exitCode: result.status ?? -1 }
}

describe('scripts/require-env.sh', () => {
  test('every required variable set exits 0 and never prints a value', async () => {
    const { output, exitCode } = runRequireEnv(
      ['APPLE_CERTIFICATE', 'APPLE_ID', 'APPLE_TEAM_ID'],
      {
        APPLE_CERTIFICATE: 'cert-p12-bytes-abc123',
        APPLE_ID: 'owner@example.com',
        APPLE_TEAM_ID: 'TEAM123456',
      },
    )
    expect(exitCode).toBe(0)
    expect(output).toMatch(/APPLE_CERTIFICATE\s+set \(21 characters\)/)
    expect(output).toMatch(/APPLE_ID\s+set \(17 characters\)/)
    expect(output).toMatch(/APPLE_TEAM_ID\s+set \(10 characters\)/)
    expect(output).not.toContain('cert-p12-bytes-abc123')
    expect(output).not.toContain('owner@example.com')
    expect(output).not.toContain('TEAM123456')
    expect(output).not.toContain('::error::')
  })

  test('one missing variable exits 1 and names it in ::error::', async () => {
    const { output, exitCode } = runRequireEnv(
      ['ANDROID_KEY_ALIAS', 'ANDROID_KEYSTORE_BASE64'],
      {
        ANDROID_KEY_ALIAS: 'upload',
        ANDROID_KEYSTORE_BASE64: '',
      },
    )
    expect(exitCode).toBe(1)
    expect(output).toMatch(/ANDROID_KEY_ALIAS\s+set \(6 characters\)/)
    expect(output).toMatch(/ANDROID_KEYSTORE_BASE64\s+MISSING/)
    expect(output).toContain('::error::ANDROID_KEYSTORE_BASE64 is not set for this repository')
    expect(output).toContain('Settings -> Secrets and variables -> Actions')
    expect(output).not.toContain('::error::ANDROID_KEY_ALIAS')
  })

  test('several missing variables are all named', async () => {
    const { output, exitCode } = runRequireEnv(
      [
        'ANDROID_KEYSTORE_BASE64',
        'ANDROID_KEYSTORE_PASSWORD',
        'ANDROID_KEY_ALIAS',
        'ANDROID_KEY_PASSWORD',
        'CLOUDFLARE_API_TOKEN',
        'CLOUDFLARE_ACCOUNT_ID',
      ],
      {
        CLOUDFLARE_ACCOUNT_ID: 'acct-1',
        CLOUDFLARE_API_TOKEN: 'cf-token-value',
      },
    )
    expect(exitCode).toBe(1)
    for (const name of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
      expect(output).toMatch(new RegExp(`${name}\\s+MISSING`))
      expect(output).toContain(`::error::${name} is not set`)
    }
    expect(output).toMatch(/CLOUDFLARE_ACCOUNT_ID\s+set \(6 characters\)/)
    expect(output).toMatch(/CLOUDFLARE_API_TOKEN\s+set \(14 characters\)/)
    expect(output).not.toContain('cf-token-value')
  })

  test('an empty string counts as missing', async () => {
    const { output, exitCode } = runRequireEnv(['APPLE_TEAM_ID'], { APPLE_TEAM_ID: '' })
    expect(exitCode).toBe(1)
    expect(output).toMatch(/APPLE_TEAM_ID\s+MISSING/)
    expect(output).toContain('::error::APPLE_TEAM_ID is not set')
  })
})

describe('release workflow credential gates', () => {
  test('android-release.yml fails closed instead of warn-and-skip', () => {
    expect(androidWorkflow).toContain('scripts/require-env.sh')
    expect(androidWorkflow).toContain('ANDROID_KEYSTORE_BASE64')
    expect(androidWorkflow).toContain('CLOUDFLARE_ACCOUNT_ID')
    // No ready output, no step gate, no warning-based skip path survives.
    expect(androidWorkflow).not.toContain('outputs.ready')
    expect(androidWorkflow).not.toContain('steps.keys')
    expect(androidWorkflow).not.toContain('::warning')
    expect(androidWorkflow).not.toContain('ready=')
  })

  test('desktop-release.yml notarizes unconditionally and validates the staple', () => {
    expect(desktopWorkflow).toContain('scripts/require-env.sh')
    expect(desktopWorkflow).toContain('xcrun stapler validate')
    // The notarytool submit must not sit inside an `if [ -n … ]` credential
    // guard — walk back from the submit line to its `run: |` block.
    const lines = desktopWorkflow.split('\n')
    const submitIndex = lines.findIndex((line) => line.includes('xcrun notarytool submit'))
    expect(submitIndex).toBeGreaterThan(-1)
    let runStart = submitIndex
    while (runStart >= 0 && !lines[runStart].includes('run: |')) runStart -= 1
    expect(runStart).toBeGreaterThan(-1)
    for (let i = runStart + 1; i < submitIndex; i += 1) {
      expect(lines[i]).not.toMatch(/^\s*if \[ -n/)
    }
  })
})
