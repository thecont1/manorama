import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import type { NativeTier } from '../lib/billing'
import {
  offlineGalleryId,
  type GallerySelection,
  type OfflineGalleryStore,
  type OfflineGridFrame,
  type OfflineGridGallery,
  type OfflineObjectUrlProvider,
} from '../lib/offline-gallery'
import {
  GridThumbLoader,
  loadGlobalViewEnabled,
  saveGlobalViewEnabled,
} from '../lib/global-view'
import type { VaultCapPersistence } from '../lib/vault-settings'
import { preferencesPersistence } from '../lib/vault-settings'
import '../styles/global-view.css'

type Store = Pick<OfflineGalleryStore, 'gridGallery' | 'listGridGalleries' | 'readThumbnail'>

type Props = {
  store: Store
  tier: NativeTier | undefined
  /** The gallery currently open on the stage — the Free tier's whole scope. */
  current: GallerySelection | null
  persistence?: VaultCapPersistence
  objectUrls?: OfflineObjectUrlProvider
  onOpenFrame: (selection: GallerySelection, index: number) => void
  onClose: () => void
}

const defaultObjectUrls: OfflineObjectUrlProvider = {
  create(bytes, mimeType) {
    return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }))
  },
  revoke(url) {
    URL.revokeObjectURL(url)
  },
}

const emptyNote = (tier: NativeTier | undefined, current: GallerySelection | null): string => {
  if (tier === 'pro') return 'Nothing on this device yet. Galleries you open are indexed here.'
  if (!current) return 'Open a gallery first — global view indexes what this device has seen.'
  return 'This gallery is still settling onto this device. Viewed photographs appear here once the vault holds them.'
}

/** One grid cell. The <img> materializes only when the cell nears the
 *  viewport — a 500-frame gallery stays a flat memory profile instead of
 *  holding every decrypted thumbnail at once. */
const FrameCell = ({
  gallery,
  frame,
  loader,
  observe,
  onOpen,
}: {
  gallery: OfflineGridGallery
  frame: OfflineGridFrame
  loader: GridThumbLoader
  observe: ((el: Element, cb: () => void) => () => void) | null
  onOpen: (selection: GallerySelection, index: number) => void
}) => {
  const [url, setUrl] = useState<string | null>(() => loader.peek(gallery.galleryId, frame) ?? null)
  const cellRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (url !== null) return
    let cancelled = false
    const materialize = () => {
      void loader.urlFor(gallery.galleryId, frame).then((next) => {
        if (!cancelled && next) setUrl(next)
      })
    }
    const cell = cellRef.current
    if (!observe || !cell) {
      materialize()
      return () => { cancelled = true }
    }
    const unobserve = observe(cell, materialize)
    return () => {
      cancelled = true
      unobserve()
    }
  }, [])

  return (
    <button
      ref={cellRef}
      type="button"
      class="native-global-cell"
      data-grid-frame
      data-index={frame.index}
      onClick={() => onOpen({ owner: gallery.owner, slug: gallery.slug }, frame.index)}
      aria-label={`${gallery.title}, photograph ${frame.index + 1} of ${gallery.frames.length}`}
    >
      {url ? (
        <img src={url} width={frame.width} height={frame.height} alt={frame.alt} draggable={false} />
      ) : null}
    </button>
  )
}

/** The vault-backed index of every frame this device holds. Opt-in, offline,
 *  and honest about what it is: a private contact sheet, never uploaded. */
