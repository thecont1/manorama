import { useEffect, useRef, useState } from 'hono/jsx'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import type { ViewerChromeControl, ViewerChromeHandle } from '../../app/islands/Viewer'
import {
  deviceEventPresentation,
  formatDaysLabel,
  formatEventCardLabel,
  formatEventDateSpan,
  formatEventDayLabel,
  formatEventFrameCount,
  formatEventPreviewState,
  formatMultiDayLabel,
  formatSubDayLabel,
  orderedSubDays,
  subDayStartIndex,
  type EventCluster,
  type EventPresentationOptions,
} from '../../packages/core/event-clustering'
import {
  eventClusteringClient,
  isEventClusteringAvailable,
  type EventClusteringClient,
  type EventPhoto,
} from '../lib/event-clustering'
import { useEventClustering, type EventClusteringController } from '../lib/event-clustering-state'
import { hasMacosShell } from '../lib/shell'
import { isDesktopRuntime } from '../lib/tauri'
import EventViewer, { type EventViewerOpenChange } from './EventViewer'

const nativeGate = (native: boolean | undefined): boolean =>
  native ?? (isDesktopRuntime() || hasMacosShell())

type SharedProps = {
  client?: EventClusteringClient
  native?: boolean
  presentation?: EventPresentationOptions
}

export function CameraRollPill({ client, native, active, onActivate }: SharedProps & {
  active: boolean
  onActivate: (trigger: HTMLElement) => void
}) {
  const bridge = client ?? eventClusteringClient()
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!nativeGate(native)) return
    let live = true
    void isEventClusteringAvailable(bridge).then((supported) => { if (live) setAvailable(supported) })
    return () => { live = false }
  }, [bridge, native])
  if (!available) return null
  return <button type="button" class="admin-button camera-roll-pill" aria-pressed={active ? 'true' : 'false'}
    onClick={(event) => onActivate(event.currentTarget as HTMLElement)}>Camera Roll</button>
}

export function CameraRollFolderAction({ client, native, onDeclarationChanged }: SharedProps & {
  onDeclarationChanged?: () => void
}) {
  const bridge = client ?? eventClusteringClient()
  const [status, setStatus] = useState<Awaited<ReturnType<EventClusteringClient['status']>>>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    if (!nativeGate(native)) return
    mounted.current = true
    void bridge.status().then((next) => { if (mounted.current) setStatus(next) }).catch(() => {})
    return () => { mounted.current = false; generation.current++ }
  }, [bridge, native])
  if (!nativeGate(native) || status === null) return null

  const choose = async () => {
    const token = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const picked = await bridge.pick()
      if (!mounted.current || token !== generation.current || !picked) return
      const next = await bridge.status()
      if (!mounted.current || token !== generation.current) return
      setStatus(next)
      onDeclarationChanged?.()
    } catch {
      if (mounted.current && token === generation.current) setError('The Camera Roll folder could not be changed.')
    } finally {
      if (mounted.current && token === generation.current) setBusy(false)
    }
  }
  const clear = async () => {
    const token = ++generation.current
    setBusy(true)
    setError(null)
    try {
      await bridge.clear()
      if (!mounted.current || token !== generation.current) return
      const next = await bridge.status()
      if (!mounted.current || token !== generation.current) return
      setStatus(next)
      onDeclarationChanged?.()
    } catch {
      if (mounted.current && token === generation.current) setError('The Camera Roll folder could not be cleared.')
    } finally {
      if (mounted.current && token === generation.current) setBusy(false)
    }
  }

  return <ActionGroup label="Camera Roll" class="camera-roll-settings">
    <ActionRow label="Folder" value={status.configured ? status.label || 'Folder set' : 'Choose folder'} onClick={() => { void choose() }} disabled={busy} />
    {status.configured ? <ActionRow label="Clear folder" tone="destructive" onClick={() => { void clear() }} disabled={busy} /> : null}
    {error ? <p class="m-note m-panel-note" role="alert">{error}</p> : null}
  </ActionGroup>
}

const MAX_COVER_CANCELLATIONS = 2

