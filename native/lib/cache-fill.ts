/** A single vault write inside an offline cache fill, described for consumers
 *  that want to react as entries land — Library rail cells switch from a
 *  provider preview to saved bytes the moment their frame exists. */
export type CacheFillItem = {
  id: string
  entryId: string
  mimeType: string
  /** Position within the gallery's still sequence, matching manifest order. */
  index: number
}

export type CacheFillEvent = {
  galleryId: string
  item: CacheFillItem
}

type CacheFillListener = (item: CacheFillItem) => void

/** In-memory, per-session: fills publish as they write, subscribers keyed by
 *  gallery see only their own rail's arrivals. Nothing here reaches the vault
 *  or the network — reset on sign-out or account change so one identity's
 *  arrivals can never be observed by the next. */
export class CacheFillRegistry {
  private readonly listeners = new Map<string, Set<CacheFillListener>>()

  publish(event: CacheFillEvent): void {
    const listeners = this.listeners.get(event.galleryId)
    if (!listeners) return
    for (const listener of [...listeners]) listener(event.item)
  }

  subscribe(galleryId: string, listener: CacheFillListener): () => void {
    let listeners = this.listeners.get(galleryId)
    if (!listeners) this.listeners.set(galleryId, (listeners = new Set()))
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(galleryId)
    }
  }

  reset(): void {
    this.listeners.clear()
  }
}

export const cacheFillRegistry = new CacheFillRegistry()
