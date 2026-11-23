import { useEffect, useRef, useState } from 'hono/jsx'
import { formatEventDateSpan, formatEventFrameCount, formatSubDayLabel, orderedSubDays, subDayStartIndex, type EventCluster } from '../../packages/core/event-clustering'
import type { EventClusteringController } from '../lib/event-clustering-state'
import type { EventClusteringClient, EventPhoto } from '../lib/event-clustering'
import '../styles/event-clustering.css'

function EventCard({ cluster, client, revision, onOpen }: { cluster: EventCluster; client: EventClusteringClient; revision: number; onOpen: (event: EventCluster, index: number, trigger?: HTMLElement) => void }) {
  const [cover, setCover] = useState<EventPhoto | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    setCover(null)
    let alive = true
    let requested = false
    let retried = false
    const load = () => {
      if (requested) return
      requested = true
      void client.images({ ids: [cluster.coverItemId], purpose: 'thumbnail', maxPixelSize: 512 }).then(([item]) => { if (alive) setCover(item) }).catch((reason) => {
        if (!alive) return
        // Viewer navigation cancels the shared transport generation; the independent cover can retry once.
        if (!retried && reason instanceof Error && reason.message === 'Event photograph request cancelled') {
          retried = true
          requested = false
          load()
          return
        }
        setCover({ id: cluster.coverItemId, url: null, src: null, width: 0, height: 0, state: 'failed' })
      })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect() }
    }, { rootMargin: '200px' })
    if (observer && ref.current) observer.observe(ref.current)
    else load()
    return () => { alive = false; observer?.disconnect() }
  }, [client, cluster.coverItemId, revision])
  const span = formatEventDateSpan(cluster)
  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1)
  return <li ref={ref} class="event-card">
    <button type="button" class="event-card-open" onClick={(event) => onOpen(cluster, 0, event.currentTarget as HTMLElement)} aria-label={`${span}, ${formatEventFrameCount(cluster)}`}>
      <span class="event-card-cover">
        {cover?.src ? <img src={cover.src} alt="" loading="lazy" width={cover.width} height={cover.height}
          style={{ maxInlineSize: `min(100%, ${cover.width / dpr}px)`, maxBlockSize: `min(100%, ${cover.height / dpr}px)`, aspectRatio: `${cover.width} / ${cover.height}` }} />
          : <span class="m-note">{cover?.state === 'cloudOnly' ? 'In iCloud' : cover?.state === 'missing' ? 'Photo unavailable' : cover?.state === 'failed' ? 'Preview unavailable' : 'Reading preview…'}</span>}
      </span>
      <strong>{span}</strong><span class="m-note">{formatEventFrameCount(cluster)}{cluster.isMultiDay ? ' · Multi-day' : ''}</span>
    </button>
    {orderedSubDays(cluster).length ? <div class="event-days" aria-label={`Days in ${span}`}>
      {orderedSubDays(cluster).map((day) => <button type="button" key={day.id} class="m-btn m-btn--quiet" onClick={(event) => onOpen(cluster, subDayStartIndex(cluster, day.id), event.currentTarget as HTMLElement)}>{formatSubDayLabel(day, cluster)}</button>)}
    </div> : null}
  </li>
}

export default function EventSection({ events, onOpen }: { events: EventClusteringController; onOpen: (event: EventCluster, index: number, trigger?: HTMLElement) => void }) {
  const [accessError, setAccessError] = useState<string | null>(null)
  if (!events.status?.configured) return null
  const limited = events.status.authorization === 'limited'
  return <section class="native-account event-section" aria-labelledby="native-events-title" data-event-section>
    <h3 class="lib-section-title" id="native-events-title">Event groups</h3>
    {limited ? <>
      <p class="m-note">{events.status.selectedPhotoCount === null || events.status.selectedPhotoCount === undefined ? 'Selected photos only' : `Showing ${events.status.selectedPhotoCount} selected photos`}</p>
      <button type="button" class="m-btn m-btn--quiet" onClick={() => {
        setAccessError(null)
        void events.client.limitedPicker().then(() => events.refresh(true)).catch(() => setAccessError('Selected photos could not be changed.'))
      }}>Choose photos</button>
      {accessError ? <p class="m-note" role="alert">{accessError}</p> : null}
    </> : null}
    {!events.status.isAvailable ? <p class="m-note">Photos access is not available. Review the event source below.</p>
      : events.error ? <><p class="m-note" role="alert">{events.error}</p><button type="button" class="m-btn m-btn--quiet" onClick={() => { void events.refresh() }}>Try again</button></>
      : !events.scan ? <p class="m-note" role="status">Reading events…</p>
      : !events.scan.clusters.length ? <p class="m-note">No events in the selected photos.</p>
      : <ul class="event-grid">{events.scan.clusters.map((cluster) => <EventCard key={cluster.id} cluster={cluster} client={events.client} revision={events.sourceRevision} onOpen={onOpen} />)}</ul>}
  </section>
}
