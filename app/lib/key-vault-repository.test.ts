import { describe, expect, test } from 'bun:test'
import { deleteGalleryKey, dropOwnerKeyVault, getGalleryKey, getOwnerVault, putGalleryKey, putOwnerVault } from './key-vault-repository'

const OWNER = 'acct-keyvault-test'

const vaultRecord = (wrappedVk = 'cipher') => ({ kdfSalt: 'salt', kdfIterations: 600_000, wrappedVk, vkNonce: 'nonce', version: 1 })

describe('key-vault-repository (memory store)', () => {
  test('the owner vault creates, conditionally replaces, and reads back', async () => {
    expect(await getOwnerVault(OWNER)).toBeNull()
    const stored = await putOwnerVault(OWNER, vaultRecord(), null)
    expect(stored?.updatedAt).toBeTruthy()
    expect(await getOwnerVault(OWNER)).toMatchObject(vaultRecord())
    // A create-only write against an existing row conflicts instead of
    // clobbering — the stale device must adopt what is stored.
    expect(await putOwnerVault(OWNER, vaultRecord('other'), null)).toBeNull()
    expect((await getOwnerVault(OWNER))?.wrappedVk).toBe('cipher')
    // A replace stamped against the right updatedAt lands; a stale stamp
    // conflicts without touching the row.
    expect(await putOwnerVault(OWNER, vaultRecord('stale'), 'not-the-stamp')).toBeNull()
    const rotated = await putOwnerVault(OWNER, vaultRecord('rotated'), stored!.updatedAt)
    expect(rotated?.wrappedVk).toBe('rotated')
    expect((await getOwnerVault(OWNER))?.wrappedVk).toBe('rotated')
  })

  test('gallery keys upsert per owner+gallery and delete with the gallery', async () => {
    expect(await getGalleryKey(OWNER, 'gal-1')).toBeNull()
    await putGalleryKey(OWNER, 'gal-1', { wrappedSource: 'w1', nonce: 'n1' }, null)
    await putGalleryKey(OWNER, 'gal-2', { wrappedSource: 'w2', nonce: 'n2' }, null)
    await putGalleryKey('acct-other', 'gal-1', { wrappedSource: 'other', nonce: 'no' }, null)
    expect((await getGalleryKey(OWNER, 'gal-1'))?.wrappedSource).toBe('w1')
    expect((await getGalleryKey(OWNER, 'gal-2'))?.wrappedSource).toBe('w2')
    // The same gallery id under another owner is an independent row.
    expect((await getGalleryKey('acct-other', 'gal-1'))?.wrappedSource).toBe('other')
    await deleteGalleryKey(OWNER, 'gal-1')
    expect(await getGalleryKey(OWNER, 'gal-1')).toBeNull()
    expect((await getGalleryKey('acct-other', 'gal-1'))?.wrappedSource).toBe('other')
  })

  test('a gallery key create-only conflicts on an existing row, and a stale stamp cannot replace', async () => {
    const stored = await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'first', nonce: 'n1' }, null)
    expect(stored).not.toBeNull()
    expect(await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'second', nonce: 'n2' }, null)).toBeNull()
    expect((await getGalleryKey(OWNER, 'gal-cas'))?.wrappedSource).toBe('first')
    expect(await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'second', nonce: 'n2' }, 'stale-stamp')).toBeNull()
    expect((await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'second', nonce: 'n2' }, stored!.updatedAt))?.wrappedSource).toBe('second')
  })

  test('dropping one owner never touches a neighbour whose id shares the prefix', async () => {
    // Regression for the prefix-purge collision: "ab" deleting its vault
    // used to sweep "abc"'s wrapped keys because the runtime key joined
    // the ids with no separator.
    await putGalleryKey('ab', 'gal-x', { wrappedSource: 'w-ab', nonce: 'n' }, null)
    await putGalleryKey('abc', 'gal-y', { wrappedSource: 'w-abc', nonce: 'n' }, null)
    await dropOwnerKeyVault('ab')
    expect(await getGalleryKey('ab', 'gal-x')).toBeNull()
    expect((await getGalleryKey('abc', 'gal-y'))?.wrappedSource).toBe('w-abc')
  })
})
