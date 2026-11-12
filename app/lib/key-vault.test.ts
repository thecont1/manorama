import { beforeEach, describe, expect, test } from 'bun:test'
import {
  cacheVaultKey, cachedVaultKey, createVault, ensureVaultKey, fetchGalleryKey, keySyncShouldPrompt,
  openVault, unwrapSourceForVault, wrapSourceForVault, type OwnerVaultRecord,
} from './key-vault'

const SOURCE = 'https://mega.nz/collection/MzBkCAJQ#trUGvGYJjEXwekPxeAkUHQ'

const session = new Map<string, string>()
const globals = globalThis as Record<string, unknown>
let putBodies: Array<OwnerVaultRecord & { expectedUpdatedAt?: string | null }> = []

/** A minimal CAS-speaking vault endpoint: null expectedUpdatedAt means
 *  create-only, a stale stamp means replace-only-if-current. */
let serverVault: { record: OwnerVaultRecord; updatedAt: string } | null = null

beforeEach(() => {
  session.clear()
  putBodies = []
  serverVault = null
  globals.sessionStorage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => { session.set(key, value) },
    removeItem: (key: string) => { session.delete(key) },
  }
})

const stubFetch = (record: OwnerVaultRecord | null) => {
  serverVault = record ? { record, updatedAt: '2026-01-01T00:00:00.000Z' } : null
  globals.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      putBodies.push(body)
      const expected = body.expectedUpdatedAt
      const conflict = expected === null ? serverVault !== null : serverVault?.updatedAt !== expected
      if (conflict) {
        return new Response(JSON.stringify({
          error: 'conflict',
          vault: serverVault ? { ...serverVault.record, updatedAt: serverVault.updatedAt } : null,
        }), { status: 409 })
      }
      const { expectedUpdatedAt: _ignored, ...record } = body
      serverVault = { record, updatedAt: new Date().toISOString() }
      return new Response(JSON.stringify({ vault: { ...serverVault.record, updatedAt: serverVault.updatedAt } }), { status: 200 })
    }
    return new Response(JSON.stringify({ vault: path.endsWith('/key-vault') && serverVault ? { ...serverVault.record, updatedAt: serverVault.updatedAt } : null }), { status: 200 })
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

  test('a gallery-bound wrap fails authentication on a different gallery row', async () => {
    const { vaultKey } = await createVault('passphrase')
    const wrapped = await wrapSourceForVault(vaultKey, SOURCE, 'gallery-one')
    // Same gallery: opens.
    expect(await unwrapSourceForVault(vaultKey, wrapped, 'gallery-one')).toBe(SOURCE)
    // The record moved to another gallery's row: the AAD refuses it and the
    // legacy path cannot rescue an AAD-tagged ciphertext.
    await expect(unwrapSourceForVault(vaultKey, wrapped, 'gallery-two')).rejects.toThrow()
    // A pre-AAD record still opens when asked for a specific gallery —
    // compatibility until the escrow is rewrapped.
    const legacy = await wrapSourceForVault(vaultKey, SOURCE)
    expect(await unwrapSourceForVault(vaultKey, legacy, 'gallery-two')).toBe(SOURCE)
  })

  test('ensureVaultKey creates the record when none exists, and reuses one that does', async () => {
    stubFetch(null)
    const first = await ensureVaultKey('my passphrase')
    expect(putBodies).toHaveLength(1) // the new vault record was PUT
    expect(putBodies[0]!.expectedUpdatedAt).toBeNull() // create-only, never clobber
    const record = putBodies[0] as OwnerVaultRecord
    stubFetch(record)
    const second = await ensureVaultKey('my passphrase')
    expect(putBodies).toHaveLength(1) // no second PUT — the vault was opened
    const wrapped = await wrapSourceForVault(second, SOURCE)
    expect(await unwrapSourceForVault(first, wrapped)).toBe(SOURCE)
  })

  test('ensureVaultKey adopts the winner of a create race instead of clobbering it', async () => {
    // Device A creates its vault on the server first.
    stubFetch(null)
    const vaultA = await ensureVaultKey('shared passphrase')
    const recordA = serverVault!.record
    expect(putBodies).toHaveLength(1)

    // Device B read "no vault" before A's write landed, then PUTs —
    // the server conflicts and hands back A's record, which B must open
    // rather than replace. No second read is needed: the 409 carries it.
    const seenB: string[] = []
    globals.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'PUT') {
        seenB.push('put')
        return new Response(JSON.stringify({ error: 'conflict', vault: { ...recordA, updatedAt: serverVault!.updatedAt } }), { status: 409 })
      }
      seenB.push(`get:${path.endsWith('/key-vault')}`)
      // B's one read raced A's write: still empty.
      return new Response(JSON.stringify({ vault: null }), { status: 200 })
    }) as unknown as typeof fetch
    const vaultB = await ensureVaultKey('shared passphrase')
    expect(seenB).toEqual(['get:true', 'put'])
    // B adopted A's vault key — keys wrapped under it unwrap on B.
    const wrappedByA = await wrapSourceForVault(vaultA, SOURCE)
    expect(await unwrapSourceForVault(vaultB, wrappedByA)).toBe(SOURCE)
    // And the server still holds A's record — one vault, no orphans.
    expect(serverVault!.record).toBe(recordA)
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

  test('fetchGalleryKey returns null only for a stored-nothing read — a failed read throws', async () => {
    globals.fetch = (async () => new Response(JSON.stringify({ key: null }), { status: 200 })) as unknown as typeof fetch
    // The gallery answered and holds no wrapped key — the prompt decision
    // may treat this as "not escrowed".
    expect(await fetchGalleryKey('italy')).toBeNull()
    globals.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    // A failed read must surface as a failure, not as "not escrowed" —
    // otherwise an outage fires the passphrase card for no reason.
    await expect(fetchGalleryKey('italy')).rejects.toThrow('The gallery key could not be read')
    globals.fetch = (async () => new Response(JSON.stringify({ key: { wrappedSource: 'abc', nonce: 'n', updatedAt: '2026-01-01T00:00:00.000Z' } }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchGalleryKey('italy')).toEqual({ wrapped: { wrappedSource: 'abc', nonce: 'n' }, updatedAt: '2026-01-01T00:00:00.000Z' })
    // A key row without its concurrency stamp is malformed — never treated
    // as something safe to overwrite.
    globals.fetch = (async () => new Response(JSON.stringify({ key: { wrappedSource: 'abc', nonce: 'n' } }), { status: 200 })) as unknown as typeof fetch
    await expect(fetchGalleryKey('italy')).rejects.toThrow('The gallery key response was not valid')
  })
})
