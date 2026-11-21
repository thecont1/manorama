import { useEffect, useRef, useState } from 'hono/jsx'
import type { JSX } from 'hono/jsx'
import { enqueueHeicObjectUrl, isHeicFilename } from '../../lib/heic'
import type { MediaReference } from '../../../packages/core/encrypted-source'
import { acquireEncryptedDisplay } from '../../lib/encrypted-display'
import type { EncryptedMediaResolver } from '../../lib/encrypted-resolver'

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
  /** Keyless encrypted refs used by owner rails. Never a server fallback. */
  media?: MediaReference
  previewMedia?: MediaReference
  /** The gallery's own bounded resolver — vault leases resolve through it;
   *  without one the galleryId key-store session path runs instead. */
  encryptedResolver?: EncryptedMediaResolver | null
  galleryId?: string
  /** Manifest filename; the .heic/.heif suffix selects the decode path. */
  filename?: string | null
}

export function HeicImg({ src, preview, media, previewMedia, encryptedResolver = null, galleryId, filename, onError, ...rest }: Props) {
  const hasPreview = Boolean(preview || previewMedia)
  // A `preview` string can carry a placeholder-grade stand-in (MEGA writes an
  // SVG data URL into `placeholder`) — never a real rendition when `media`
  // is present, since encrypted manifests keep rendition URLs empty by
  // design. A HEIC original must therefore always decode unless a genuine
  // `previewMedia` rendition exists; unencrypted items keep the old rule.
  // A vault lease points every rendition at the one stored entry, so a
  // previewMedia identical to media is not a rendition at all — the vault
  // holds originals, and an HEIC still must decode.
  const hasRendition = previewMedia !== undefined && previewMedia !== media
  const needsDecode = isHeicFilename(filename) && (media ? !hasRendition : !hasPreview)
  const [decoded, setDecoded] = useState<string | null>(null)
  // A provider that cannot produce a rendition (Dropbox answering
  // unsupported_file for a whole shared folder is the observed case) must
  // not strand the cell: the original stands in, browser-scaled. `src`
  // itself failing still reaches the caller's retry through onError — and
  // a video's `src` is never an <img> candidate, so posters keep their
  // blank-retry path.
  const [previewFailed, setPreviewFailed] = useState(false)
  const canFallBack = Boolean(src && !/\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(filename ?? ''))
  const [encrypted, setEncrypted] = useState<{ url: string; preview: boolean } | null>(null)
  const hostRef = useRef<HTMLImageElement | null>(null)
  const encryptedRelease = useRef<(() => void) | null>(null)
  const encryptedRef = hasPreview && previewMedia ? previewMedia : media

  // The acquire itself is bounded to the visible window (with a preload
  // margin): a strip of hundreds must not pin every ref in the resolver's
  // working set at once. Leaving the window releases so a later gallery
  // can use the bytes.
  const [inView, setInView] = useState(false)
  useEffect(() => {
    if (!encryptedRef) return
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) setInView(entry.isIntersecting)
    }, { rootMargin: '400px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [encryptedRef])

  useEffect(() => {
    if (!encryptedRef || encryptedRef.kind !== 'encrypted' || !inView) return
    if (!encryptedResolver && !galleryId) return
    let cancelled = false
    const previewRequest = encryptedRef === previewMedia
    const reference = encryptedRef
    const acquire = encryptedResolver
      ? () => encryptedResolver.acquire(reference, previewRequest)
          .then((url) => ({ url, release: () => encryptedResolver.release(reference, previewRequest) }))
      : () => acquireEncryptedDisplay(galleryId!, reference, previewRequest)
    void acquire().then(({ url, release }) => {
      if (cancelled) { release(); return }
      encryptedRelease.current = release
      setEncrypted({ url, preview: previewRequest })
    }).catch(() => {
      // A keyless rail keeps its dimensions and stays blank. It must never
      // fall back to a legacy keyed URL or server-side decryptor.
    })
    return () => {
      cancelled = true
      encryptedRelease.current?.()
      encryptedRelease.current = null
      // The pin is gone: fall back to the placeholder rather than keep a
      // revoked URL painted on screen.
      setEncrypted(null)
    }
  }, [encryptedRef, galleryId, encryptedResolver, inView])

  const source = encryptedRef && !encrypted ? '' : encrypted?.url ?? src
  useEffect(() => {
    if (!needsDecode || !source) return
    let cancelled = false
    let retried = false
    const settle = () => {
      // The multi-MB decrypted original is consumed or unreachable — holding
      // its ref until unmount lets a rail of decode-path cells fill the
      // resolver's bounded working set, after which acquires throw and the
      // cells stay blank. The 512px JPEG survives independently in `decoded`.
      encryptedRelease.current?.()
      encryptedRelease.current = null
    }
    const decode = () => {
      void enqueueHeicObjectUrl(source, 512).then((url) => {
        if (cancelled) return
        if (url) { settle(); setDecoded(url); return }
        // Null means the fetch itself failed — a transient proxy 5xx must
        // not freeze a broken <img> on the undecodable bytes, so retry
        // once before handing the browser the URL (Safari renders HEIC
        // natively; elsewhere the item's own onError retry answers).
        if (!retried) { retried = true; window.setTimeout(decode, 2000); return }
        settle()
        if (!media) setDecoded(src)
      })
    }
    const el = hostRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      decode()
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      decode()
    }, { rootMargin: '400px' })
    observer.observe(el)
    return () => { cancelled = true; observer.disconnect() }
  }, [needsDecode, source, media])

  // The retained blob is small (downscaled JPEG) but still owned by us —
  // revoke on replacement or unmount.
  useEffect(() => () => { if (decoded) URL.revokeObjectURL(decoded) }, [decoded])

  return <img ref={hostRef} src={decoded ?? (needsDecode ? undefined : encrypted?.url ?? (previewFailed ? src : (preview ?? src)))} onError={(event: Event) => {
    if (!previewFailed && preview && canFallBack) { setPreviewFailed(true); return }
    onError?.(event)
  }} {...rest} />
}
