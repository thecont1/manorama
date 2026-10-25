/**
 * Per-scan subrequest budget and bounded fan-out. A Workers invocation
 * may make ~1000 subrequests, and an album scan spends them on listing
 * pages, the title lookup and one or two provider calls per entry — so
 * an uncapped scan dies on the platform ceiling rather than the gallery
 * cap. One budget object per scan.
 */

// The paid-plan ceiling is 1000; the headroom covers the D1 writes and
// anything else the request does.
export const SCAN_SUBREQUEST_BUDGET = 950
// Provider probes run a few at a time — the same shape the MEGA and local
// scanners already use.
export const PROBE_CONCURRENCY = 8

export class ScanBudgetExhausted extends Error {
  constructor() {
    super('Scan subrequest budget exhausted')
    this.name = 'ScanBudgetExhausted'
  }
}

export const createScanBudget = (limit = SCAN_SUBREQUEST_BUDGET) => {
  const budget = {
    remaining: limit,
    fetch(fetchImpl: typeof fetch): typeof fetch {
      return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (budget.remaining <= 0) throw new ScanBudgetExhausted()
        budget.remaining -= 1
        return fetchImpl(input, init)
      }) as typeof fetch
    },
  }
  return budget
}

/** Worker-pool map: at most `limit` items in flight, results keep input
 *  order. */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}
