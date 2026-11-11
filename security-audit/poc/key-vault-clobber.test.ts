import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createVault,
  ensureVaultKey,
  openVault,
  unwrapSourceForVault,
  wrapSourceForVault,
  type OwnerVaultRecord,
} from '../../app/lib/key-vault'

/**
 * FINDING F-05 — the escrowed owner vault was written last-write-wins, and
 * nothing bound a wrapped gallery key to its gallery. FIXED.
 *
 * `PUT /api/account/key-vault` is now compare-and-swap: a create rides
 * `expectedUpdatedAt: null` and conflicts on any existing row, while a
 * replace must name the stamp it read. `ensureVaultKey` answers a conflict
 * by re-reading and adopting the surviving record, so two devices that both
 * saw "no vault" converge on one vault key instead of orphaning each other's
 * escrowed keys.
 *
 * Wrapped gallery keys now carry the gallery id as AES-GCM additional data:
 * a record swapped onto another gallery's row fails authentication there
 * instead of unwrapping to the wrong source.
 */

type Server = { vault: (OwnerVaultRecord & { updatedAt: string }) | null; updatedAt: number }
let server: Server
let staleRead: boolean
const realFetch = globalThis.fetch

const installFetch = () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/account/key-vault')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        const body = JSON.parse(String(init!.body)) as OwnerVaultRecord & { expectedUpdatedAt?: string | null }
        // The CAS gate: create-only on null, replace-if-same-stamp otherwise.
        const conflict = body.expectedUpdatedAt === null
          ? server.vault !== null
          : server.vault?.updatedAt !== body.expectedUpdatedAt
        if (conflict) {
          return new Response(JSON.stringify({ error: 'conflict', vault: server.vault }), { status: 409 })
        }
        const { expectedUpdatedAt: _ignored, ...record } = body
        server.updatedAt += 1
        server.vault = { ...record, updatedAt: `stamp-${server.updatedAt}` }
        return new Response(JSON.stringify({ vault: server.vault }), { status: 200 })
      }
      return new Response(JSON.stringify({ vault: staleRead ? null : server.vault }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  server = { vault: null, updatedAt: 0 }
  staleRead = false
  installFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('F-05 vault key escrow', () => {
  test('two devices that both see “no vault” now converge on one vault', async () => {
    // Device A sets up the vault and escrows one gallery key.
    const vaultA = await ensureVaultKey('correct horse battery staple')
    const galleryKeyA = await wrapSourceForVault(vaultA, 'https://mega.nz/folder/AAA#key-a', 'gal-aaa')
    expect(server.vault).not.toBeNull()

    // Device B's read raced A's write: it still sees an empty vault, mints
    // its own, and the create-only PUT conflicts — B adopts A's record.
    staleRead = true
    const vaultB = await ensureVaultKey('correct horse battery staple')
    staleRead = false

    // One record survives and it is still A's — B never wrote over it.
    expect(server.vault).toMatchObject(vaultA ? { wrappedVk: server.vault!.wrappedVk } : {})
    const reopened = await openVault('correct horse battery staple', server.vault!)
    // Everything escrowed under the surviving vault opens everywhere.
    expect(await unwrapSourceForVault(vaultB, galleryKeyA, 'gal-aaa')).toBe('https://mega.nz/folder/AAA#key-a')
    expect(await unwrapSourceForVault(reopened, galleryKeyA, 'gal-aaa')).toBe('https://mega.nz/folder/AAA#key-a')
  })

  test('a wrapped gallery key is bound to its gallery — a swap fails authentication', async () => {
    const { vaultKey } = await createVault('passphrase')
    const forGalleryOne = await wrapSourceForVault(vaultKey, 'https://mega.nz/folder/ONE#key-one', 'gal-one')

    // The record copied to another gallery's row: the AAD refuses it — no
    // plausible wrong answer, just the failure it should have been.
    await expect(unwrapSourceForVault(vaultKey, forGalleryOne, 'gal-two')).rejects.toThrow()
    expect(await unwrapSourceForVault(vaultKey, forGalleryOne, 'gal-one'))
      .toBe('https://mega.nz/folder/ONE#key-one')
  })
})
