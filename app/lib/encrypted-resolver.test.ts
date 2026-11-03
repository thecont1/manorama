import { afterEach, describe, expect, test } from 'bun:test'
import { EncryptedMediaResolver, type EncryptedClientSession } from './encrypted-resolver'
import type { MediaReference } from '../../packages/core/encrypted-source'

const ref: MediaReference = { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'source', nodeId: 'node' }
const session = (materialize: EncryptedClientSession['materialize']): EncryptedClientSession => ({
  provider: 'mega', sourceUrl: 'https://mega.nz/folder/source#key', title: 'x', images: [], materialize, dispose: () => {},
})
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
let revoked: string[]
let created: number

afterEach(() => {
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
})
const stubUrls = () => {
  revoked = []
  created = 0
  URL.createObjectURL = (() => `blob:test-${++created}`) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => { revoked.push(url) }) as typeof URL.revokeObjectURL
}

describe('encrypted media resolver', () => {
  test('dedupes concurrent requests and shares an owned object URL', async () => {
    stubUrls()
    let calls = 0
    const resolver = new EncryptedMediaResolver(session(async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }
    }))
    const [a, b] = await Promise.all([resolver.acquire(ref, false), resolver.acquire(ref, false)])
    expect(a).toBe(b)
    expect(calls).toBe(1)
    resolver.dispose()
    expect(revoked).toEqual([a])
  })

  test('cancellation of one caller does not cancel a shared live request', async () => {
    stubUrls()
    const resolver = new EncryptedMediaResolver(session(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' }
    }))
    const controller = new AbortController()
    const cancelled = resolver.acquire(ref, false, controller.signal)
    const live = resolver.acquire(ref, false)
    controller.abort()
    await expect(cancelled).rejects.toThrow()
    expect(await live).toBe('blob:test-1')
    resolver.dispose()
  })

  test('evicts only unreferenced URLs to stay within the byte budget', async () => {
    stubUrls()
    const other = { ...ref, nodeId: 'other' }
    const resolver = new EncryptedMediaResolver(session(async (media) => ({
      bytes: new Uint8Array('nodeId' in media && media.nodeId === 'node' ? 4 : 4), mimeType: 'image/jpeg',
    })), { maxBytes: 4 })
    const first = await resolver.acquire(ref, false)
    await expect(resolver.acquire(other, false)).rejects.toThrow('working set')
    resolver.release(ref, false)
    const second = await resolver.acquire(other, false)
    expect(second).toBe('blob:test-3')
    expect(revoked).toContain(first)
    resolver.dispose()
  })

  test('an aborted fetch can be re-acquired cleanly', async () => {
    stubUrls()
    let calls = 0
    const resolver = new EncryptedMediaResolver(session(async () => {
      calls += 1
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        throw new Error('network gone')
      }
      return { bytes: new Uint8Array([9]), mimeType: 'image/jpeg' }
    }))
    const controller = new AbortController()
    const cancelled = resolver.acquire(ref, false, controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow()
    // The in-flight materialize keeps running past the abort; wait for its
    // rejection to settle and evict before retrying.
    await new Promise((resolve) => setTimeout(resolve, 30))
    // The rejected entry must be evicted — a retry fetches fresh bytes
    // rather than serving the stale rejection.
    expect(await resolver.acquire(ref, false)).toBe('blob:test-1')
    expect(calls).toBe(2)
    resolver.dispose()
  })

  test('wipes session keys and plaintext on disposal', async () => {
    stubUrls()
    let disposed = false
    const bytes = new Uint8Array([1, 2, 3])
    const resolver = new EncryptedMediaResolver({
      provider: 'mega', sourceUrl: 'https://mega.nz/folder/source#key', title: 'x', images: [],
      materialize: async () => ({ bytes, mimeType: 'image/jpeg' }),
      dispose: () => { disposed = true },
    })
    await resolver.acquire(ref, false)
    resolver.dispose()
    expect(disposed).toBe(true)
    expect(bytes.every((byte) => byte === 0)).toBe(true)
  })
})
