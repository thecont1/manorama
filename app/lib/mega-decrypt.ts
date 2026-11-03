import { cbcDecryptZeroIv, ctrCrypt } from './mega-crypto'

type WorkerResult = { id: number; plain?: Uint8Array; error?: string }

/** One bulk operation per Worker keeps cancellation and buffer ownership
 * simple. Abort terminates the worker even after the fetch has completed.
 * Non-browser native/test runtimes use the same pure implementation. */
const run = (message: Record<string, unknown>, fallback: () => Uint8Array, signal?: AbortSignal): Promise<Uint8Array> => {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  if (typeof Worker === 'undefined') return Promise.resolve(fallback())
  return new Promise<Uint8Array>((resolve, reject) => {
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
      else if (event.data.plain) resolve(event.data.plain)
      else reject(new Error('Decrypt worker returned no bytes'))
    }
    worker.onerror = (event) => {
      cleanup()
      reject(new Error(event.message || 'Decrypt worker failed'))
    }
    worker.postMessage({ ...message, id })
  })
}

export const ctrDecryptClient = (key: Uint8Array, nonce: Uint8Array, bytes: Uint8Array, offset = 0, signal?: AbortSignal): Promise<Uint8Array> =>
  run({ kind: 'ctr', key, nonce, bytes, offset }, () => ctrCrypt(key, nonce, bytes, offset), signal)

export const cbcDecryptClient = (key: Uint8Array, bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> =>
  run({ kind: 'cbc', key, bytes }, () => cbcDecryptZeroIv(key, bytes), signal)