export default function GlobalView({
  store,
  tier,
  current,
  persistence = preferencesPersistence,
  objectUrls = defaultObjectUrls,
  onOpenFrame,
  onClose,
}: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [galleries, setGalleries] = useState<OfflineGridGallery[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  // A cache fill writes metadata last, so an empty read while a gallery is
  // open is usually "in flight", not "nothing". Retry briefly before showing
  // the empty note — then say it honestly.
  const [retriesLeft, setRetriesLeft] = useState(6)
  const gridRef = useRef<HTMLElement | null>(null)
  const callbacksRef = useRef(new Map<Element, () => void>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const loader = useMemo(
    () => new GridThumbLoader({ read: (galleryId, entryId) => store.readThumbnail(galleryId, entryId), objectUrls }),
    [store, objectUrls],
  )

  useEffect(() => {
    let active = true
    void loadGlobalViewEnabled(persistence).then((value) => {
      if (active) setEnabled(value)
    })
    return () => {
      active = false
      loader.release()
    }
  }, [persistence, loader])

  useEffect(() => {
    if (enabled !== true || galleries !== null) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        let found: OfflineGridGallery[]
        if (tier === 'pro') {
          found = await store.listGridGalleries()
        } else if (!current) {
          found = []
        } else {
          const grid = await store.gridGallery(await offlineGalleryId(current))
          found = grid ? [grid] : []
        }
        if (!active) return
        if (found.length === 0 && current && retriesLeft > 0) {
          timer = setTimeout(() => setRetriesLeft((left) => left - 1), 700)
          return
        }
        setGalleries(found)
      } catch {
        if (active) setLoadError(true)
      }
    }
    void load()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [enabled, galleries, retriesLeft, tier, current, store])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !gridRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) callbacksRef.current.get(entry.target)?.()
        }
      },
      // Materialize ahead of the fold so a fast scroll never shows a blank row.
      { root: gridRef.current, rootMargin: '320px' },
    )
    observerRef.current = observer
    for (const el of callbacksRef.current.keys()) observer.observe(el)
    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [galleries])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const observe = typeof IntersectionObserver === 'undefined'
    ? null
    : (el: Element, cb: () => void) => {
        callbacksRef.current.set(el, cb)
        observerRef.current?.observe(el)
        return () => {
          callbacksRef.current.delete(el)
          observerRef.current?.unobserve(el)
        }
      }

  const enable = () => {
    void saveGlobalViewEnabled(true, persistence)
    setRetriesLeft(6)
    setEnabled(true)
  }
  const disable = () => {
    void saveGlobalViewEnabled(false, persistence)
    setGalleries(null)
    loader.release()
    setEnabled(false)
  }

  const frameCount = galleries?.reduce((sum, gallery) => sum + gallery.frames.length, 0) ?? 0

  return (
    <section class="native-global-view" role="dialog" aria-modal="true" aria-label="Global view" data-global-view>
      <header class="native-global-header">
        <div>
          <p class="native-global-kicker">Global view</p>
          <h1>Every frame, on this device</h1>
        </div>
        <div class="native-global-header-actions">
          {enabled === true ? (
            <button type="button" class="native-global-toggle" onClick={disable}>
              Turn off
            </button>
          ) : null}
          <button type="button" class="native-global-close" onClick={onClose} aria-label="Close global view">
            Close
          </button>
        </div>
      </header>

      {enabled === null ? (
        <p class="native-global-note">Loading…</p>
      ) : enabled === false ? (
        <div class="native-global-explainer">
          <p>
            Global view is a private contact sheet of the photographs this device holds — encrypted,
            indexed locally, never uploaded. Tap any frame to open the stage on it.
          </p>
          <p>
            On Free it shows the gallery you have open. On Pro it indexes every gallery on this device.
          </p>
          <button type="button" class="native-global-enable" onClick={enable}>
            Turn on global view
          </button>
        </div>
      ) : loadError ? (
        <p class="native-global-note" role="alert">
          The on-device index could not be read.
        </p>
      ) : galleries === null ? (
        <p class="native-global-note">Reading the on-device index…</p>
      ) : galleries.length === 0 ? (
        <p class="native-global-note">{emptyNote(tier, current)}</p>
      ) : (
        <div class="native-global-scroll" ref={gridRef} data-global-scroll>
          {galleries.map((gallery) => (
            <section class="native-global-gallery" key={gallery.galleryId}>
              <h2>
                {gallery.title}
                <span class="native-global-gallery-meta">
                  {gallery.owner}/{gallery.slug} · {gallery.frames.length} photographs
                </span>
              </h2>
              <div class="native-global-grid" role="list">
                {gallery.frames.map((frame) => (
                  <FrameCell
                    key={frame.id}
                    gallery={gallery}
                    frame={frame}
                    loader={loader}
                    observe={observe}
                    onOpen={onOpenFrame}
                  />
                ))}
              </div>
            </section>
          ))}
          {tier !== 'pro' ? (
            <p class="native-global-note native-global-free-note">
              Free shows the gallery you have open. Pro indexes every gallery on this device.
            </p>
          ) : null}
          <p class="native-global-note native-global-count" aria-hidden="true">
            {frameCount} frames indexed on this device.
          </p>
        </div>
      )}
    </section>
  )
}
