/** Browser-side HEIC/HEIF rendering. `<img>` cannot decode HEIC, so the
 *  viewer and the admin surfaces share this libheif WASM path: fetch the
 *  original bytes, sniff the ftyp box, decode RGBA and re-encode as JPEG
 *  on a canvas. Platform code lives here rather than packages/core
 *  because it needs fetch, canvas and dynamic import. */

export const isHeicFilename = (name: string | null | undefined) => /\.hei[cf]$/i.test(name ?? '')

/** A decode costs a fetch plus a multi-hundred-MB transient, and the same
 *  image appears in several surfaces — stage frame, picker thumb, edit
 *  cell — so results are shared process-wide. Bounded LRU: blob URLs are
 *  revoked on eviction. Failures are never cached — a retry must be able
 *  to re-fetch. */
const HEIC_CACHE_LIMIT = 48
const heicUrlCache = new Map<string, string>()
const heicInflight = new Map<string, Promise<string | null>>()

/** Test seam: a stubbed createObjectURL mints fake blob URLs that must
 *  not outlive the test that minted them. */
export const clearHeicUrlCache = () => { heicUrlCache.clear() }

const heicObjectUrlUncached = async (src: string, maxDim?: number): Promise<string | null> => {
  const response = await fetch(src)
  if (!response.ok) return null
  const blob = await response.blob()
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  // A 'ftyp' box means real HEIC; anything else (JPEG, WebP) renders directly.
  const isHeicBlob = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
  if (!isHeicBlob) return URL.createObjectURL(blob)
  try {
    // heic-decode wraps libheif-js — a modern emscripten build with no
    // string eval, so it survives the page CSP the way heic2any's
    // `new Function` dynCall glue never could.
    const { default: decode } = await import('heic-decode')
    const { data, width, height } = await decode({ buffer: new Uint8Array(await blob.arrayBuffer()) })
    const scale = maxDim ? Math.min(1, maxDim / Math.max(width, height)) : 1
    const canvas = document.createElement('canvas')
    if (scale < 1) {
      // Draw the full-res pixels once and keep only the small canvas —
      // the decoded ImageData and staging canvas are transient.
      const staging = document.createElement('canvas')
      staging.width = width
      staging.height = height
      staging.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      canvas.getContext('2d')!.drawImage(staging, 0, 0, canvas.width, canvas.height)
    } else {
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    }
    const jpegBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!jpegBlob) throw new Error('canvas encode returned no blob')
    return URL.createObjectURL(jpegBlob)
  } catch {
    return URL.createObjectURL(blob)
  }
}

/** Resolves to a same-origin object URL for the image — the decoded JPEG
 *  blob, or the untouched source blob when it isn't really HEIC (older
 *  manifests point HEIC-named items at JPEG renditions) or libheif can't
 *  read it (10-bit, odd codecs; Safari may still render the bytes).
 *  Null means the fetch itself failed — the caller falls back to `src`.
 *  `maxDim` bounds the retained image: stage frames decode full-size,
 *  admin thumbs pass ~512 so a strip of them stays small. */
export const heicObjectUrl = (src: string, maxDim?: number): Promise<string | null> => {
  const key = `${src}::${maxDim ?? ''}`
  const hit = heicUrlCache.get(key)
  if (hit) {
    // Refresh recency so hot entries survive eviction.
    heicUrlCache.delete(key)
    heicUrlCache.set(key, hit)
    return Promise.resolve(hit)
  }
  const inflight = heicInflight.get(key)
  if (inflight) return inflight
  const run = heicObjectUrlUncached(src, maxDim)
  heicInflight.set(key, run)
  void run.then(
    (url) => {
      heicInflight.delete(key)
      if (!url) return
      heicUrlCache.set(key, url)
      if (heicUrlCache.size > HEIC_CACHE_LIMIT) {
        const oldest = heicUrlCache.keys().next().value
        if (oldest !== undefined) {
          const evicted = heicUrlCache.get(oldest)
          heicUrlCache.delete(oldest)
          if (evicted) URL.revokeObjectURL(evicted)
        }
      }
    },
    // A failed run clears its slot but is never cached — the next caller
    // re-fetches rather than inheriting a permanently rejected promise.
    () => { heicInflight.delete(key) },
  )
  return run
}

/** Thumbnails decode one at a time: each HEIC spends a multi-hundred-MB
 *  transient on its full-res RGBA before the downscale, and a rail of
 *  them in parallel would exhaust the tab. */
let heicQueue: Promise<unknown> = Promise.resolve()
export const enqueueHeicObjectUrl = (src: string, maxDim?: number): Promise<string | null> => {
  // Rejections translate to null too — a network-level fetch throw must
  // answer the same retry/fallback path as a !ok response.
  const run = heicQueue.then(() => heicObjectUrl(src, maxDim).catch(() => null))
  heicQueue = run.catch(() => undefined)
  return run
}
