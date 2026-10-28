import type { OfflineObjectUrlProvider } from './offline-gallery'

export const LIBRARY_MEDIA_MAX_LIVE_URLS = 24
export const LIBRARY_MEDIA_MAX_BLOB_BYTES = 64 * 1024 * 1024
export const LIBRARY_MEDIA_MAX_CONCURRENT = 4

/** What a visible rail cell needs to resolve its media. `galleryId`+`entryId`
 *  address the vault copy when one exists; `remote` is the provider
 *  preview/poster the cell falls back to while saved bytes are absent. */
export type LibraryMediaCell = {
  galleryId: string
  entryId: string
  mimeType: string
  remote?: string
}

export type LibraryMediaLease = {
  /** Undefined when neither saved bytes nor a remote preview exists — the
   *  cell keeps its aspect placeholder. */
  src: string | undefined
  kind: 'vault' | 'remote' | 'none'
  /** Releases this cell's pin on the URL. Safe to call twice. */
  release(): void
}

/** What the shared job settled before each acquirer pins its own lease. */
type CellOutcome =
  | { kind: 'vault' }
  | { kind: 'remote' | 'none'; src: string | undefined }

type LiveEntry = {
  galleryId: string
  url: string
  bytes: number
  pins: number
  oversized: boolean
}

/** The still every non-playing rail surface shows: the provider's own first
 *  variant — a poster for video, where `src` would be the film itself. This is
 *  the same rule the Library cover and the web dashboard row already use. */
export const previewSrcFor = (item: {
  src: string
  variants?: readonly { src: string }[]
  poster?: { src: string }
}): string => item.variants?.[0]?.src ?? item.poster?.src ?? item.src

/** Provider word for a gallery's source link, matched on host alone — the
 *  scanner graph stays server-side, so this never imports `detectSource`. */
export const sourceLabelFor = (sourceUrl: string | null | undefined): string => {
  if (!sourceUrl) return 'gallery'
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return 'local folder'
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'dropbox.com') return 'Dropbox'
  if (host === 'drive.google.com') return 'Google Drive'
  if (host === 'icloud.com' || host === 'share.icloud.com') return 'iCloud'
  if (host === 'mega.nz' || host === 'mega.co.nz') return 'MEGA'
  return 'gallery'
}

