import { useEffect, useRef, useState } from 'hono/jsx'
import { ActionRow } from '../../app/components/ui/ActionRow'
import type { EventCluster, EventPresentationOptions } from '../../packages/core/event-clustering'
import { eventClusteringClient, isEventClusteringAvailable, type EventClusteringClient } from '../lib/event-clustering'
import { useEventClustering } from '../lib/event-clustering-state'
import EventSection from './EventSection'
import EventViewer from './EventViewer'
import '../styles/event-clustering.css'

export function CameraRollPill({ client, active, onActivate }: {
  client?: EventClusteringClient
  active: boolean
  onActivate: (trigger: HTMLElement) => void
}) {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let live = true
    void isEventClusteringAvailable(client).then((supported) => { if (live) setAvailable(supported) })
    return () => { live = false }
  }, [client])
  if (!available) return null
  return <button type="button" class="m-btn m-btn--secondary camera-roll-pill" aria-pressed={active ? 'true' : 'false'}
    onClick={(event) => onActivate(event.currentTarget as HTMLElement)}>Camera Roll</button>
}

export function CameraRollFolderAction({ client }: { client?: EventClusteringClient }) {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState<Awaited<ReturnType<EventClusteringClient['status']>>>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void isEventClusteringAvailable(client).then(async (supported) => {
      if (!live || !supported) return
      setAvailable(true)
      setStatus(await (client ?? eventClusteringClient()).status())
    }).catch(() => {})
    return () => { live = false }
  }, [client])
  if (!available) return null
  const choose = async () => {
    setBusy(true)
    setError(null)
    try {
      const bridge = client ?? eventClusteringClient()
      const picked = await bridge.pick()
      if (picked) setStatus(await bridge.status())
    } catch {
      setError('The Camera Roll folder could not be changed.')
    } finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      const bridge = client ?? eventClusteringClient()
      await bridge.clear()
      setStatus(await bridge.status())
    } catch {
      setError('The Camera Roll folder could not be cleared.')
    } finally { setBusy(false) }
  }
  return <>
    <ActionRow label="Camera Roll folder" value={status?.configured ? status.label || 'Folder set' : 'Choose folder'} onClick={() => { void choose() }} disabled={busy} />
    {status?.configured ? <ActionRow label="Clear Camera Roll folder" tone="destructive" onClick={() => { void clear() }} disabled={busy} /> : null}
    {error ? <p class="m-note m-panel-note" role="alert">{error}</p> : null}
  </>
}

export default function CameraRoll({ client, presentation, onClose, onOpenSettings }: {
  client?: EventClusteringClient
  presentation?: EventPresentationOptions
  onClose: () => void
  onOpenSettings: () => void
}) {
  const events = useEventClustering(client)
  const [selected, setSelected] = useState<{ cluster: EventCluster; index: number; revision: number } | null>(null)
  const viewerReturnFocus = useRef<HTMLElement | null>(null)
  const validSelection = selected && selected.revision === events.sourceRevision && events.status?.configured && events.status.isAvailable
  useEffect(() => {
    if (selected && !validSelection) setSelected(null)
  }, [validSelection])
  const openEvent = (cluster: EventCluster, index: number, trigger?: HTMLElement) => {
    if (!events.status?.configured || !events.status.isAvailable) return
    viewerReturnFocus.current = trigger ?? document.activeElement as HTMLElement | null
    setSelected({ cluster, index, revision: events.sourceRevision })
  }
  return <section class="camera-roll-mode" data-camera-roll-mode aria-labelledby="camera-roll-title">
    <header class="camera-roll-heading">
      <button type="button" class="m-btn m-btn--quiet" onClick={onClose} aria-label="Back to galleries">‹ Galleries</button>
      <h2 id="camera-roll-title">Camera Roll</h2>
    </header>
    {!events.status ? <p class="m-note" role="status">Reading Camera Roll…</p>
      : !events.status.configured ? <div class="lib-empty">
        <h3>No Camera Roll folder</h3>
        <button type="button" class="m-btn m-btn--primary" onClick={onOpenSettings}>Choose folder</button>
      </div>
      : !events.status.isAvailable ? <div class="lib-empty">
        <h3>Camera Roll is unavailable</h3>
        <button type="button" class="m-btn m-btn--secondary" onClick={() => { void events.client.settings().catch(() => {}) }}>Photos settings</button>
        <button type="button" class="m-btn m-btn--quiet" onClick={() => { void events.refresh(true) }}>Try again</button>
      </div>
      : <EventSection events={events} onOpen={openEvent} presentation={presentation} />}
    {validSelection && selected ? <EventViewer key={selected.cluster.id} cluster={selected.cluster} initialIndex={selected.index}
      client={events.client} downloadCloudOnOpen={events.status?.downloadCloudOnOpen === true}
      returnFocus={viewerReturnFocus.current} onClose={() => setSelected(null)} /> : null}
  </section>
}
