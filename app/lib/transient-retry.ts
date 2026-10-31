/** Retry-After is delay-seconds or an HTTP-date; both land as ms from now.
 *  Missing, unparsable, or already-past headers mean the caller falls back
 *  to jitter — a date in the past asks for no explicit wait at all. */
export const retryAfterMs = (headers: Headers) => {
  const value = headers.get('Retry-After')?.trim()
  if (!value) return null
  if (/^\d+$/.test(value)) return parseInt(value, 10) * 1000
  const at = Date.parse(value)
  if (Number.isNaN(at) || at <= Date.now()) return null
  return at - Date.now()
}

/** A single retry may wait this long before the limiter's answer is the
 *  honest one — a burst asking for minutes of backoff is surfaced, not held. */
export const MAX_RETRY_WAIT_MS = 30_000

/** Dimension and derivative probes retry only a fast limiter answer — a
 *  real wait request inside a probe chains across hundreds of entries and
 *  outlives the scan's own deadline, so a bigger ask surfaces to the
 *  fallback chain instead. */
export const PROBE_RETRY_WAIT_MS = 2_000