export const mimeTypeForItem = (item: {
  filename: string
  variants?: readonly { format?: string }[]
}): string => {
  const format = item.variants?.[0]?.format?.toLowerCase().replace(/^image\//, '') ?? item.filename.split('.').pop()?.toLowerCase()
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
  if (format === 'png' || format === 'webp' || format === 'avif' || format === 'gif') return `image/${format}`
  if (format === 'heic' || format === 'heif') return `image/${format}`
  return 'application/octet-stream'
}

/**
 * Bounded media resolution for Library rails. Only cells that acquire start
 * work, so offscreen rails never touch the network or the vault. One shared
 * queue admits at most `maxConcurrent` reads at a time; live object URLs are
 * capped at `maxLiveUrls` and decrypted blob bytes at `maxBlobBytes`, evicting
 * unpinned entries LRU-first. Held leases pin their URL — when a new read
 * cannot fit because everything displayed is pinned, the job parks until a
 * release frees headroom rather than revoking a thumb on screen. A single
 * source larger than the whole budget is shown alone and revoked the moment
 * its cell lets go.
 *
 * Saved bytes always win over a remote preview; a read miss falls back to the
 * remote URL without consuming a URL or byte slot — the <img> owns that fetch.
 */
export class LibraryMediaLoader {
  private readonly read: (galleryId: string, entryId: string) => Promise<Uint8Array | undefined>
  private readonly objectUrls: OfflineObjectUrlProvider
  private readonly maxLiveUrls: number
  private readonly maxBlobBytes: number
  private readonly maxConcurrent: number
  private readonly live = new Map<string, LiveEntry>()
  private readonly inflight = new Map<string, Promise<CellOutcome | undefined>>()
  private readonly waiting: Array<() => void> = []
  private readonly budgetWaiters: Array<() => void> = []
  private readonly generations = new Map<string, number>()
  private liveBytes = 0
  private active = 0
  private released = false

  constructor(options: {
    read: (galleryId: string, entryId: string) => Promise<Uint8Array | undefined>
    objectUrls: OfflineObjectUrlProvider
    maxLiveUrls?: number
    maxBlobBytes?: number
    maxConcurrent?: number
  }) {
    this.read = options.read
    this.objectUrls = options.objectUrls
    this.maxLiveUrls = options.maxLiveUrls ?? LIBRARY_MEDIA_MAX_LIVE_URLS
    this.maxBlobBytes = options.maxBlobBytes ?? LIBRARY_MEDIA_MAX_BLOB_BYTES
    this.maxConcurrent = options.maxConcurrent ?? LIBRARY_MEDIA_MAX_CONCURRENT
  }

  /** Resolve media for one visible cell. Concurrent acquires of the same cell
   *  share one job and each receive their own lease. */
  acquire(cell: LibraryMediaCell): Promise<LibraryMediaLease | undefined> {
    if (this.released) return Promise.resolve(undefined)
    const key = keyOf(cell)
    const hit = this.live.get(key)
    if (hit) {
      hit.pins += 1
      this.live.delete(key)
      this.live.set(key, hit)
      return Promise.resolve(this.leaseFor(key, hit))
    }
    let task = this.inflight.get(key)
    if (!task) {
      const generation = this.generations.get(cell.galleryId) ?? 0
      task = this.enqueue(() => this.resolve(cell, key, generation))
      this.inflight.set(key, task)
      task.finally(() => this.inflight.delete(key))
    }
    return task.then((outcome) => {
      if (!outcome || this.released) return undefined
      // Each acquirer pins for itself — dedupe shares the read, not the lease.
      if (outcome.kind !== 'vault') return { src: outcome.src, kind: outcome.kind, release: noopRelease }
      const entry = this.live.get(key)
      // A miss here means the fresh entry was evicted in the gap before the
      // claim landed; the vault still holds the bytes, so the next acquire
      // simply reads again.
      if (!entry) return undefined
      entry.pins += 1
      return this.leaseFor(key, entry)
    })
  }

  /** Every live URL for the gallery is revoked and in-flight or parked work
   *  for it dies at its next checkpoint — purge, gallery revision, and
   *  refresh all invalidate this way. */
  invalidate(galleryId: string): void {
    this.generations.set(galleryId, (this.generations.get(galleryId) ?? 0) + 1)
    for (const [key, entry] of [...this.live.entries()]) {
      if (entry.galleryId !== galleryId) continue
      this.evict(key, entry)
    }
    this.wakeBudgetWaiters()
  }

  /** Teardown for unmount, sign-out and account change: queued work stops,
   *  late reads are revoked on arrival, parked jobs settle as misses. */
  release(): void {
    this.released = true
    for (const [key, entry] of [...this.live.entries()]) this.evict(key, entry)
    this.wakeBudgetWaiters()
  }

  private async resolve(cell: LibraryMediaCell, key: string, generation: number): Promise<CellOutcome | undefined> {
    if (this.released || this.stale(cell, generation)) return undefined
    const url = await this.vaultUrl(cell, key, generation)
    if (url === undefined) {
      if (this.released || this.stale(cell, generation)) return undefined
      if (cell.remote !== undefined) return { kind: 'remote', src: cell.remote }
      return { kind: 'none', src: undefined }
    }
    return { kind: 'vault' }
  }

  private async vaultUrl(cell: LibraryMediaCell, key: string, generation: number): Promise<string | undefined> {
    for (;;) {
      // A vault read error is a miss, not a failure — the cell falls back to
      // its remote preview rather than stranding every acquirer on the job.
      const bytes = await this.read(cell.galleryId, cell.entryId).catch(() => undefined)
      if (this.released || this.stale(cell, generation)) { bytes?.fill(0); return undefined }
      if (!bytes) return undefined
      // A frame bigger than the entire budget is still shown — alone. It is
      // marked so release revokes it instead of pooling it for later.
      const oversized = bytes.length > this.maxBlobBytes
      if (oversized) this.evictAllUnpinned()
      if (oversized || this.evictUntilFits(bytes.length)) {
        const url = this.objectUrls.create(bytes, cell.mimeType)
        const entry: LiveEntry = { galleryId: cell.galleryId, url, bytes: bytes.length, pins: 0, oversized }
        bytes.fill(0)
        this.liveBytes += entry.bytes
        this.live.set(key, entry)
        return url
      }
      bytes.fill(0)
      // Everything live is pinned on screen; park until a release makes an
      // entry evictable rather than revoking a thumb a visitor can see.
      await new Promise<void>((resolve) => this.budgetWaiters.push(resolve))
      if (this.released || this.stale(cell, generation)) return undefined
    }
  }

  private evictAllUnpinned(): void {
    for (const [key, entry] of [...this.live.entries()]) {
      if (entry.pins === 0) this.evict(key, entry)
    }
  }

  private evictUntilFits(incomingBytes: number): boolean {
    while (this.live.size >= this.maxLiveUrls || this.liveBytes + incomingBytes > this.maxBlobBytes) {
      const evictable = [...this.live.entries()].find(([, entry]) => entry.pins === 0)
      if (!evictable) return false
      this.evict(evictable[0], evictable[1])
    }
    return true
  }

  private evict(key: string, entry: LiveEntry): void {
    if (!this.live.delete(key)) return
    this.liveBytes -= entry.bytes
    this.objectUrls.revoke(entry.url)
  }

  private leaseFor(key: string, entry: LiveEntry): LibraryMediaLease {
    let released = false
    return {
      src: entry.url,
      kind: 'vault',
      release: () => {
        if (released) return
        released = true
        const current = this.live.get(key)
        if (current !== entry) return
        current.pins = Math.max(0, current.pins - 1)
        // An oversized source cannot pool — leave and it is gone, per the
        // budget contract. Ordinary entries stay live as an LRU warm pool.
        if (current.pins === 0 && current.oversized) this.evict(key, current)
        this.wakeBudgetWaiters()
      },
    }
  }

  private stale(cell: LibraryMediaCell, generation: number): boolean {
    return (this.generations.get(cell.galleryId) ?? 0) !== generation
  }

  private wakeBudgetWaiters(): void {
    const waiters = this.budgetWaiters.splice(0)
    for (const wake of waiters) wake()
  }

  private async enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await job()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

// NUL cannot appear in vault or provider ids, so it separates the pair
// without ambiguity — ("a","bc") and ("ab","c") must not share a cell.
const CELL_KEY_SEPARATOR = '\u0000'
const keyOf = (cell: LibraryMediaCell): string => `${cell.galleryId}${CELL_KEY_SEPARATOR}${cell.entryId}`
const noopRelease = (): void => {}
