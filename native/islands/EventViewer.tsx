import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer from '../../app/islands/Viewer'
import { pushOverlay } from '../../app/lib/overlay-stack'
import { defaultGallerySettings } from '../../packages/core/gallery-settings'
import { formatEventDateSpan, type EventCluster } from '../../packages/core/event-clustering'
import type { GalleryImage } from '../../packages/core/imagesource'
import type { EventClusteringClient, EventPhoto } from '../lib/event-clustering'
import '../styles/event-clustering.css'

/** A vector blank, never a low-resolution bitmap pretending to be an
 * original. Empty image src would request the current page. */
const BLANK = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E'

export const eventViewerImages = (cluster: EventCluster, photos: Record<string, EventPhoto>): GalleryImage[] =>
  cluster.itemIds.map((id, index) => {
    const item = photos[id]
    const ready = item?.state === 'ready' && item.src
    return {
      id, filename: ready ? decodeURIComponent(item.url!.split('/').pop()!) : `Photo ${index + 1}`,
      src: ready ? item.src! : BLANK, placeholder: BLANK,
      width: ready ? item.width : 1, height: ready ? item.height : 1,
      alt: `Photograph ${index + 1}`, c2pa: false, fidelity: ready ? 'original' : 'unknown',
    }
  })

export const eventPhotoWindow = (ids: readonly string[], index: number, photos: Record<string, EventPhoto>) => {
  const retainedIds = new Set(ids.slice(Math.max(0, index - 1), index + 2))
  const retained: Record<string, EventPhoto> = {}
  const released: string[] = []
  for (const [id, photo] of Object.entries(photos)) {
    if (retainedIds.has(id)) retained[id] = photo
    else if (photo.url) released.push(photo.url)
  }
  return { retained, released }
}

function PickerPhoto({ id, active, client, onOpen }: { id: string; active: boolean; client: EventClusteringClient; onOpen: () => void }) {
  const [photo, setPhoto] = useState<EventPhoto | null>(null)
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    let alive = true
    let requested = false
    const load = () => {
      if (requested) return
      requested = true
      void client.images({ ids: [id], purpose: 'thumbnail', maxPixelSize: 512 }).then(([item]) => { if (alive) setPhoto(item) }).catch(() => {})
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect() }
    })
    if (observer && ref.current) observer.observe(ref.current)
    else load()
    return () => { alive = false; observer?.disconnect() }
  }, [id, client])
  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1)
  return <button ref={ref} type="button" aria-label={photo?.state === 'cloudOnly' ? 'Photograph in iCloud' : 'Open photograph'} aria-current={active ? 'true' : 'false'}
    style={{ aspectRatio: photo?.width && photo.height ? `${photo.width} / ${photo.height}` : '1 / 1' }} onClick={onOpen}>
    {photo?.src ? <img src={photo.src} alt="" width={photo.width} height={photo.height}
      style={{ maxInlineSize: `min(100%, ${photo.width / dpr}px)`, maxBlockSize: `min(100%, ${photo.height / dpr}px)` }} />
      : <span class="m-note">{photo?.state === 'cloudOnly' ? 'In iCloud' : 'Photo'}</span>}
  </button>
}

