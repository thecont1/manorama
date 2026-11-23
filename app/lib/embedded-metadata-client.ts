import type { RangeReader } from '../../packages/core/embedded-metadata'

/**
 * A RangeReader over HTTP Range requests. Servers that honour Range answer
 * 206 and the body is exactly the window; servers that ignore it answer
 * 200 with the whole file, so the stream is consumed only up to
 * `start + length` bytes and then cancelled — the caller never downloads
 * more of the source than the metadata window needs.
 */

/** The fallback's transfer ceiling: a Range-ignoring 200 drains from byte
 *  0, so the needed span must sit inside a modest prefix — matched to the
 *  4 MiB window the native shells' `read_file_range` command answers.
 *  Past it only a real 206 keeps the probe honest. */
export const RANGE_FALLBACK_PREFIX_BYTES = 4 * 1024 * 1024

/** `bytes S-E/T` (or `bytes S-E/*`) — the window a 206 claims to carry.
 *  Absent or unparseable is not an error: the header is only checked when
 *  it is legible. */
const contentRange = (header: string | null): { start: number; end: number } | null => {
  const match = header?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  return end >= start ? { start, end } : null
}

export const fetchRangeReader = (url: string): RangeReader => async (start, length) => {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` },
  })
  if (!response.ok) throw new Error(`metadata range request failed: ${response.status}`)
  if (response.status === 206) {
    // A 206 body is the requested window — but only a compliant server sends
    // exactly that. Stream it, cap at `length`, and when Content-Range is
    // visible require it to agree with what actually arrived.
    const declared = contentRange(response.headers.get('content-range'))
    if (declared && declared.start !== start) {
      await response.body?.cancel().catch(() => {})
      throw new Error('metadata range response names a different window')
    }
    const body = response.body
    if (!body) return new Uint8Array(0)
    const reader = body.getReader()
    const out = new Uint8Array(length)
    let filled = 0
    let overflow = false
    try {
      while (filled < length) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        const take = Math.min(chunk.length, length - filled)
        out.set(chunk.subarray(0, take), filled)
        filled += take
        if (take < chunk.length) { overflow = true; break }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (overflow) throw new Error('metadata range response exceeded the requested window')
    const bytes = out.subarray(0, filled)
    if (declared && declared.end - declared.start + 1 !== bytes.length) {
      throw new Error('metadata range body contradicts its Content-Range')
    }
    return bytes
  }
  if (start + length > RANGE_FALLBACK_PREFIX_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`metadata range request needs a 206 beyond the ${RANGE_FALLBACK_PREFIX_BYTES}-byte prefix`)
  }

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
