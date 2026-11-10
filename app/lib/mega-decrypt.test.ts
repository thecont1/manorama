import { afterEach, describe, expect, test } from 'bun:test'
import { cbcDecryptZeroIv, ctrCrypt } from './mega-crypto'
import { cbcDecryptClient, ctrDecryptClient } from './mega-decrypt'

const globals = globalThis as { Worker?: typeof Worker }
const originalWorker = globals.Worker
afterEach(() => { globals.Worker = originalWorker })

// Every decrypt spawns its own worker and falls back to the in-thread
// implementation whenever that worker cannot run — the native shells host
// the page on a custom scheme, where a dedicated worker's script load
// never reaches the WKURLSchemeHandler and always fails.

describe('MEGA decrypt worker lifecycle', () => {
  test('a working worker answers the decrypt', async () => {
    globals.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror = null
      postMessage(message: { id: number; bytes: Uint8Array }) {
        this.onmessage?.({ data: { id: message.id, plain: message.bytes } } as MessageEvent)
      }
      terminate() {}
    } as unknown as typeof Worker

    const bytes = new Uint8Array(64).map((_, i) => i * 7 + 3)
    expect(await ctrDecryptClient(new Uint8Array(16), new Uint8Array(8), bytes, 0)).toEqual(bytes)
  })

  test('a worker that fails to load falls back to in-thread decryption', async () => {
    let instance: { terminated: boolean } | null = null
    globals.Worker = class {
      terminated = false
      onmessage = null
      onerror: ((event: ErrorEvent) => void) | null = null
      constructor() { instance = this }
      postMessage() { this.onerror?.(new ErrorEvent('error', { message: 'script load failed' })) }
      terminate() { this.terminated = true }
    } as unknown as typeof Worker

    const key = new Uint8Array(16).map((_, i) => i + 1)
    const bytes = new Uint8Array(64).map((_, i) => i * 7 + 3)
    expect(await cbcDecryptClient(key, bytes)).toEqual(cbcDecryptZeroIv(key, bytes))
    expect(instance!.terminated).toBe(true)
  })

  test('a worker that cannot even be constructed falls back to in-thread decryption', async () => {
    globals.Worker = class {
      constructor() { throw new Error('custom scheme cannot host workers') }
    } as unknown as typeof Worker

    const bytes = new Uint8Array(64).map((_, i) => i * 7 + 3)
    const key = new Uint8Array(16).map((_, i) => i + 1)
    const nonce = new Uint8Array(8).map((_, i) => i + 9)
    expect(await ctrDecryptClient(key, nonce, bytes, 0)).toEqual(ctrCrypt(key, nonce, bytes, 0))
  })

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