function EventCard({ cluster, client, revision, onOpen, presentation }: {
  cluster: EventCluster
  client: EventClusteringClient
  revision: number
  onOpen: (event: EventCluster, index: number, trigger?: HTMLElement) => void
  presentation: EventPresentationOptions
}) {
  const [cover, setCover] = useState<EventPhoto | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  const request = useRef<Promise<EventPhoto[]> | null>(null)
  const retryState = useRef({ client, id: cluster.coverItemId, revision, cancellations: 0, terminal: false })
  useEffect(() => {
    if (retryState.current.client !== client || retryState.current.id !== cluster.coverItemId
      || retryState.current.revision !== revision) {
      retryState.current = { client, id: cluster.coverItemId, revision, cancellations: 0, terminal: false }
      request.current = null
    }
    if (retryState.current.terminal) return
    setCover(null)
    let alive = true
    const load = () => {
      if (retryState.current.terminal) return
      const pending = request.current ??= client.images({ ids: [cluster.coverItemId], purpose: 'thumbnail', maxPixelSize: 512 })
      void pending.then(([item]) => {
        if (!alive) return
        request.current = null
        retryState.current.terminal = true
        setCover(item)
      }).catch((reason) => {
        if (!alive) return
        request.current = null
        if (reason instanceof Error && reason.message === 'Event photograph request cancelled'
          && retryState.current.cancellations < MAX_COVER_CANCELLATIONS) {
          retryState.current.cancellations += 1
          load()
          return
        }
        retryState.current.terminal = true
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
  const span = formatEventDateSpan(cluster, presentation)
  const days = orderedSubDays(cluster)
  const dpr = typeof window === 'undefined' ? 1 : Math.max(1, window.devicePixelRatio || 1)
  return <li ref={ref} class="lib-compact-card event-card" data-event-card={cluster.id}>
    <button type="button" class="event-card-open" onClick={(event) => onOpen(cluster, 0, event.currentTarget as HTMLElement)} aria-label={formatEventCardLabel(cluster, cover?.state, presentation)}>
      <span class="event-card-cover">
        {cover?.src ? <img src={cover.src} alt="" loading="lazy" width={cover.width} height={cover.height}
          style={{ maxInlineSize: `min(100%, ${cover.width / dpr}px)`, maxBlockSize: `min(100%, ${cover.height / dpr}px)`, aspectRatio: `${cover.width} / ${cover.height}` }} />
          : <span class="m-note">{formatEventPreviewState(cover?.state, presentation)}</span>}
      </span>
      <strong>{span}</strong>
      <span class="m-note">{formatEventFrameCount(cluster, presentation)}{cluster.isMultiDay ? ` · ${formatMultiDayLabel(presentation)}` : ''}</span>
    </button>
    {days.length ? <div class="event-days" role="group" aria-label={formatDaysLabel(span, presentation)}>
      {days.map((day) => <button type="button" key={day.id} class="admin-button" data-event-day={day.id}
        aria-label={formatEventDayLabel(day, cluster, span, presentation)}
        onClick={(event) => onOpen(cluster, subDayStartIndex(cluster, day.id), event.currentTarget as HTMLElement)}>{formatSubDayLabel(day, cluster, presentation)}</button>)}
    </div> : null}
  </li>
}

function EventSection({ events, onOpen, presentation }: { events: EventClusteringController; onOpen: (event: EventCluster, index: number, trigger?: HTMLElement) => void; presentation?: EventPresentationOptions }) {
  const formatted = presentation ?? deviceEventPresentation()
  if (events.error) return <div class="lib-empty">
    <p class="m-note" role="alert">{events.error}</p>
    <button type="button" class="admin-button" onClick={() => { void events.refresh() }}>Try again</button>
  </div>
  if (!events.scan) return <p class="m-note" role="status">Reading events…</p>
  if (!events.scan.clusters.length) return <p class="m-note">No events in this folder.</p>
  return <>
    {events.stale ? <div class="event-stale" role="status">
      <span>Folder changed since this was indexed.</span>
      <button type="button" class="admin-button" disabled={events.busy} onClick={() => { void events.refresh(true) }}>Re-scan</button>
    </div> : null}
    <ul class="lib-compact-grid event-grid" role="list">{events.scan.clusters.map((cluster) =>
      <EventCard key={cluster.id} cluster={cluster} client={events.client} revision={events.sourceRevision} onOpen={onOpen} presentation={formatted} />)}</ul>
  </>
}

export default function CameraRoll({ client, native, presentation, onClose, onOpenSettings, navigationRef, chromeRef, onChromeFocus, onPositionChange, onViewerOpenChange }: SharedProps & {
  onClose: () => void
  onOpenSettings: () => void
  navigationRef?: { current: { goTo(index: number): void } | null }
  chromeRef?: { current: ViewerChromeHandle | null }
  onChromeFocus?: (control: ViewerChromeControl) => void
  onPositionChange?: (position: { index: number; total: number }) => void
  onViewerOpenChange?: EventViewerOpenChange
}) {
  const events = useEventClustering(client ?? eventClusteringClient(), nativeGate(native))
  const [selected, setSelected] = useState<{ cluster: EventCluster; index: number; revision: number } | null>(null)
  const viewerReturnFocus = useRef<HTMLElement | null>(null)
  const validSelection = selected !== null && selected.revision === events.sourceRevision
    && events.status?.configured === true && events.status.isAvailable
  useEffect(() => { if (selected && !validSelection) setSelected(null) }, [validSelection])
  if (!nativeGate(native)) return null
  const openEvent = (cluster: EventCluster, index: number, trigger?: HTMLElement) => {
    if (!events.status?.configured || !events.status.isAvailable) return
    viewerReturnFocus.current = trigger ?? document.activeElement as HTMLElement | null
    setSelected({ cluster, index, revision: events.sourceRevision })
  }
  return <section class="camera-roll-mode" data-camera-roll-mode aria-labelledby="camera-roll-title">
    <header class="camera-roll-heading">
      <button type="button" class="admin-button" aria-label="Back to galleries" onClick={onClose}>‹ Galleries</button>
      <h2 id="camera-roll-title">Camera Roll</h2>
    </header>
    {!events.status ? <p class="m-note" role="status">Reading Camera Roll…</p>
      : !events.status.configured ? <div class="lib-empty">
        <p class="m-note">No Camera Roll folder</p>
        <button type="button" class="admin-button admin-button--solid" onClick={onOpenSettings}>Choose folder</button>
      </div>
      : !events.status.isAvailable ? <div class="lib-empty">
        <p class="m-note">Camera Roll is unavailable</p>
        <button type="button" class="admin-button" onClick={() => { void events.refresh(true) }}>Try again</button>
      </div>
      : <EventSection events={events} onOpen={openEvent} presentation={presentation} />}
    {validSelection && selected ? <EventViewer key={selected.cluster.id} cluster={selected.cluster} initialIndex={selected.index}
      client={events.client} returnFocus={viewerReturnFocus.current} onClose={() => setSelected(null)}
      navigationRef={navigationRef} chromeRef={chromeRef} onChromeFocus={onChromeFocus}
      onPositionChange={onPositionChange} onViewerOpenChange={onViewerOpenChange} /> : null}
  </section>
}
