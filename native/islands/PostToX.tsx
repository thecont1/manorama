import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import { fetchGallery } from '../lib/api'
import {
  orderedSelection,
  photoMimeType,
  postToXPhotos,
  postToXText,
  togglePostSelection,
  POST_TO_X_FULL_NOTE,
  POST_TO_X_LIMIT_NOTE,
  POST_TO_X_MAX_MEDIA,
  type PostToXPhoto,
} from '../lib/post-to-x'
import {
  exportPhotosForShare,
  postPhotoReader,
  type PostExportReport,
  type PostPhotoBytes,
  type PostPhotoReader,
  type PostSavedPhotos,
} from '../lib/post-export'
import { getSessionToken } from '../lib/session'
import { GridThumbLoader } from '../lib/global-view'
import type { OfflineObjectUrlProvider } from '../lib/offline-gallery'
import '../styles/global-view.css'
import '../styles/post-to-x.css'

/**
 * "Post to X" — the photograph picker, opened from a gallery's own menu.
 *
 * It is the familiar picker: the same contact matrix, the same fixed-height
 * cells, the same shocking pink on the photographs in hand. What is new is
 * that a tap now picks a photograph instead of opening it, and the
 * photographs are posted in the gallery's order however they were tapped.
 *
 * The export itself lives in `native/lib/post-export.ts`: the photographs are
 * prepared on the device and handed to the operating system's share sheet, so
 * X is one target among the phone's own.
 */

type Props = {
  apiBase: string
  owner: string
  slug: string
  title: string
  /** The gallery's own address — the way back to the full set. */
  galleryUrl: string
  onClose: () => void
  /** Told what happened, in the photographer's words. */
  onPosted: (note: string) => void
  /** Injected by the tests; the default reads the provider's original. */
  read?: PostPhotoReader
  /** This device's own copies of the gallery's photographs. */
  savedPhotos?: PostSavedPhotos
  /** Decrypts one photograph from an encrypted source, when the device holds
   *  no copy of it. */
  materialize?: (photo: PostToXPhoto) => Promise<PostPhotoBytes | undefined>
  exportPhotos?: typeof exportPhotosForShare
}

const defaultObjectUrls: OfflineObjectUrlProvider = {
  create(bytes, mimeType) {
    return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }))
  },
  revoke(url) {
    URL.revokeObjectURL(url)
  },
}

/**
 * The default reader: the provider's original bytes, with the session's
 * bearer. A photograph with no address — an encrypted gallery's — is not
 * reachable this way; its bytes come from this device instead.
 */
const fetchFromProvider: PostPhotoReader = async (photo) => {
  if (!photo.src) return undefined
  const token = await getSessionToken()
  const response = await fetch(photo.src, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
  if (!response.ok) return undefined
  const mimeType = response.headers.get('Content-Type')?.split(';')[0] ?? 'application/octet-stream'
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType }
}

/**
 * One cell of the picker matrix.
 *
 * A cloud photograph shows the provider's own rendition. A photograph from an
 * encrypted source has no address at all, so the cell shows the device's own
 * copy — read when the cell nears the viewport, so a gallery of two hundred
 * stays a flat memory profile instead of decrypting every frame at once.
 */
