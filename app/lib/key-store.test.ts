import { beforeEach, describe, expect, test } from 'bun:test'
import { WebGalleryKeyStore, type KeyStorage } from './key-store'

class MemoryStorage implements KeyStorage {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
}

const source = 'https://mega.nz/folder/AbCdEf12#a2V5LXNlY3JldA'
let storage: MemoryStorage
let store: WebGalleryKeyStore

beforeEach(() => {
  storage = new MemoryStorage()
  store = new WebGalleryKeyStore(storage)
})

describe('web gallery key store', () => {
  test('keys secrets by immutable gallery id and updates a known source', async () => {
    await store.put('0123456789abcdef', source)
    await store.put('0123456789abcdef', 'https://mega.nz/folder/AbCdEf12#rotated-key')
    expect(await store.get('0123456789abcdef')).toBe('https://mega.nz/folder/AbCdEf12#rotated-key')
    expect(await store.get('0123456789abcdee')).toBeNull()
  })

  test('deletion clears the key so slug reuse cannot inherit it', async () => {
    await store.put('0123456789abcdef', source)
    await store.remove('0123456789abcdef')
    expect(await store.get('0123456789abcdef')).toBeNull()
  })

  test('export is explicit and warns that loss is unrecoverable', async () => {
    await store.put('0123456789abcdef', source)
    const exported = await store.export()
    expect(exported.version).toBe(1)
    expect(exported.warning).toContain('cannot be recovered')
    expect(exported.entries['0123456789abcdef']).toBe(source)
  })

  test('invalid or keyless source records fail closed', async () => {
    await expect(store.put('0123456789abcdef', 'https://mega.nz/folder/AbCdEf12')).rejects.toThrow()
    await expect(store.put('0123456789abcdef', 'https://dropbox.com/sh/a/b')).rejects.toThrow()
  })
})
