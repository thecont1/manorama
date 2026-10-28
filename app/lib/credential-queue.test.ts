import { describe, expect, test } from 'bun:test'
import { createCredentialQueue } from './credential-queue'

const deferred = <T>() => {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('credential-queue', () => {
  test('serialises checks — one in flight at a time', async () => {
    const calls: string[] = []
    const first = deferred<'verified' | 'unavailable'>()
    const check = (id: string) => { calls.push(id); return calls.length === 1 ? first.promise : Promise.resolve('verified' as const) }
    const q = createCredentialQueue(check)
    const a = q.enqueue('a')
    const b = q.enqueue('b')
    expect(calls).toEqual(['a'])
    first.resolve('verified')
    expect(await a).toBe('verified')
    expect(await b).toBe('verified')
    expect(calls).toEqual(['a', 'b'])
    expect(q.statusOf('a')).toBe('verified')
  })

  test('repeat opens of the in-flight id dedupe to one check', async () => {
    const check = () => Promise.resolve('verified' as const)
    const q = createCredentialQueue(check)
    let calls = 0
    const q2 = createCredentialQueue(() => { calls += 1; return Promise.resolve('verified' as const) })
    const [a, b] = await Promise.all([q2.enqueue('x'), q2.enqueue('x')])
    expect(calls).toBe(1)
    expect(a).toBe('verified')
    expect(b).toBe('verified')
    void q
  })

  test('a newer request supersedes a queued-but-unstarted one', async () => {
    const order: string[] = []
    const q = createCredentialQueue(async (id) => { order.push(id); await Promise.resolve(); return 'verified' })
    const first = q.enqueue('a')
    void q.enqueue('b')
    const third = q.enqueue('c')
    await first
    await third
    expect(order).toContain('a')
    expect(order).toContain('c')
    expect(order).not.toContain('b')
  })

  test('a throwing checker resolves unavailable and frees the slot', async () => {
    let calls = 0
    const q = createCredentialQueue(() => { calls += 1; return calls === 1 ? Promise.reject(new Error('reader died')) : Promise.resolve('verified' as const) })
    expect(await q.enqueue('a')).toBe('unavailable')
    expect(await q.enqueue('b')).toBe('verified')
  })

  test('retry after failure re-enqueues', async () => {
    let calls = 0
    const q = createCredentialQueue(() => { calls += 1; return calls === 1 ? Promise.reject(new Error('x')) : Promise.resolve('verified' as const) })
    expect(await q.enqueue('a')).toBe('unavailable')
    expect(await q.enqueue('a')).toBe('verified')
    expect(calls).toBe(2)
  })
})