const PostCell = ({
  photo,
  index,
  total,
  selected,
  onPick,
  galleryKey,
  entryIdFor,
  loader,
}: {
  photo: PostToXPhoto
  index: number
  total: number
  selected: boolean
  onPick: (id: string) => void
  galleryKey: string
  entryIdFor: (photoId: string) => string
  loader?: GridThumbLoader
}) => {
  const [savedUrl, setSavedUrl] = useState<string | null>(null)
  const cellRef = useRef<HTMLButtonElement | null>(null)
  // An encrypted photograph is only ever shown from this device: the provider
  // has no rendition of it to offer.
  const needsSaved = Boolean(loader) && (photo.encrypted || !photo.preview)

  useEffect(() => {
    if (!needsSaved || !loader) return
    let cancelled = false
    const materialize = () => {
      void loader
        .urlFor(galleryKey, {
          id: photo.id,
          entryId: entryIdFor(photo.id),
          mimeType: photoMimeType(photo),
          video: false,
          width: photo.width,
          height: photo.height,
          alt: photo.alt,
          index,
        })
        .then((url) => {
          if (!cancelled && url) setSavedUrl(url)
        })
        .catch(() => undefined)
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
  }, [needsSaved, loader, galleryKey, entryIdFor, photo, index])

  const src = photo.encrypted ? savedUrl ?? undefined : photo.preview || undefined
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
          width={photo.width}
          height={photo.height}
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
  apiBase,
  owner,
  slug,
  title,
  galleryUrl,
  onClose,
  onPosted,
  read,
  savedPhotos,
  materialize,
  exportPhotos = exportPhotosForShare,
}: Props) {
  const [photos, setPhotos] = useState<readonly PostToXPhoto[] | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let active = true
    void fetchGallery(apiBase, owner, slug)
      .then((response) => {
        if (!active) return
        setPhotos(postToXPhotos(response.manifest.images))
      })
      .catch(() => {
        if (!active) return
        setPhotos([])
        setNote('This gallery could not be read on this device.')
      })
    return () => { active = false }
  }, [apiBase, owner, slug])

  // The grid's own copies are materialized lazily and revoked with the picker,
  // so closing it leaves no decrypted photograph behind in the page. The
  // device's saved bytes come first; a photograph the device does not hold
  // falls back to live decryption through the same bounded loader — its LRU
  // and concurrency caps keep the fallback as flat as the primary path, and
  // a read that lands after release is revoked on arrival.
  const photosByEntry = useMemo(() => {
    const map = new Map<string, PostToXPhoto>()
    for (const photo of photos ?? []) {
      map.set(savedPhotos ? savedPhotos.entryIdFor(photo.id) : photo.id, photo)
    }
    return map
  }, [photos, savedPhotos])
  const entryIdFor = useMemo(() => savedPhotos
    ? savedPhotos.entryIdFor
    : (photoId: string) => photoId, [savedPhotos])
  const loader = useMemo(() => (savedPhotos || materialize)
    ? new GridThumbLoader({
        read: async (_galleryId, entryId) => {
          const saved = await savedPhotos?.read(entryId).catch(() => undefined)
          if (saved && saved.length > 0) return saved
          const photo = photosByEntry.get(entryId)
          if (!photo || !materialize) return undefined
          const decrypted = await materialize(photo).catch(() => undefined)
          return decrypted?.bytes
        },
        objectUrls: defaultObjectUrls,
      })
    : undefined, [savedPhotos, materialize, photosByEntry])
  useEffect(() => () => loader?.release(), [loader])

  const pick = (id: string) => {
    if (busy) return
    const next = togglePostSelection(selected, id)
    if (next.length === selected.length) {
      // The ceiling is X's, and it is reached silently: a note says so.
      setNote(POST_TO_X_FULL_NOTE)
      return
    }
    setNote('')
    setSelected(next)
  }

  const reader = useMemo(() => read ?? postPhotoReader({
    fetch: fetchFromProvider,
    saved: savedPhotos,
    materialize,
  }), [read, savedPhotos, materialize])

  const post = async () => {
    if (busy || selected.length === 0) return
    setBusy(true)
    setNote('')
    const chosen = orderedSelection(photos ?? [], selected)
    let report: PostExportReport
    try {
      report = await exportPhotos({
        photos: chosen,
        text: postToXText(caption, galleryUrl),
        title,
        url: galleryUrl,
        read: reader,
      })
    } catch {
      report = { outcome: 'failed', posted: 0, skipped: 0, note: 'Those photographs could not be prepared for sharing.' }
    }
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
                galleryKey={savedPhotos?.galleryId ?? slug}
                entryIdFor={entryIdFor}
                loader={loader}
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
            <button type="button" class="native-global-close" onClick={onClose} aria-label="Close">Close</button>
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
