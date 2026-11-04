import { describe, expect, test } from 'bun:test'
import { NativeGalleryKeyStore, isGalleryIdValid, type NativeKeyStorage } from './gallery-key-store'

class MemoryNativeKeyStorage implements NativeKeyStorage {
  readonly values = new Map<string, string>()
  async getItem(key: string) { return this.values.get(key) ?? null }
  async setItem(key: string, value: string) { this.values.set(key, value) }
  async removeItem(key: string) { this.values.delete(key) }
}

const source = 'https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA'
const galleryId = '0123456789abcdef0123456789abcdef'

const makeStore = () => {
  const storage = new MemoryNativeKeyStorage()
  return { storage, store: new NativeGalleryKeyStore(storage) }
}

describe('native gallery key store', () => {
  test('keys secrets by immutable gallery id and never touches the vault or plain storage', async () => {
    const { storage, store } = makeStore()
    await store.put(galleryId, source)
    expect(await store.get(galleryId)).toBe(source)
    expect(await store.get('0123456789abcdef0123456789abcdee')).toBeNull()
    // The registry is the only auxiliary record, and it stores only ids —
    // the keyed source URL itself lives only under the prefixed key.
    const registryKeys = [...storage.values.keys()].filter((key) => key.includes('registry'))
    expect(registryKeys).toHaveLength(1)
    expect(JSON.parse(storage.values.get(registryKeys[0]!)!)).toEqual([galleryId])
    expect(storage.values.get(`manorama.gallery-key.v1.${galleryId}`)).toBe(source)
  })

  test('updates a known source when the key rotates', async () => {
    const { store } = makeStore()
    await store.put(galleryId, source)
    await store.put(galleryId, `https://mega.nz/folder/AbCdEf12#rotated-key`)
    expect(await store.get(galleryId)).toBe('https://mega.nz/folder/AbCdEf12#rotated-key')
  })

  test('rejects invalid ids and keyless or unencrypted source records', async () => {
    const { storage, store } = makeStore()
    await expect(store.put('nope', source)).rejects.toThrow()
    await expect(store.put(galleryId, 'https://mega.nz/folder/AbCdEf12')).rejects.toThrow()
    await expect(store.put(galleryId, 'https://dropbox.com/sh/a/b')).rejects.toThrow()
    expect(storage.values.size).toBe(0)
  })

  test('deletion clears the key so slug reuse cannot inherit it', async () => {
    const { storage, store } = makeStore()
    await store.put(galleryId, source)
    await store.remove(galleryId)
    expect(await store.get(galleryId)).toBeNull()
    expect(await store.list()).toEqual([])
    expect([...storage.values.values()].some((value) => value.includes('a2V5'))).toBe(false)
  })

  test('a corrupted stored value reads as absent and is purged', async () => {
    const { storage, store } = makeStore()
    await store.put(galleryId, source)
    storage.values.set(`manorama.gallery-key.v1.${galleryId}`, 'https://mega.nz/folder/AbCdEf12')
    expect(await store.get(galleryId)).toBeNull()
    expect(await store.list()).toEqual([])
  })

  test('purgeAll erases every gallery key on sign-out', async () => {
    const { storage, store } = makeStore()
    await store.put(galleryId, source)
    await store.put('0123456789abcdef0123456789abcdff', 'https://mega.nz/folder/AbCdEf12#second-key')
    await store.purgeAll()
    expect(await store.list()).toEqual([])
    expect(await store.get(galleryId)).toBeNull()
    expect(await store.get('0123456789abcdef0123456789abcdff')).toBeNull()
    expect([...storage.values.values()].some((value) => value.includes('a2V5'))).toBe(false)
  })

  test('id validation matches the web store contract', () => {
    expect(isGalleryIdValid(galleryId)).toBe(true)
    expect(isGalleryIdValid('short')).toBe(false)
    expect(isGalleryIdValid('with space 1234567890abcdef')).toBe(false)
  })
})
