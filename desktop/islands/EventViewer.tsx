import { useEffect, useMemo, useRef, useState } from 'hono/jsx'
import GalleryShell from '../../app/components/GalleryShell'
import Viewer, { type ViewerChromeControl, type ViewerChromeHandle } from '../../app/islands/Viewer'
import { pushOverlay } from '../../app/lib/overlay-stack'
import { defaultGallerySettings } from '../../packages/core/gallery-settings'
import { formatEventDateSpan, type EventCluster } from '../../packages/core/event-clustering'
import type { GalleryImage } from '../../packages/core/imagesource'
import { readEmbeddedMetadata } from '../../packages/core/embedded-metadata'
import { readEventAssetRange, type EventClusteringClient, type EventPhoto } from '../lib/event-clustering'

const BLANK = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E'

export const eventViewerImages = (cluster: EventCluster, photos: Record<string, EventPhoto>): GalleryImage[] =>
  cluster.itemIds.map((id, index) => {
    const item = photos[id]
    const ready = item?.state === 'ready' && item.src
    return {
      id,
      filename: ready ? id.split('/').pop() || `Photo ${index + 1}` : `Photo ${index + 1}`,
      src: ready ? item.src! : BLANK,
      placeholder: BLANK,
      width: ready ? item.width : 1,
      height: ready ? item.height : 1,
      alt: `Photograph ${index + 1}`,
      c2pa: false,
      fidelity: ready ? 'original' : 'unknown',
    }
  })

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
  return <button ref={ref} type="button" aria-label={photo?.state === 'cloudOnly' ? 'Photograph not downloaded' : 'Open photograph'} aria-current={active ? 'true' : 'false'}
    style={{ aspectRatio: photo?.width && photo.height ? `${photo.width} / ${photo.height}` : '1 / 1' }} onClick={onOpen}>
    {photo?.src ? <img src={photo.src} alt="" loading="lazy" width={photo.width} height={photo.height}
      style={{ maxInlineSize: `min(100%, ${photo.width / dpr}px)`, maxBlockSize: `min(100%, ${photo.height / dpr}px)` }} />
      : <span class="m-note">{photo?.state === 'cloudOnly' ? 'Not downloaded' : 'Photo'}</span>}
  </button>
}

export type EventViewerOpenChange = (open: boolean, close?: () => void) => void

