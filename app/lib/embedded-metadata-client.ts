import type { RangeReader } from '../../packages/core/embedded-metadata'

/**
 * A RangeReader over HTTP Range requests. Servers that honour Range answer
 * 206 and the body is exactly the window; servers that ignore it answer
 * 200 with the whole file, so the stream is consumed only up to
 * `start + length` bytes and then cancelled — the caller never downloads
 * more of the source than the metadata window needs.
 */
export const fetchRangeReader = (url: string): RangeReader => async (start, length) => {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` },
  })
  if (!response.ok) throw new Error(`metadata range request failed: ${response.status}`)
  if (response.status === 206) return new Uint8Array(await response.arrayBuffer())

  const body = response.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const out = new Uint8Array(length)
  let filled = 0
  let skipped = 0
  try {
    while (filled < length) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      let bytes = chunk
      // A 200 body starts at byte 0 — discard everything before `start`.
      if (skipped < start) {
        const drop = Math.min(bytes.length, start - skipped)
        skipped += drop
        if (drop === bytes.length) continue
        bytes = bytes.subarray(drop)
      }
      const take = Math.min(bytes.length, length - filled)
      out.set(bytes.subarray(0, take), filled)
      filled += take
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out.subarray(0, filled)
}
