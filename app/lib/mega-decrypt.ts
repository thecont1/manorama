import { cbcDecryptZeroIv, ctrCrypt, metaMac } from './mega-crypto'

type WorkerResult = { id: number; plain?: Uint8Array; mac?: Uint8Array; error?: string }

/** One bulk operation per Worker keeps cancellation and buffer ownership
 * simple. Abort terminates the worker even after the fetch has completed.
 * Non-browser native/test runtimes use the same pure implementation. */
const run = <T>(message: Record<string, unknown>, map: (result: WorkerResult) => T | undefined, fallback: () => T, signal?: AbortSignal): Promise<T> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  if (typeof Worker === 'undefined') return Promise.resolve(fallback())
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL('./mega-crypto.worker.ts', import.meta.url), { type: 'module' })
    const id = 1
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      cleanup()
      if (event.data.error) reject(new Error(event.data.error))
      else {
        const value = map(event.data)
        if (value !== undefined) resolve(value)
        else reject(new Error('Decrypt worker returned no result'))
      }
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Decrypt worker failed'))
    }
    worker.postMessage({ ...message, id })
  })
}

export const ctrDecryptClient = (key: Uint8Array, nonce: Uint8Array, bytes: Uint8Array, offset = 0, signal?: AbortSignal): Promise<Uint8Array> =>
  run({ kind: 'ctr', key, nonce, bytes, offset }, (r) => r.plain, () => ctrCrypt(key, nonce, bytes, offset), signal)

/** Decrypt a whole file and return its computed meta-MAC in the same
 * pass — verification is only meaningful over the complete plaintext. */
export const ctrDecryptMetaMacClient = (key: Uint8Array, nonce: Uint8Array, bytes: Uint8Array, signal?: AbortSignal): Promise<{ plain: Uint8Array; mac: Uint8Array }> =>
  run(
    { kind: 'ctrmac', key, nonce, bytes },
    (r) => (r.plain && r.mac ? { plain: r.plain, mac: r.mac } : undefined),
    () => {
      const plain = ctrCrypt(key, nonce, bytes)
      return { plain, mac: metaMac(key, nonce, plain) }
    },
    signal,
  )

export const cbcDecryptClient = (key: Uint8Array, bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> =>
  run({ kind: 'cbc', key, bytes }, (r) => r.plain, () => cbcDecryptZeroIv(key, bytes), signal)