export default function EventViewer({ cluster, initialIndex, client, onClose, returnFocus, navigationRef, chromeRef, onChromeFocus, onPositionChange, onViewerOpenChange }: {
  cluster: EventCluster
  initialIndex: number
  client: EventClusteringClient
  onClose: () => void
  returnFocus?: HTMLElement | null
  navigationRef?: { current: { goTo(index: number): void } | null }
  chromeRef?: { current: ViewerChromeHandle | null }
  onChromeFocus?: (control: ViewerChromeControl) => void
  onPositionChange?: (position: { index: number; total: number }) => void
  onViewerOpenChange?: EventViewerOpenChange
}) {
  const [photos, setPhotos] = useState<Record<string, EventPhoto>>({})
  const photosRef = useRef<Record<string, EventPhoto>>({})
  const [current, setCurrent] = useState(initialIndex)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const returnRef = useRef<HTMLButtonElement | null>(null)
  const activation = useRef<{ release(): void } | null>(null)
  const finished = useRef(false)
  const pickerActivation = useRef<{ release(): void } | null>(null)
  const localNavigation = useRef<{ goTo(index: number): void } | null>(null)
  const navigation = navigationRef ?? localNavigation
  const onCloseRef = useRef(onClose)
  const onViewerOpenChangeRef = useRef(onViewerOpenChange)
  onCloseRef.current = onClose
  onViewerOpenChangeRef.current = onViewerOpenChange
  const closePicker = () => { pickerActivation.current?.release(); setPicker(false) }
  const closeViewer = () => {
    pickerActivation.current?.release()
    activation.current?.release()
    onCloseRef.current()
  }
  const live = useRef(true)
  const generation = useRef(0)
  const currentRef = useRef(initialIndex)
  const settings = useMemo(() => ({
    ...defaultGallerySettings({ slug: cluster.id, title: formatEventDateSpan(cluster), caption: '', date: '', images: [] }),
    defaultMode: 'single' as const,
  }), [cluster.id])
  const id = cluster.itemIds[current]
  const photo = photos[id]

  const request = async (index: number) => {
    const token = ++generation.current
    const requestedId = cluster.itemIds[index]
    setBusy(true)
    setActionError(null)
    try {
      const [item] = await client.images({ ids: [requestedId], purpose: 'viewer' })
      if (!live.current || generation.current !== token) return
      photosRef.current = { [requestedId]: item }
      setPhotos(photosRef.current)
    } catch {
      if (live.current && generation.current === token) {
        photosRef.current = { [requestedId]: { id: requestedId, url: null, src: null, width: 0, height: 0, state: 'failed' } }
        setPhotos(photosRef.current)
      }
    } finally {
      if (live.current && generation.current === token) setBusy(false)
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host?.isConnected || activation.current || finished.current) return
    live.current = true
    const releaseOverlay = pushOverlay({ host, onEscape: closeViewer, returnFocus })
    onViewerOpenChangeRef.current?.(true, closeViewer)
    returnRef.current?.focus()
    const observer = new MutationObserver(() => { if (!host.isConnected) activation.current?.release() })
    observer.observe(document.body, { childList: true, subtree: true })
    activation.current = { release() {
      activation.current = null
      finished.current = true
      observer.disconnect()
      live.current = false
      generation.current++
      onViewerOpenChangeRef.current?.(false)
      client.close()
      releaseOverlay()
    } }
    void request(initialIndex)
  })

  useEffect(() => {
    const host = pickerRef.current
    if (picker && host?.isConnected && !pickerActivation.current) {
      const releaseOverlay = pushOverlay({ host, onEscape: closePicker })
      host.querySelector<HTMLButtonElement>('button')?.focus()
      const observer = new MutationObserver(() => { if (!host.isConnected) pickerActivation.current?.release() })
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
    currentRef.current = index
    generation.current++
    setCurrent(index)
    setActionError(null)
    photosRef.current = {}
    setPhotos(photosRef.current)
    void request(index)
  }

  const reveal = async () => {
    setActionError(null)
    try { await client.reveal(id) }
    catch { if (live.current) setActionError('This photograph could not be revealed.') }
  }

  return <div ref={hostRef} class="event-viewer" role="dialog" aria-modal="true" aria-label="Event photographs">
    <div>
      <button ref={returnRef} type="button" class="admin-button event-viewer-return" aria-label="Back to Camera Roll" onClick={closeViewer}>‹ Camera Roll</button>
      <GalleryShell settings={settings} mediaCount={{ stills: cluster.itemIds.length, videos: 0 }} entered landmark={false}>
        <Viewer slug={cluster.id} galleryTitle={settings.title} images={eventViewerImages(cluster, photos)} settings={settings}
          allowFullscreen={false} onReturnToGalleries={closeViewer} initialIndex={currentRef.current}
          navigationRef={navigation} chromeRef={chromeRef} onChromeFocus={onChromeFocus}
          onOpenGlobalView={() => setPicker(true)} nativePickerOpen={picker}
          readMetadata={async (image) => {
            const url = photosRef.current[image.id]?.url
            if (!url) return undefined
            return readEmbeddedMetadata((start, length) => readEventAssetRange(url, start, length))
          }}
          onPositionChange={(position: { imageId: string; index: number }) => {
            move(position.index)
            onPositionChange?.({ index: position.index, total: cluster.itemIds.length })
          }} />
        {photo?.state !== 'ready' ? <section class="event-cloud" aria-label="Photograph availability" data-event-placeholder>
          <p role="status">{busy ? 'Opening photograph…' : photo?.state === 'cloudOnly' ? 'Not downloaded' : photo?.state === 'missing' ? 'Photo unavailable' : photo?.state === 'failed' ? 'Couldn’t open this photograph' : 'Opening photograph…'}</p>
          <div class="event-cloud-actions">
            {!busy && photo?.state === 'failed' ? <button type="button" class="admin-button" onClick={() => { void request(current) }}>Try again</button> : null}
            {!busy && (photo?.state === 'cloudOnly' || photo?.state === 'missing') ? <button type="button" class="admin-button admin-button--solid" onClick={() => { void reveal() }}>Reveal in folder</button> : null}
            <button type="button" class="admin-button" onClick={closeViewer}>Events</button>
          </div>
          {actionError ? <p role="alert">{actionError}</p> : null}
        </section> : null}
      </GalleryShell>
    </div>
    {picker ? <section ref={pickerRef} class="event-picker" role="dialog" aria-modal="true" aria-label="Event photo picker">
      <button type="button" class="admin-button" onClick={closePicker}>Close photo picker</button>
      <div class="event-picker-grid">{cluster.itemIds.map((itemId, index) => <PickerPhoto key={itemId} id={itemId} active={index === current} client={client} onOpen={() => {
        closePicker()
        navigation.current?.goTo(index)
        move(index)
      }} />)}</div>
    </section> : null}
  </div>
}
