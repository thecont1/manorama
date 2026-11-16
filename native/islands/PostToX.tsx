import { useEffect, useState } from 'hono/jsx'
import { fetchGallery } from '../lib/api'
import {
  orderedSelection,
  postToXPhotos,
  postToXText,
  togglePostSelection,
  POST_TO_X_FULL_NOTE,
  POST_TO_X_LIMIT_NOTE,
  POST_TO_X_MAX_MEDIA,
  type PostToXPhoto,
} from '../lib/post-to-x'
import { exportPhotosForShare, type PostExportReport, type PostPhotoReader } from '../lib/post-export'
import { getSessionToken } from '../lib/session'
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
  /** Injected by the tests; the default fetches the provider's original. */
  read?: PostPhotoReader
  exportPhotos?: typeof exportPhotosForShare
}

/**
 * The default reader: the provider's original bytes, with the session's
 * bearer. A photograph with no address — an encrypted gallery's — is not
 * reachable this way and is left out of the post.
 */
const defaultReader: PostPhotoReader = async (photo) => {
  if (!photo.src) return undefined
  const token = await getSessionToken()
  const response = await fetch(photo.src, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
  if (!response.ok) return undefined
  const mimeType = response.headers.get('Content-Type')?.split(';')[0] ?? 'application/octet-stream'
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType }
}

export default function PostToX({
  apiBase,
  owner,
  slug,
  title,
  galleryUrl,
  onClose,
  onPosted,
  read = defaultReader,
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
        read,
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
            {photos.map((photo, index) => {
              const isSelected = selected.includes(photo.id)
              return (
                <button
                  key={photo.id}
                  type="button"
                  class={`native-global-cell${isSelected ? ' is-active' : ''}`}
                  aria-pressed={isSelected ? 'true' : 'false'}
                  aria-label={`${isSelected ? 'Take out' : 'Choose'} ${photo.alt || photo.filename}, photograph ${index + 1} of ${photos.length}`}
                  onClick={() => pick(photo.id)}
                >
                  <img
                    src={photo.preview}
                    width={photo.width}
                    height={photo.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                </button>
              )
            })}
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
