/** Serialises Content Credential checks: one check in flight at a time,
 *  keyed by image id. The newest queued request wins — opening Info on
 *  another flagged photo supersedes a still-waiting request, while repeat
 *  opens of the same photo dedupe. Results land in a per-id map so a
 *  response can never surface against the wrong photograph. */

/** 'none' is a settled answer, not a failure: the check ran and the
 *  bytes carry no manifest. Only a thrown check lands on 'unavailable'. */
export type CredentialResult = 'verified' | 'unavailable' | 'none'

export type CredentialStatus = 'idle' | 'loading' | CredentialResult

export type CredentialChecker = (imageId: string) => Promise<CredentialResult>

type Entry = { id: string; promise: Promise<CredentialResult>; resolve: (v: CredentialResult) => void }

export type CredentialQueue = {
  /** Queue a check for an image. Repeat calls for the in-flight id share
   *  the one request; a call for a different id while another waits
   *  supersedes the waiter (its promise still resolves, just skipped). */
  enqueue(imageId: string): Promise<CredentialResult>
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
    entry.promise = new Promise<CredentialResult>((resolve) => { entry.resolve = resolve })
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
        // replaced outright rather than run stale work. Its promise still
        // resolves — with the image's settled verdict when one exists, so
        // a superseded re-check never downgrades a known answer.
        const settled = queued ? status.get(queued.id) : undefined
        queued?.resolve(settled === 'verified' || settled === 'none' ? settled : 'unavailable')
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
