import { beforeEach, describe, expect, test } from 'bun:test'
import {
  cacheVaultKey, cachedVaultKey, createVault, ensureVaultKey, keySyncShouldPrompt,
  openVault, unwrapSourceForVault, wrapSourceForVault, type OwnerVaultRecord,
} from './key-vault'

const SOURCE = 'https://mega.nz/collection/MzBkCAJQ#trUGvGYJjEXwekPxeAkUHQ'

const session = new Map<string, string>()
const globals = globalThis as Record<string, unknown>
let putBodies: unknown[] = []

beforeEach(() => {
  session.clear()
  putBodies = []
  globals.sessionStorage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => { session.set(key, value) },
    removeItem: (key: string) => { session.delete(key) },
  }
})

const stubFetch = (record: OwnerVaultRecord | null) => {
  globals.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'PUT') { putBodies.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }) }
    return new Response(JSON.stringify({ vault: path.endsWith('/key-vault') ? record : null }), { status: 200 })
  }) as unknown as typeof fetch
}

describe('the key vault', () => {
  test('a vault round-trips: create, open with the passphrase, wrap and unwrap a source', async () => {
    const { vaultKey, record } = await createVault('correct horse battery staple')
    expect(record.version).toBe(1)
    expect(record.kdfSalt).toBeTruthy()
    expect(record.wrappedVk).toBeTruthy()
    // The passphrase and the raw key never appear in the record.
    expect(JSON.stringify(record)).not.toContain('correct horse')
    const reopened = await openVault('correct horse battery staple', record)
    const wrapped = await wrapSourceForVault(reopened, SOURCE)
    expect(wrapped.wrappedSource).not.toContain('mega.nz')
    expect(await unwrapSourceForVault(reopened, wrapped)).toBe(SOURCE)
    expect(await unwrapSourceForVault(vaultKey, wrapped)).toBe(SOURCE)
  })

  test('a wrong passphrase fails to unwrap the vault key', async () => {
    const { record } = await createVault('correct horse battery staple')
    await expect(openVault('wrong passphrase', record)).rejects.toThrow()
  })

  test('a wrapped source does not unwrap under a different vault key', async () => {
    const a = await createVault('passphrase a')
    const b = await createVault('passphrase b')
    const wrapped = await wrapSourceForVault(a.vaultKey, SOURCE)
    await expect(unwrapSourceForVault(b.vaultKey, wrapped)).rejects.toThrow()
  })

  test('ensureVaultKey creates the record when none exists, and reuses one that does', async () => {
    stubFetch(null)
    const first = await ensureVaultKey('my passphrase')
    expect(putBodies).toHaveLength(1) // the new vault record was PUT
    const record = putBodies[0] as OwnerVaultRecord
    stubFetch(record)
    const second = await ensureVaultKey('my passphrase')
    expect(putBodies).toHaveLength(1) // no second PUT — the vault was opened
    const wrapped = await wrapSourceForVault(second, SOURCE)
    expect(await unwrapSourceForVault(first, wrapped)).toBe(SOURCE)
  })

  test('ensureVaultKey surfaces a wrong passphrase instead of silently re-vaulting', async () => {
    const { record } = await createVault('the real passphrase')
    stubFetch(record)
    await expect(ensureVaultKey('a different passphrase')).rejects.toThrow()
    expect(putBodies).toHaveLength(0)
  })

  test('ensureVaultKey rejects when the vault cannot be read — no silent re-vault', async () => {
    globals.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    await expect(ensureVaultKey('any passphrase')).rejects.toThrow()
    // A read failure must not mint a fresh vault — that would orphan every
    // key wrapped under the unreachable one.
    expect(putBodies).toHaveLength(0)
  })

  test('the vault key caches in sessionStorage like the gallery keys', async () => {
    const { vaultKey } = await createVault('passphrase')
    expect(await cachedVaultKey()).toBeNull()
    await cacheVaultKey(vaultKey)
    const cached = await cachedVaultKey()
    expect(cached).not.toBeNull()
    const wrapped = await wrapSourceForVault(cached!, SOURCE)
    expect(await unwrapSourceForVault(vaultKey, wrapped)).toBe(SOURCE)
  })

  test('the passphrase card only surfaces when escrow is actually missing', () => {
    // The one state worth interrupting for: a vault exists, this gallery's
    // key is not yet inside it, and the owner has not dismissed the card.
    expect(keySyncShouldPrompt({ vaultExists: true, alreadyEscrowed: false, dismissed: false })).toBe(true)
    // No vault → prompting would demand account setup mid-gallery.
    expect(keySyncShouldPrompt({ vaultExists: false, alreadyEscrowed: false, dismissed: false })).toBe(false)
    // Already escrowed → the passphrase would accomplish nothing.
    expect(keySyncShouldPrompt({ vaultExists: true, alreadyEscrowed: true, dismissed: false })).toBe(false)
    // Dismissed → "not now" means not on every open.
    expect(keySyncShouldPrompt({ vaultExists: true, alreadyEscrowed: false, dismissed: true })).toBe(false)
  })
})
