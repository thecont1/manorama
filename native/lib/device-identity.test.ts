import { describe, expect, test } from 'bun:test'
import { nativeDeviceId, nativeDeviceKindFor } from './device-identity'

const memoryStorage = (seed: Record<string, string> = {}) => {
  const values = new Map(Object.entries(seed))
  return {
    values,
    async getItem(key: string) { return values.get(key) ?? null },
    async setItem(key: string, value: string) { values.set(key, value) },
  }
}

describe('nativeDeviceId', () => {
  test('creates one id on first use and keeps it', async () => {
    const storage = memoryStorage()
    const first = await nativeDeviceId(storage)
    const second = await nativeDeviceId(storage)
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(storage.values.get('manorama.device-id.v1')).toBe(first)
  })

  test('a stored id is reused rather than replaced', async () => {
    const stored = 'aaaaaaaa-1111-4222-8333-444444444444'
    const storage = memoryStorage({ 'manorama.device-id.v1': stored })
    expect(await nativeDeviceId(storage)).toBe(stored)
  })

  test('a corrupted stored value is replaced, not trusted', async () => {
    const storage = memoryStorage({ 'manorama.device-id.v1': 'not-a-uuid' })
    const id = await nativeDeviceId(storage)
    expect(id).not.toBe('not-a-uuid')
    expect(storage.values.get('manorama.device-id.v1')).toBe(id)
  })

  test('a secure-store failure falls back to a per-launch id instead of throwing', async () => {
    const failing = {
      async getItem() { throw new Error('keychain locked') },
      async setItem() { throw new Error('keychain locked') },
    }
    const first = await nativeDeviceId(failing)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await nativeDeviceId(failing)).toBe(first)
  })
})

describe('nativeDeviceKindFor', () => {
  test('the Android build reports android', () => {
    expect(nativeDeviceKindFor('android')).toBe('android')
  })

  test('iOS reports the device family, never a model', () => {
    expect(nativeDeviceKindFor('ios')).toBe('iphone')
  })
})