export default function EventViewer({ cluster, initialIndex, client, downloadCloudOnOpen, onClose, returnFocus }: {
  cluster: EventCluster; initialIndex: number; client: EventClusteringClient; downloadCloudOnOpen: boolean; onClose: () => void; returnFocus?: HTMLElement | null
}) {
  const [photos, setPhotos] = useState<Record<string, EventPhoto>>({})
  const photosRef = useRef<Record<string, EventPhoto>>({})
  const [current, setCurrent] = useState(initialIndex)
  const [progress, setProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const returnRef = useRef<HTMLButtonElement | null>(null)
  const activation = useRef<{ release(): void } | null>(null)
  const finished = useRef(false)
  const pickerActivation = useRef<{ release(): void } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closePicker = () => { pickerActivation.current?.release(); setPicker(false) }
  const closeViewer = () => {
    pickerActivation.current?.release()
    activation.current?.release()
    onCloseRef.current()
  }
  const navigation = useRef<{ goTo(index: number): void } | null>(null)
  const live = useRef(true)
  const generation = useRef(0)
  const currentRef = useRef(initialIndex)
  // Originals arrive individually. A strip of truthful 1px vector blanks
  // would fit in one viewport and make unavailable members unreachable.
  const settings = useMemo(() => ({ ...defaultGallerySettings({ slug: cluster.id, title: formatEventDateSpan(cluster), caption: '', date: '', images: [] }), defaultMode: 'single' as const }), [cluster.id])
  const id = cluster.itemIds[current]
  const photo = photos[id]

  const request = async (index: number, network: boolean) => {
    const token = ++generation.current
    const requestedId = cluster.itemIds[index]
    setBusy(true)
    setProgress(null)
    try {
      const window = eventPhotoWindow(cluster.itemIds, index, photosRef.current)
      photosRef.current = window.retained
      setPhotos(window.retained)
      await client.release(window.released)
      if (!live.current || generation.current !== token) return
      const [item] = await client.images({ ids: [requestedId], purpose: 'viewer', allowNetwork: network })
      if (!live.current || generation.current !== token) {
        if (item.url) await client.release([item.url])
        return
      }
      const previous = photosRef.current[requestedId]
      photosRef.current = { ...photosRef.current, [requestedId]: item }
      setPhotos(photosRef.current)
      if (previous?.url && previous.url !== item.url) await client.release([previous.url])
      if (item.state === 'cloudOnly' && !network && downloadCloudOnOpen) {
        await request(index, true)
      }
    } catch {
      if (live.current && generation.current === token) {
        photosRef.current = { ...photosRef.current, [requestedId]: { id: requestedId, url: null, src: null, width: 0, height: 0, state: 'failed' } }
        setPhotos(photosRef.current)
      }
    } finally { if (live.current && generation.current === token) setBusy(false) }
  }
  // Like Sheet, activation follows host connectivity, not effect cleanup:
  // Hono may repeat cleanups during a render while this host is still live.
  useEffect(() => {
    const host = hostRef.current
    if (!host?.isConnected || activation.current || finished.current) return
    live.current = true
    const releaseOverlay = pushOverlay({ host, onEscape: closeViewer, returnFocus })
    returnRef.current?.focus()
    let listener: { remove(): Promise<void> } | undefined
    const observer = new MutationObserver(() => {
      if (!host.isConnected) activation.current?.release()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    activation.current = { release() {
      activation.current = null
      finished.current = true
      observer.disconnect()
      live.current = false
      generation.current++
      void listener?.remove()
      void client.close().catch(() => {})
      releaseOverlay()
    } }
    void client.progress((value) => {
      if (live.current && value.id === cluster.itemIds[currentRef.current]) setProgress(value.fraction)
    }).then((handle) => { listener = handle; if (!live.current) void handle.remove() }).catch(() => {})
    void request(initialIndex, false)
  })

  useEffect(() => {
    const host = pickerRef.current
    if (picker && host?.isConnected && !pickerActivation.current) {
      const releaseOverlay = pushOverlay({ host, onEscape: closePicker })
      host.querySelector<HTMLButtonElement>('button')?.focus()
      const observer = new MutationObserver(() => {
        if (!host.isConnected) pickerActivation.current?.release()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      pickerActivation.current = { release() {
        pickerActivation.current = null
        observer.disconnect()
        releaseOverlay()
      } }
    } else if (!picker) pickerActivation.current?.release()
  })
  const move = (index: number) => {
    if (index === currentRef.current) return
    const previousId = cluster.itemIds[currentRef.current]
    currentRef.current = index
    generation.current++
    setCurrent(index)
    setProgress(null)
    setActionError(null)
    const window = eventPhotoWindow(cluster.itemIds, index, photosRef.current)
    photosRef.current = window.retained
    setPhotos(window.retained)
    void client.cancel([previousId]).then(() => client.release(window.released)).then(() => {
      if (live.current && currentRef.current === index && photosRef.current[cluster.itemIds[index]]?.state !== 'ready') void request(index, false)
    }).catch(() => {
      if (live.current && currentRef.current === index) { setBusy(false); setActionError('Temporary photographs could not be released. Return to Camera Roll and try again.') }
    })
  }
  const cancel = () => {
    generation.current++
    setBusy(false)
    setProgress(null)
    void client.cancel([id]).catch(() => {})
  }
  return <div ref={hostRef} class="event-viewer" role="dialog" aria-modal="true" aria-label="Event photographs">
    <div>
      <button ref={returnRef} type="button" class="m-chrome-pill event-viewer-return" aria-label="Back to Camera Roll" onClick={closeViewer}>‹ Camera Roll</button>
    <GalleryShell settings={settings} mediaCount={{ stills: cluster.itemIds.length, videos: 0 }}>
      <Viewer slug={cluster.id} galleryTitle={settings.title} images={eventViewerImages(cluster, photos)} settings={settings}
        allowFullscreen={false} onReturnToGalleries={closeViewer} initialIndex={currentRef.current}
        navigationRef={navigation} onPositionChange={(position) => move(position.index)}
        onOpenGlobalView={() => setPicker(true)} nativePickerOpen={picker} />
      {photo?.state !== 'ready' ? <section class="event-cloud" aria-label="Photograph availability" data-event-placeholder>
        <p role="status">{busy ? progress === null ? 'Opening photograph…' : `Downloading ${Math.round(progress * 100)}%` : photo?.state === 'cloudOnly' ? 'In iCloud' : photo?.state === 'missing' ? 'Photo unavailable' : photo?.state === 'failed' ? 'Couldn’t open this photograph' : 'Opening photograph…'}</p>
        {progress !== null ? <progress max={1} value={progress} aria-label="Photo download" /> : null}
        <div class="event-cloud-actions">
          {busy ? <button type="button" class="m-btn m-btn--quiet" onClick={cancel}>Cancel</button>
            : photo?.state === 'cloudOnly' ? <button type="button" class="m-btn m-btn--secondary" onClick={() => { void request(current, true) }}>Download this photo</button>
              : <button type="button" class="m-btn m-btn--quiet" onClick={() => { void request(current, false) }}>Try again</button>}
          <button type="button" class="m-btn m-btn--quiet" onClick={() => { void client.photos(id).catch(() => { if (live.current) setActionError('Photos is unavailable on this device.') }) }}>Open in Photos</button>
          <button type="button" class="m-btn m-btn--quiet" onClick={closeViewer}>Events</button>
        </div>
        {actionError ? <p role="alert">{actionError}</p> : null}
      </section> : null}
    </GalleryShell>
    </div>
    {picker ? <section ref={pickerRef} class="event-picker" role="dialog" aria-modal="true" aria-label="Event photo picker">
      <button type="button" class="m-btn m-btn--quiet" onClick={closePicker}>Close photo picker</button>
      <div class="event-picker-grid">{cluster.itemIds.map((itemId, index) => <PickerPhoto key={itemId} id={itemId} active={index === current} client={client} onOpen={() => {
        closePicker()
        navigation.current?.goTo(index)
        move(index)
      }} />)}</div>
    </section> : null}
  </div>
}
