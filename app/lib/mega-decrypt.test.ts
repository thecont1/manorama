import { afterEach, describe, expect, test } from 'bun:test'
import { ctrDecryptClient } from './mega-decrypt'

const globals = globalThis as { Worker?: typeof Worker }
const originalWorker = globals.Worker
afterEach(() => { globals.Worker = originalWorker })

describe('MEGA decrypt worker lifecycle', () => {
  test('abort terminates the worker after it has been created', async () => {
    let instance: { terminated: boolean } | null = null
    globals.Worker = class {
      terminated = false
      onmessage = null
      onerror = null
      constructor() { instance = this }
      postMessage() {}
      terminate() { this.terminated = true }
    } as unknown as typeof Worker
    const controller = new AbortController()
    const pending = ctrDecryptClient(new Uint8Array(16), new Uint8Array(8), new Uint8Array(16), 0, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(instance!.terminated).toBe(true)
  })
})
