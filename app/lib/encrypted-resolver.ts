import type { MediaReference } from '../../packages/core/encrypted-source'
import type { GalleryImage } from './imagesource'

export type MaterializedMedia = { bytes: Uint8Array; mimeType: string }
export type EncryptedClientSession = {
  provider: 'mega' | 'ente'
  sourceUrl: string
  title: string
  images: GalleryImage[]
  truncated?: number
  materialize(reference: MediaReference, preview: boolean, signal?: AbortSignal): Promise<MaterializedMedia>
  dispose(): void
}

type Entry = {
  key: string
  reference: MediaReference
  preview: boolean
  refs: number
  bytes: number
  url?: string
  promise: Promise<string>
  controller: AbortController
  lastUsed: number
}

const limiter = (capacity: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= capacity) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try { return await run() }
    finally {
      active -= 1
      const next = waiting.shift()
      if (next) next()
    }
  }
}

const referenceKey = (reference: MediaReference, preview: boolean): string =>
  `${preview ? 'preview' : 'original'}:${JSON.stringify(reference)}`

/** Bounded plaintext working set shared by stage, rail, and native WebViews.
 * Object URLs are reference-counted; plaintext never touches persistence. */
export class EncryptedMediaResolver {
  private readonly entries = new Map<string, Entry>()
  private readonly thumbnails = limiter(4)
  private readonly originals = limiter(2)
  private bytes = 0
  private disposed = false

  constructor(private readonly session: EncryptedClientSession, private readonly options: { maxBytes?: number } = {}) {}

  private get maxBytes() { return this.options.maxBytes ?? 64 * 1024 * 1024 }

  private evict(): void {
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.refs === 0 && entry.url)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while (this.bytes > this.maxBytes && candidates.length) {
      const entry = candidates.shift()!
      URL.revokeObjectURL(entry.url!)
      this.bytes -= entry.bytes
      this.entries.delete(entry.key)
    }
  }

  acquire(reference: MediaReference, preview = false, signal?: AbortSignal): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('Media resolver is closed'))
    if (reference.kind === 'http') return Promise.resolve(reference.url)
    const key = referenceKey(reference, preview)
    let entry = this.entries.get(key)
    if (!entry) {
      const controller = new AbortController()
      entry = {
        key, reference, preview, refs: 0, bytes: 0, controller, lastUsed: Date.now(),
        promise: Promise.resolve(''),
      }
      entry.promise = (preview ? this.thumbnails : this.originals)(async () => {
        const materialized = await this.session.materialize(reference, preview, controller.signal)
        if (this.disposed) {
          materialized.bytes.fill(0)
          throw new Error('Media resolver is closed')
        }
        entry!.bytes = materialized.bytes.byteLength
        this.bytes += entry!.bytes
        // Blob owns a snapshot; wipe the working plaintext immediately.
        const snapshot = materialized.bytes.slice()
        materialized.bytes.fill(0)
        entry!.url = URL.createObjectURL(new Blob([snapshot.buffer], { type: materialized.mimeType }))
        entry!.lastUsed = Date.now()
        this.evict()
        if (this.bytes > this.maxBytes) {
          URL.revokeObjectURL(entry!.url!)
          this.bytes -= entry!.bytes
          this.entries.delete(key)
          throw new Error('Encrypted media working set is full; release an image and retry')
        }
        return entry!.url!
      }).catch((error) => {
        this.entries.delete(key)
        throw error
      })
      this.entries.set(key, entry)
    }
    entry.refs += 1
    entry.lastUsed = Date.now()
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      this.release(reference, preview)
    }
    const aborted = () => {
      release()
      if (entry!.refs === 0 && !entry!.url) entry!.controller.abort()
    }
    if (signal?.aborted) {
      aborted()
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    let onAbort: (() => void) | null = null
    const cancelled = signal
      ? new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            aborted()
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          }
        })
      : null
    if (onAbort) signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => { if (onAbort) signal?.removeEventListener('abort', onAbort) }
    return (cancelled ? Promise.race([entry.promise, cancelled]) : entry.promise).then(
      (url) => { cleanup(); return url },
      (error) => { cleanup(); release(); throw error },
    )
  }

  release(reference: MediaReference, preview = false): void {
    if (reference.kind === 'http') return
    const entry = this.entries.get(referenceKey(reference, preview))
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    entry.lastUsed = Date.now()
    this.evict()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      entry.controller.abort()
      if (entry.url) URL.revokeObjectURL(entry.url)
    }
    this.entries.clear()
    this.bytes = 0
    this.session.dispose()
  }
}
