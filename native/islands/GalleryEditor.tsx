import { useEffect, useMemo, useState } from 'hono/jsx'
import type { GalleryManifest, GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'
import { CloseIcon } from '../../app/components/admin-icons'
import { fetchGallery, updateGalleryOrder } from '../lib/api'
import '../styles/global-view.css'

/**
 * The gallery editor. Resequencing is the only edit it makes, and it makes it
 * on the same matrix the photo picker uses in the gallery view — same cells,
 * same fixed viewport-relative height, aspect-true widths, zero gaps, and the
 * same shocking pink marking the photograph in hand. A photograph is picked up
 * with one tap and put down with another; the ones between it and its new
 * place shift along as they would on a table.
 *
 * The order is held locally until it is saved, so a half-finished shuffle is
 * never written to the gallery, and Discard restores what the server holds.
 */
type Props = {
  owner: string
  slug: string
  title: string
  apiBase: string
  onClose: () => void
  onSaved?: () => void
}

type EditorPhoto = {
  id: string
  /** The key an order is matched against. Deliberately not `id`: `id` is the
   *  manifest's own handle, while the repository reorders by `ref ?? filename`.
   *  An order sent in ids matches nothing server-side and is dropped without
   *  complaint, which reaches the owner as a save that did nothing. */
  orderKey: string
  src: string
  width: number
  height: number
  label: string
}

/** Mirrors `imageKey` in `app/lib/gallery-repository.ts`. The two must agree,
 *  which is why the save below reads the order back before calling it saved. */
export const orderKeyOf = (image: GalleryMediaItem): string =>
  image.ref ?? image.filename ?? image.id

const photosFrom = (manifest: GalleryManifest): EditorPhoto[] =>
  manifest.images.map((image, index) => ({
    id: image.id,
    orderKey: orderKeyOf(image),
    src: isVideoItem(image) ? image.poster.src : image.variants?.[0]?.src ?? image.src,
    width: image.width,
    height: image.height,
    label: image.alt || image.filename || `Photograph ${index + 1}`,
  }))

export default function GalleryEditor({ owner, slug, title, apiBase, onClose, onSaved }: Props) {
  const [photos, setPhotos] = useState<EditorPhoto[] | null>(null)
  const [savedKeys, setSavedKeys] = useState<string[]>([])
  const [held, setHeld] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    setNote('Reading this gallery…')
    void fetchGallery(apiBase, owner, slug)
      .then(({ manifest }) => {
        if (!active) return
        const loaded = photosFrom(manifest)
        setPhotos(loaded)
        setSavedKeys(loaded.map((photo) => photo.orderKey))
        setNote(loaded.length ? null : 'This gallery has no photographs yet.')
      })
      .catch((reason) => {
        if (active) setNote(reason instanceof Error ? reason.message : 'This gallery could not be read.')
      })
    return () => { active = false }
  }, [apiBase, owner, slug])

  const dirty = useMemo(() => {
    if (!photos) return false
    return photos.some((photo, index) => photo.orderKey !== savedKeys[index]) || photos.length !== savedKeys.length
  }, [photos, savedKeys])

  const putDown = (targetId: string) => {
    if (!photos || !held) return
    if (held === targetId) { setHeld(null); setNote('Nothing is in hand now.'); return }
    const from = photos.findIndex((photo) => photo.id === held)
    const to = photos.findIndex((photo) => photo.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...photos]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setPhotos(next)
    setHeld(null)
    setNote(`Moved “${moved.label}” to position ${to + 1} of ${next.length}.`)
  }

  const save = async () => {
    if (!photos || !dirty || busy) return
    setBusy(true)
    setNote('Saving the new order…')
    const intended = photos.map((photo) => photo.orderKey)
    try {
      await updateGalleryOrder(apiBase, slug, intended)
      // The route tolerates keys it does not recognise and still answers 200,
      // so a key that has drifted from the repository's own would read as a
      // silent no-op — the exact failure this read-back exists to catch.
      const { manifest } = await fetchGallery(apiBase, owner, slug)
      const stored = manifest.images.map(orderKeyOf)
      if (!intended.every((key, index) => stored[index] === key)) {
        setNote('The gallery did not take that order, so nothing was changed. Try again.')
        return
      }
      setSavedKeys(intended)
      setNote('New order saved.')
      onSaved?.()
    } catch (reason) {
      setNote(reason instanceof Error ? reason.message : 'That order could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="native-editor" role="dialog" aria-modal="true" aria-label={`Reorder ${title}`} data-gallery-editor>
      <header class="native-editor-head">
        <div class="native-editor-titles">
          <h2>Reorder {title}</h2>
          <p class="native-editor-hint">
            {held
              ? 'Tap the photograph that should take its place.'
              : 'Tap a photograph to pick it up, then tap where it belongs.'}
          </p>
        </div>
        <button
          type="button"
          class="native-editor-close"
          aria-label="Close the editor"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <p class="native-editor-note" role="status" aria-live="polite">{note ?? ''}</p>
      {photos && photos.length ? (
        <div class="native-editor-scroll" data-editor-scroll>
          <div class="native-global-gallery">
            <div class="native-global-grid" role="list">
              {photos.map((photo, index) => (
                <button
                  type="button"
                  class={`native-global-cell${held === photo.id ? ' is-active' : ''}`}
                  role="listitem"
                  key={photo.id}
                  data-photo={photo.id}
                  aria-label={`${photo.label}, position ${index + 1} of ${photos.length}`}
                  aria-pressed={held === photo.id ? 'true' : 'false'}
                  disabled={busy}
                  onClick={() => (held ? putDown(photo.id) : (setHeld(photo.id), setNote(`“${photo.label}” is in hand.`)))}
                >
                  <img
                    src={photo.src}
                    width={photo.width}
                    height={photo.height}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <footer class="native-editor-actions">
        <button type="button" class="native-editor-save" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save order'}
        </button>
        <button
          type="button"
          disabled={!dirty || busy || !photos}
          onClick={() => {
            if (!photos) return
            const restored = savedKeys
              .map((key) => photos.find((photo) => photo.orderKey === key))
              .filter((photo): photo is EditorPhoto => Boolean(photo))
            setPhotos(restored)
            setHeld(null)
            setNote('Back to the saved order.')
          }}
        >
          Discard changes
        </button>
      </footer>
    </section>
  )
}