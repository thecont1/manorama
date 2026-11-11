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
 * FINDING F-05 — the escrowed owner vault key is written last-write-wins, and
 * nothing binds a wrapped gallery key to its gallery.
 *
 * `PUT /api/account/key-vault` replaces the whole record with no
 * compare-and-swap, and `ensureVaultKey` fetches-then-writes with a gap in
 * between. Two devices whose reads both see "no vault" (a fresh account on two
 * devices, or the same second-day reinstall) each mint a vault key and each
 * overwrite the other's record. The losing key is gone from the server, and
 * every gallery key wrapped under it can never be unwrapped again — the owner
 * has to re-supply each source link, which is exactly the recovery the vault
 * exists to avoid.
 *
 * The second test shows there is no AAD: `wrapSourceForVault` seals the source
 * URL with no gallery identity, so a gallery key moved to another gallery (a
 * server-side swap, or a copy taken for the wrong row) unwraps cleanly with the
 * wrong answer instead of failing.
 */

type Server = { vault: OwnerVaultRecord | null }
let server: Server
let staleRead: boolean
const realFetch = globalThis.fetch

const installFetch = () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/account/key-vault')) {
      if ((init?.method ?? 'GET') === 'PUT') {
        server.vault = JSON.parse(String(init!.body)) as OwnerVaultRecord
        return new Response(JSON.stringify({ vault: server.vault }), { status: 200 })
      }
      return new Response(JSON.stringify({ vault: staleRead ? null : server.vault }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  server = { vault: null }
  staleRead = false
  installFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('F-05 vault key escrow', () => {
  test('two devices that both see “no vault” overwrite each other and orphan every wrapped key', async () => {
    // Device A sets up the vault and escrows one gallery key.
    const vaultA = await ensureVaultKey('correct horse battery staple')
    const galleryKeyA = await wrapSourceForVault(vaultA, 'https://mega.nz/folder/AAA#key-a')
    expect(server.vault).not.toBeNull()

    // Device B's read raced A's write: it still sees an empty vault, so it
    // creates a second vault and PUTs it over A's.
    staleRead = true
    const vaultB = await ensureVaultKey('correct horse battery staple')
    staleRead = false

    // One record survives — and it is B's.
    const recordB = server.vault!
    const reopened = await openVault('correct horse battery staple', recordB)
    expect(await unwrapSourceForVault(reopened, await wrapSourceForVault(vaultB, 'https://mega.nz/folder/BBB#key-b')))
      .toBe('https://mega.nz/folder/BBB#key-b')

    // A's escrowed gallery key no longer opens under the surviving vault key.
    await expect(unwrapSourceForVault(reopened, galleryKeyA)).rejects.toThrow()

    // Both keys still work locally, so nothing warns the owner: the loss only
    // shows up on the next device, as "the passphrase does not open this".
    expect(await unwrapSourceForVault(vaultA, galleryKeyA)).toBe('https://mega.nz/folder/AAA#key-a')
  })

  test('a wrapped gallery key is not bound to its gallery — a swap unwraps to the wrong source', async () => {
    const { vaultKey } = await createVault('passphrase')
    const forGalleryOne = await wrapSourceForVault(vaultKey, 'https://mega.nz/folder/ONE#key-one')
    const forGalleryTwo = await wrapSourceForVault(vaultKey, 'https://mega.nz/folder/TWO#key-two')

    // Server (or a buggy client) hands gallery one's row the other gallery's
    // record. GCM still authenticates — the ciphertext is intact — so the
    // client gets a plausible, wrong source URL with no error.
    const swapped = { wrappedSource: forGalleryTwo.wrappedSource, nonce: forGalleryTwo.nonce }
    expect(await unwrapSourceForVault(vaultKey, swapped)).toBe('https://mega.nz/folder/TWO#key-two')
    expect(await unwrapSourceForVault(vaultKey, forGalleryOne)).toBe('https://mega.nz/folder/ONE#key-one')
  })
})
