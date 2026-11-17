import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import {
  orderedSelection,
  togglePostSelection,
  POST_TO_X_FULL_NOTE,
  POST_TO_X_LIMIT_NOTE,
  POST_TO_X_MAX_MEDIA,
  type PostToXPhoto,
} from '../../native/lib/post-to-x'
import type { EncryptedClientSession } from '../../app/lib/encrypted-resolver'
import { pushOverlay } from '../../app/lib/overlay-stack'
import {
  exportPostToX,
  withEncryptedMaterialize,
  type PostExportReport,
  type PostPhotoReader,
  type PostShareBridge,
} from '../lib/post-to-x'
import '../../native/styles/global-view.css'
import '../../native/styles/post-to-x.css'

/**
 * "Post to X" — the photograph picker, opened from a gallery's own menu.
 *
 * The same picker the phone carries: the same contact matrix, the same
 * fixed-height cells, the same shocking pink on the photographs in hand.
 * What differs is the exit: the desktop has no share sheet, so the prepared
 * JPEGs go to the shell in one `share_post` call — the Mac puts them on
 * the pasteboard and opens the X composer, where a paste attaches them.
 */

type Props = {
  title: string
  /** The gallery's own address — the way back to the full set. Empty for a
   *  local gallery that has never been published. */
  galleryUrl: string
  /** The gallery's postable photographs, loaded once the picker mounts. */
  loadPhotos: () => Promise<PostToXPhoto[]>
  /** The original bytes for a photograph — a local file or a provider
   *  original, whichever the gallery carries. */
  read: PostPhotoReader
  /** The open decryption session for an encrypted source — previews and
   *  post bytes both come from it. Absent for cloud and local galleries. */
  session?: EncryptedClientSession | null
  /** The shell hand-off. Injected so tests never touch the bridge. */
  share: PostShareBridge
  onClose: () => void
  /** Told what happened, in the photographer's words. */
  onPosted: (note: string) => void
  /** Injected by the tests; the default prepares JPEGs and calls `share`. */
  exportPhotos?: (options: {
    photos: readonly PostToXPhoto[]
    caption: string
    title: string
    url: string
    read: PostPhotoReader
    share: PostShareBridge
  }) => Promise<PostExportReport>
}

/**
 * One cell of the picker matrix.
 *
 * A local or cloud photograph shows its own rendition. A photograph from
 * an encrypted source has no address at all — its preview is decrypted on
 * this device, lazily, as the cell nears the viewport.
 */
const PostCell = ({
  photo,
  index,
  total,
  selected,
  onPick,
  session,
  objectUrls,
}: {
  photo: PostToXPhoto
  index: number
  total: number
  selected: boolean
  onPick: (id: string) => void
  session?: EncryptedClientSession | null
  objectUrls: Set<string>
}) => {
  const [decryptedUrl, setDecryptedUrl] = useState<string | null>(null)
  const cellRef = useRef<HTMLButtonElement | null>(null)
  // Each cell decrypts at most once — viewport re-entry must not mint
  // another Blob URL. A failed attempt goes back to idle so a later
  // intersection may retry.
  const loadStateRef = useRef<'idle' | 'loading' | 'done'>('idle')
  const needsDecryption = Boolean(session) && (photo.encrypted || !photo.preview)

  useEffect(() => {
    if (!needsDecryption || !session || !photo.media) return
    let cancelled = false
    const materialize = () => {
      if (loadStateRef.current !== 'idle') return
      loadStateRef.current = 'loading'
      void session
        .materialize(photo.media!, true)
        .then((materialized) => {
          loadStateRef.current = 'done'
          if (cancelled) return
          const url = URL.createObjectURL(new Blob([materialized.bytes.slice().buffer], { type: materialized.mimeType }))
          objectUrls.add(url)
          setDecryptedUrl(url)
        })
        .catch(() => { loadStateRef.current = 'idle' })
    }
    const cell = cellRef.current
    if (typeof IntersectionObserver === 'undefined' || !cell) {
      materialize()
      return () => { cancelled = true }
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) materialize()
    }, { rootMargin: '120px' })
    observer.observe(cell)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [needsDecryption, session, photo, objectUrls])

  const src = photo.encrypted ? decryptedUrl ?? undefined : photo.preview || decryptedUrl || undefined
  return (
    <button
      ref={cellRef}
      type="button"
      class={`native-global-cell${selected ? ' is-active' : ''}`}
      aria-pressed={selected ? 'true' : 'false'}
      aria-label={`${selected ? 'Take out' : 'Choose'} ${photo.alt || photo.filename}, photograph ${index + 1} of ${total}`}
      onClick={() => onPick(photo.id)}
    >
      {src ? (
        <img
          src={src}
          width={photo.width || undefined}
          height={photo.height || undefined}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : null}
    </button>
  )
}

