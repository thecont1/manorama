/** Serialises Content Credential checks: one check in flight at a time,
 *  keyed by image id. The newest queued request wins — opening Info on
 *  another flagged photo supersedes a still-waiting request, while repeat
 *  opens of the same photo dedupe. Results land in a per-id map so a
 *  response can never surface against the wrong photograph. */

export type CredentialStatus = 'idle' | 'loading' | 'verified' | 'unavailable'

export type CredentialChecker = (imageId: string) => Promise<'verified' | 'unavailable'>

type Entry = { id: string; promise: Promise<'verified' | 'unavailable'>; resolve: (v: 'verified' | 'unavailable') => void }

export type CredentialQueue = {
  /** Queue a check for an image. Repeat calls for the in-flight id share
   *  the one request; a call for a different id while another waits
   *  supersedes the waiter (its promise still resolves, just skipped). */
  enqueue(imageId: string): Promise<'verified' | 'unavailable'>
  /** Look up the last settled status for an image. */
  statusOf(imageId: string): CredentialStatus
  /** Forget everything — unmount/test teardown. */
  reset(): void
}

export const createCredentialQueue = (check: CredentialChecker): CredentialQueue => {
  const status = new Map<string, CredentialStatus>()
  let current: Entry | null = null
  let queued: Entry | null = null

  const make = (id: string): Entry => {
    const entry = { id } as Entry
    entry.promise = new Promise<'verified' | 'unavailable'>((resolve) => { entry.resolve = resolve })
    return entry
  }

  const runNext = () => {
    const entry = queued
    queued = null
    if (entry) void start(entry)
  }

  const start = async (entry: Entry) => {
    current = entry
    status.set(entry.id, 'loading')
    try {
      const result = await check(entry.id)
      status.set(entry.id, result)
      entry.resolve(result)
    } catch {
      // A reader that throws has already leaked past today; the queue
      // records the failure as unavailable so Info can offer a retry. Its
      // free() still runs — it lives in the caller's check implementation,
      // which the `finally` contract requires to never leak.
      status.set(entry.id, 'unavailable')
      entry.resolve('unavailable')
    } finally {
      current = null
      runNext()
    }
  }

  return {
    enqueue(imageId) {
      // Same in-flight id dedupes — share the request, never queue a
      // second check for the same photo.
      if (current?.id === imageId) return current.promise
      const entry = make(imageId)
      if (current) {
        // The newest request wins: a queued-but-unstarted check is
        // replaced outright rather than run stale work.
        queued?.resolve(status.get(queued.id) === 'verified' ? 'verified' : 'unavailable')
        queued = entry
      } else {
        void start(entry)
      }
      return entry.promise
    },
    statusOf(imageId) {
      return status.get(imageId) ?? 'idle'
    },
    reset() {
      status.clear()
      queued = null
      current = null
    },
  }
}
