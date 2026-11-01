import { useEffect, useRef, useState } from 'hono/jsx'
import type { JSX } from 'hono/jsx'
import { enqueueHeicObjectUrl, isHeicFilename } from '../../lib/heic'

/** An <img> that renders HEIC originals. Browsers can't decode HEIC, so a
 *  filename that ends .heic/.heif with no renderable `preview` rendition
 *  starts as an empty frame and decodes lazily — IntersectionObserver, one
 *  at a time, downscaled — through the same libheif path the stage uses.
 *  Anything with a preview or a non-HEIC name renders exactly like <img>. */
type Props = JSX.HTMLAttributes & {
  /** The item's original bytes — possibly a HEIC the browser can't read. */
  src: string
  /** A renderable rendition (provider preview/thumbnail). Wins when present —
   *  no decode runs. */
  preview?: string | null
  /** Manifest filename; the .heic/.heif suffix selects the decode path. */
  filename?: string | null
}

export function HeicImg({ src, preview, filename, ...rest }: Props) {
  const needsDecode = !preview && isHeicFilename(filename)
  const [decoded, setDecoded] = useState<string | null>(null)
  const hostRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    // A new src (or a preview arriving) must not keep last decode's blob.
    setDecoded(null)
    if (!needsDecode) return
    let cancelled = false
    let retried = false
    let retryTimer: number | undefined
    const decode = () => {
      void enqueueHeicObjectUrl(src, 512).then((url) => {
        if (cancelled) return
        if (url) { setDecoded(url); return }
        // Null means the fetch itself failed — a transient proxy 5xx must
        // not freeze a broken <img> on the undecodable bytes, so retry
        // once before handing the browser the URL (Safari renders HEIC
        // natively; elsewhere the item's own onError retry answers).
        if (!retried) { retried = true; retryTimer = window.setTimeout(decode, 2000); return }
        setDecoded(src)
      })
    }
    const cleanup = () => {
      cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      decode()
      return cleanup
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      decode()
    }, { rootMargin: '400px' })
    observer.observe(el)
    return () => { cleanup(); observer.disconnect() }
  }, [needsDecode, src])

  // The retained blob is small (downscaled JPEG) but still owned by us —
  // revoke on replacement or unmount.
  useEffect(() => () => { if (decoded) URL.revokeObjectURL(decoded) }, [decoded])

  return <img ref={hostRef} src={decoded ?? (needsDecode ? undefined : preview ?? src)} {...rest} />
}