export default function PostToX({
  title,
  galleryUrl,
  loadPhotos,
  read,
  session,
  share,
  onClose,
  onPosted,
  exportPhotos = exportPostToX,
}: Props) {
  const [photos, setPhotos] = useState<readonly PostToXPhoto[] | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const objectUrls = useRef(new Set<string>()).current
  const dialogRef = useRef<HTMLElement | null>(null)
  // Refs rather than state: the overlay push and the in-flight export read
  // them without re-running effects or closures going stale.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const busyRef = useRef(false)
  busyRef.current = busy
  const aliveRef = useRef(true)

  // The picker is a modal: focus lands on it, Tab is trapped inside by the
  // overlay stack, the Library behind goes inert, and Escape honours the
  // export in flight instead of dropping it mid-preparation.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || typeof document === 'undefined') return
    const release = pushOverlay({
      host: dialog,
      onEscape: () => { if (!busyRef.current) onCloseRef.current() },
    })
    dialog.focus()
    return release
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    let active = true
    void loadPhotos()
      .then((loaded) => {
        if (!active) return
        setPhotos(loaded)
      })
      .catch(() => {
        if (!active) return
        setPhotos([])
        setNote('This gallery could not be read on this device.')
      })
    return () => { active = false }
  }, [loadPhotos])

  // The decrypted previews live only for the picker — closing it revokes
  // every object URL the cells created.
  useEffect(() => () => {
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
  }, [objectUrls])

  const pick = (id: string) => {
    if (busy) return
    const next = togglePostSelection(selected, id)
    if (next.length === selected.length) {
      setNote(POST_TO_X_FULL_NOTE)
      return
    }
    setNote('')
    setSelected(next)
  }

  const reader = useMemo(() => withEncryptedMaterialize(read, session
    ? async (photo) => {
      if (!photo.media || photo.media.kind !== 'encrypted') return undefined
      const materialized = await session.materialize(photo.media, false)
      return { bytes: materialized.bytes, mimeType: materialized.mimeType }
    }
    : undefined), [read, session])

  const post = async () => {
    if (busy || selected.length === 0) return
    setBusy(true)
    setNote('')
    const chosen = orderedSelection(photos ?? [], selected)
    let report: PostExportReport
    try {
      report = await exportPhotos({
        photos: chosen,
        caption,
        title,
        url: galleryUrl,
        read: reader,
        share,
      })
    } catch {
      report = { outcome: 'failed', posted: 0, skipped: 0, note: 'Those photographs could not be prepared for sharing.' }
    }
    // The picker may have been torn down mid-export — its onClose must
    // never land on a picker that opened after it.
    if (!aliveRef.current) return
    setBusy(false)
    if (report.outcome === 'cancelled') {
      onClose()
      return
    }
    if (report.outcome === 'failed') {
      setNote(report.note)
      return
    }
    onPosted(report.note)
    onClose()
  }

  const chosen = photos === null ? 0 : orderedSelection(photos, selected).length

  return (
    <section
      ref={dialogRef}
      tabIndex={-1}
      class="native-global-view native-postto"
      role="dialog"
      aria-modal="true"
      aria-label={`Post to X — ${title}`}
      data-post-to-x
    >
      <div class="native-postto-scroll" data-post-to-x-scroll>
        {photos === null ? (
          <p class="native-global-note">Loading the photographs…</p>
        ) : photos.length === 0 ? (
          <p class="native-global-note">This gallery has no photographs to post.</p>
        ) : (
          <div class="native-global-grid" role="list">
            {photos.map((photo, index) => (
              <PostCell
                key={photo.id}
                photo={photo}
                index={index}
                total={photos.length}
                selected={selected.includes(photo.id)}
                onPick={pick}
                session={session}
                objectUrls={objectUrls}
              />
            ))}
          </div>
        )}
      </div>

      <div class="native-postto-bar">
        <div class="native-postto-head">
          <div>
            <h1>{title}</h1>
            <p class="native-global-picker-meta">
              {chosen} of {POST_TO_X_MAX_MEDIA} photographs
            </p>
          </div>
          <div class="native-global-header-actions">
            <button type="button" class="native-global-close" onClick={onClose} disabled={busy} aria-label="Close">Close</button>
          </div>
        </div>

        <label class="m-field native-postto-caption">
          <span>Caption <small>(optional)</small></span>
          <textarea
            class="m-input m-input--textarea"
            rows={2}
            value={caption}
            disabled={busy}
            aria-label="Caption"
            placeholder="Say something about these photographs"
            onInput={(event) => setCaption((event.currentTarget as HTMLTextAreaElement).value)}
          />
        </label>

        <button
          type="button"
          class="m-btn m-btn--primary native-postto-submit"
          disabled={busy || chosen === 0}
          aria-busy={busy}
          onClick={() => { void post() }}
        >
          {busy ? 'Preparing…' : 'Post to X'}
        </button>

        <p class="native-postto-note" role="status">{note || POST_TO_X_LIMIT_NOTE}</p>
      </div>
    </section>
  )
}
