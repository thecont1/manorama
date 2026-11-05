import { describe, expect, test } from 'bun:test'
import { deleteGalleryKey, getGalleryKey, getOwnerVault, putGalleryKey, putOwnerVault } from './key-vault-repository'

const OWNER = 'acct-keyvault-test'

describe('key-vault-repository (memory store)', () => {
  test('the owner vault upserts and reads back', async () => {
    expect(await getOwnerVault(OWNER)).toBeNull()
    const record = { kdfSalt: 'salt', kdfIterations: 600_000, wrappedVk: 'cipher', vkNonce: 'nonce', version: 1 }
    const stored = await putOwnerVault(OWNER, record)
    expect(stored.updatedAt).toBeTruthy()
    expect(await getOwnerVault(OWNER)).toMatchObject(record)
    await putOwnerVault(OWNER, { ...record, wrappedVk: 'rotated' })
    expect((await getOwnerVault(OWNER))?.wrappedVk).toBe('rotated')
  })

  test('gallery keys upsert per owner+gallery and delete with the gallery', async () => {
    expect(await getGalleryKey(OWNER, 'gal-1')).toBeNull()
    await putGalleryKey(OWNER, 'gal-1', { wrappedSource: 'w1', nonce: 'n1' })
    await putGalleryKey(OWNER, 'gal-2', { wrappedSource: 'w2', nonce: 'n2' })
    await putGalleryKey('acct-other', 'gal-1', { wrappedSource: 'other', nonce: 'no' })
    expect((await getGalleryKey(OWNER, 'gal-1'))?.wrappedSource).toBe('w1')
    expect((await getGalleryKey(OWNER, 'gal-2'))?.wrappedSource).toBe('w2')
    // The same gallery id under another owner is an independent row.
    expect((await getGalleryKey('acct-other', 'gal-1'))?.wrappedSource).toBe('other')
    await deleteGalleryKey(OWNER, 'gal-1')
    expect(await getGalleryKey(OWNER, 'gal-1')).toBeNull()
    expect((await getGalleryKey('acct-other', 'gal-1'))?.wrappedSource).toBe('other')
  })
})
