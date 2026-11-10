import { beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The desktop vault's Tauri seam, exercised end to end: the storage and key
 * adapters run against an invoke stub that replicates the Rust commands on a
 * real temporary directory (mkdir -p on write, rename on move, flat walk on
 * list), so a written entry must read back — the same contract the fill's
 * commit verification relies on.
 */

const root = mkdtempSync(join(tmpdir(), 'manorama-vault-test-'))
const VAULT_ROOT = 'manorama-vault-v1'
const keychain = new Map<string, string>()
let missingKeyReply: 'null' | 'undefined' = 'null'

const entryPath = (path: string): string => {
  const relative = path.startsWith(`${VAULT_ROOT}/`) ? path.slice(VAULT_ROOT.length + 1) : null
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`vault path outside the vault root: ${path}`)
  }
  return join(root, relative)
}

const installTauri = () => {
  const win = new Window() as unknown as Record<string, unknown>
  const globals = globalThis as Record<string, unknown>
  for (const key of ['window', 'document', 'localStorage', 'HTMLElement', 'MutationObserver']) {
    if (win[key] !== undefined) globals[key] = win[key]
  }
  win.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => {
      if (command === 'vault_write') {
        const target = entryPath(String(options?.headers?.['x-vault-path'] ?? ''))
        mkdirSync(join(target, '..'), { recursive: true })
        const { writeFileSync } = await import('node:fs')
        writeFileSync(target, Buffer.from(args as Uint8Array))
        return null
      }
      const record = args as Record<string, unknown> | undefined
      const path = String(record?.path ?? '')
      if (command === 'vault_read') {
        try {
          const bytes = readFileSync(entryPath(path))
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        } catch {
          return new ArrayBuffer(0)
        }
      }
      if (command === 'vault_move') {
        renameSync(entryPath(String(record?.from)), entryPath(String(record?.to)))
        return null
      }
      if (command === 'vault_remove') {
        try { rmSync(entryPath(path)) } catch {}
        return null
      }
      if (command === 'vault_list') {
        try {
          return readdirSync(root).map((name) => ({ path: `${VAULT_ROOT}/${name}`, bytes: statSync(join(root, name)).size }))
        } catch {
          return []
        }
      }
      if (command === 'vault_key_get') {
        const value = keychain.get(String(record?.name))
        // The SwiftUI shell answers a nil result by omitting `value` from the
        // reply entirely, which the page receives as `undefined`; Tauri
        // serialises `Ok(None)` as `null`. Both must read as "absent".
        return value === undefined ? (missingKeyReply === 'undefined' ? undefined : null) : value
      }
      if (command === 'vault_key_set') { keychain.set(String(record?.name), String(record?.value)); return null }
      if (command === 'vault_key_remove') { keychain.delete(String(record?.name)); return null }
      return null
    },
    transformCallback: () => 1,
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
  }
  globals.window = win
}

describe('desktop vault round-trip through the Tauri seam', () => {
  beforeAll(installTauri)

  test('entries written then read back are never lost', async () => {
    const { desktopVault } = await import('./vault')
    const galleryId = 'repro-gallery'
    const count = 12
    for (let i = 0; i < count; i++) {
      const plaintext = new Uint8Array(64 * 1024).fill(i + 1)
      await desktopVault.write(galleryId, `entry-${i}`, plaintext)
    }
    for (let i = 0; i < count; i++) {
      const bytes = await desktopVault.read(galleryId, `entry-${i}`, { touch: false })
      expect(bytes).not.toBeUndefined()
      expect(bytes?.[0]).toBe(i + 1)
    }
    const usage = await desktopVault.usage()
    expect(usage.measuredBytes).toBeGreaterThan(64 * 1024)
    await desktopVault.clearGallery(galleryId)
    expect(keychain.size).toBe(0)
    const after = await desktopVault.usage()
    expect(after.measuredBytes).toBeLessThanOrEqual(64)
  })

  test('a missing-key reply without a value still counts as absent on purge', async () => {
    const { desktopVault } = await import('./vault')
    missingKeyReply = 'undefined'
    try {
      const galleryId = 'omitted-value-gallery'
      await desktopVault.write(galleryId, 'entry-0', new Uint8Array(256).fill(5))
      // clearGallery's verified key removal used to read the omitted reply
      // value (`undefined`) as a surviving key and fail the whole purge.
      await desktopVault.clearGallery(galleryId)
      expect(keychain.size).toBe(0)
    } finally {
      missingKeyReply = 'null'
    }
  })

  test('an entry written under a stale index survives a mid-fill read', async () => {
    const { desktopVault } = await import('./vault')
    // Miss-read before the first write (the fill's reuse probe), then write,
    // then verify — the sequence that surfaced as a false over-cap.
    expect(await desktopVault.read('g2', 'e0', { touch: true })).toBeUndefined()
    const payload = new Uint8Array(1024).fill(7)
    await desktopVault.write('g2', 'e0', payload)
    await desktopVault.remove('g2', 'local-compute:never-written')
    const back = await desktopVault.read('g2', 'e0', { touch: false })
    expect(back?.[0]).toBe(7)
    await desktopVault.clearGallery('g2')
  })
})
