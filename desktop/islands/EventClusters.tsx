import { useEffect, useRef, useState } from 'hono/jsx'
import { ActionGroup, ActionRow } from '../../app/components/ui/ActionRow'
import { CompactCoverImg } from '../../app/components/library/CompactCoverImg'
import { hasMacosShell } from '../lib/shell'
import { assetUrl, isDesktopRuntime } from '../lib/tauri'
import {
  clearRawDumpRoot,
  getRawDumpStatus,
  onRawDumpChanged,
  pickRawDumpRoot,
  scanRawDumpEvents,
  type RawDumpBridge,
} from '../lib/event-clustering'
import {
  formatEventDateSpan,
  formatEventFrameCount,
  formatIndexedAgo,
  formatSubDayLabel,
  joinDumpPath,
  orderedSubDays,
  rawDumpStage,
  subDayStartIndex,
  type EventCluster,
  type RawDumpScanResult,
  type RawDumpStatus,
} from '../../packages/core/event-clustering'

/**
 * The Raw Dump surfaces: the declaration control in Settings, and the event
 * cards in the Library.
 *
 * Both halves read the same shell commands and neither owns a timeline of its
 * own — the clustering is the native engine's (`native/EventClustering/`), the
 * wire shape is the contract's, and what is here is only what a photograph
 * owner needs to see to use the result: which days, how many frames, and a
 * cover to recognise the event by. No classification label is shown anywhere,
 * because the engine produces none.
 *
 * Cards open the existing photostrip/grid viewer. The host turns the event
 * into a local gallery record (`eventGalleryRecord`) and hands it to the same
 * path a folder card uses, so there is one viewer in this app, not two.
 */

/** The gate every surface here needs: persistence. A folder declaration and
 *  its index live on the device, so the plain web app shows no control that
 *  could not remember being used — invariant 7. Injected rather than read
 *  from the runtime so both halves of the rule are testable. */
const nativeGate = (native: boolean | undefined): boolean =>
  native ?? (isDesktopRuntime() || hasMacosShell())

export type EventOpenTarget = {
  cluster: EventCluster
  /** The dump root the members join under. */
  rootPath: string | null
  /** Where to open: the chosen sub-day's first frame, else the event's. */
  index: number
}

type SharedProps = {
  /** Test seam for the four shell commands. */
  bridge?: RawDumpBridge
  /** Filesystem path → paintable URL. The shell's asset protocol in the app. */
  srcFor?: (path: string) => string
  /** Forced runtime gate; see `nativeGate`. */
  native?: boolean
}

export type EventClustersProps = SharedProps & {
  /** Host state bump: the declaration moved (Settings chose or removed a
   *  folder), so re-read it instead of showing last mount's answer. */
  revision?: number
  onOpenEvent?: (target: EventOpenTarget) => void
}

/**
 * The Library's event section.
 *
 * Mounted unconditionally by the host; it renders nothing at all until the
 * shell answers that a Raw Dump folder is declared and reachable. That is the
 * product's rule as much as the code's: a feature the owner has not switched
 * on must not leave a hollow section in the Library, and a feature they have
 * switched on but that cannot be read must not show a grid of nothing.
 */
export default function EventClusters({
  bridge,
  srcFor = assetUrl,
  native,
  revision = 0,
  onOpenEvent,
}: EventClustersProps) {
  const isNative = nativeGate(native)
  const [status, setStatus] = useState<RawDumpStatus | null>(null)
  const [scan, setScan] = useState<RawDumpScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [failed, setFailed] = useState(false)
  /* 1. Underneath-Change Detection: the shell emits when the declared folder
        moves — a drive unmounted, an index written elsewhere — and the page
        offers a re-scan rather than serving a stale timeline from memory. */
  const [stale, setStale] = useState(false)
  /** Cover dims learned from decoded frames — a ref, not state: it only ever
   *  seeds the next render, never the current one, and is never persisted.
   *  The same treatment the local gallery cards give theirs. */
  const dimsRef = useRef<Map<string, { w: number; h: number }>>(new Map())

  const load = async () => {
    const next = await getRawDumpStatus(bridge)
    setStatus(next)
    // The contract's rule: a page may not ask for a scan when no root is
    // declared, so the timeline stays unasked-for rather than erroring.
    if (!next?.configured || !next.isAvailable) return
    setScanning(true)
    setFailed(false)
    try {
      setScan(await scanRawDumpEvents({}, bridge))
      setStale(false)
    } catch {
      // Reachability was answered a moment ago, so a throw here is the drive
      // going away mid-read. The section says it could not be read rather
      // than pretending the dump is empty.
      setFailed(true)
      setScan(null)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    if (!isNative) return
    let live = true
    void load().catch(() => {
      if (live) setFailed(true)
    })
    return () => {
      live = false
    }
    // `revision` is the host's "the declaration changed" bump.
  }, [isNative, revision])

  useEffect(() => {
    if (!isNative) return
    let live = true
    let unlisten: (() => void) | null = null
    void onRawDumpChanged(() => {
      if (live) setStale(true)
    }, bridge).then((off) => {
      if (live) unlisten = off
      else off()
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [isNative])

  if (!isNative) return null
  const stage = rawDumpStage(status, scan, failed)
  if (status === null || stage === 'unsupported' || stage === 'not-configured') return null

  const clusters = scan?.clusters ?? []
  const rootPath = scan?.rootPath ?? null
  const sourceName = status.label ?? 'the Raw Dump folder'

  const openEvent = (cluster: EventCluster, index: number) => {
    onOpenEvent?.({ cluster, rootPath, index })
  }

  const eventCard = (cluster: EventCluster) => {
    const span = formatEventDateSpan(cluster)
    const days = orderedSubDays(cluster)
    const coverPath = joinDumpPath(rootPath, cluster.coverItemId)
    const dims = dimsRef.current.get(cluster.coverItemId)
    const openAt = (dayId: string | null) => openEvent(cluster, dayId === null ? 0 : subDayStartIndex(cluster, dayId))
    return (
      <li key={cluster.id} class="lib-compact-card" data-event-card={cluster.id}>
        <a
          class="lib-compact-cover"
          href={`#event-${cluster.id}`}
          onClick={(event: MouseEvent) => {
            event.preventDefault()
            openAt(null)
          }}
          draggable={false}
          aria-label={`${span} cover`}
          /* 2. Honest Cover Size: the same cell the local cards use, so the
             rendition floats at its decoded pixels instead of being stretched
             to the column — invariants 2 and 13. */
        >
          {coverPath === null ? null : (
            <CompactCoverImg
              src={srcFor(coverPath)}
              storedWidth={dims?.w}
              storedHeight={dims?.h}
              onNaturalSize={(width, height) => dimsRef.current.set(cluster.coverItemId, { w: width, h: height })}
            />
          )}
        </a>
        <div class="lib-compact-body">
          <div class="lib-compact-main">
            <button type="button" class="lib-card-title" onClick={() => openAt(null)}>{span}</button>
            <p class="lib-card-sub">
              {formatEventFrameCount(cluster)}
              {cluster.isMultiDay ? (
                <span class="device-pill" data-colour="none" data-event-multiday="true">
                  {days.length > 1 ? `${days.length} days` : 'Multi-day'}
                </span>
              ) : null}
            </p>
            {days.length > 1 ? (
              /* 3. Sub-Day Tabs: one line per day, each opening the viewer at
                    that day's first frame — the title above opens the whole
                    event. A tab strip with a selection would need somewhere
                    to put the chosen state on a card this small, and would
                    still be two gestures to reach a day; these are wrapped
                    text actions because a fortnight-long trip does not fit
                    one row of a card, and clipped tabs are days the owner
                    never sees. */
              <p class="lib-card-sub" role="group" aria-label={`Days in ${span}`}>
                {days.map((day) => (
                  <button
                    type="button"
                    class="lib-card-action"
                    data-event-day={day.id}
                    onClick={() => openAt(day.id)}
                  >
                    {formatSubDayLabel(day, cluster)}
                  </button>
                ))}
              </p>
            ) : null}
          </div>
        </div>
      </li>
    )
  }

  return (
    <section aria-labelledby="lib-events-title">
      <h2 id="lib-events-title" class="lib-section-title">
        Events <span class="lib-section-count">({clusters.length})</span>
      </h2>
      {stage === 'indexing' ? (
        <p class="lib-section-sub" role="status">Indexing {sourceName}…</p>
      ) : null}
      {stage === 'empty' ? (
        <p class="lib-section-sub">No events in {sourceName} yet.</p>
      ) : null}
      {stage === 'unavailable' ? (
        <p class="lib-section-sub" role="status">
          {sourceName} is not reachable right now — reconnect it, then re-index it in Settings.
        </p>
      ) : null}
      {stage === 'failed' ? (
        <p class="lib-section-sub" role="status">
          The events in {sourceName} could not be read.
          <button type="button" class="lib-card-action" disabled={scanning} onClick={() => void load()}>
            {scanning ? 'Reading…' : 'Try again'}
          </button>
        </p>
      ) : null}
      {stale && stage === 'ready' ? (
        <p class="lib-section-sub" role="status">
          {sourceName} changed since this was indexed.
          <button type="button" class="lib-card-action" disabled={scanning} onClick={() => void load()}>
            {scanning ? 'Reading…' : 'Re-scan'}
          </button>
        </p>
      ) : null}
      {clusters.length > 0 ? (
        <ul class="lib-compact-grid">{clusters.map(eventCard)}</ul>
      ) : null}
    </section>
  )
}

export type RawDumpSettingsProps = SharedProps & {
  /** The host bumps its own `revision` so the Library section re-reads the
   *  declaration the moment it changes here. */
  onDeclarationChanged?: () => void
  /** The clock the ageing "Indexed 3 hours ago" line reads. */
  now?: () => number
}

/**
 * The Settings declaration control — the only place a Raw Dump is chosen.
 *
 * Three states, because those are the three the shell can answer: nothing
 * declared, declared and readable, declared but unreachable (an unmounted
 * external drive is configured, not gone). The third is the one worth words:
 * an owner who disconnects a backup drive should find the row still there,
 * saying what is wrong, not a form that forgot they ever used it.
 *
 * Nothing here renders when the runtime cannot persist it: the plain web app
 * gets no chooser it cannot honour.
 */
export function RawDumpSettings({ bridge, native, onDeclarationChanged, now = () => Date.now() }: RawDumpSettingsProps) {
  const isNative = nativeGate(native)
  const [status, setStatus] = useState<RawDumpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = async () => {
    setStatus(await getRawDumpStatus(bridge))
  }

  useEffect(() => {
    if (!isNative) return
    void refresh()
  }, [isNative])

  if (!isNative || status === null) return null

  const choose = async () => {
    setBusy(true)
    setNote(null)
    try {
      // A cancel answers null and changes nothing — no re-index, no re-read,
      // no message. The owner closed a dialog; that is not an event.
      const picked = await pickRawDumpRoot(bridge)
      if (!picked) return
      // Declaring a folder indexes it in the same gesture. A dump the owner
      // just chose and that shows nothing until the next launch reads as a
      // broken feature, and the scan is incremental for everything after.
      try {
        await scanRawDumpEvents({ force: true }, bridge)
      } catch {
        setNote(`${picked.label} was chosen, but it could not be read just now.`)
      }
      await refresh()
      onDeclarationChanged?.()
    } catch {
      // The shell's own failure — a bookmark it could not write. The folder is
      // not declared, so saying so is the whole of the honesty available.
      setNote('This Mac could not take on that folder.')
    } finally {
      setBusy(false)
    }
  }

  const reindex = async () => {
    setBusy(true)
    setNote(null)
    try {
      // Forced: the row is the owner asking for the folder to be read again,
      // usually because they believe it changed. The incremental path would
      // trust the modification times they are doubting.
      await scanRawDumpEvents({ force: true }, bridge)
      await refresh()
      onDeclarationChanged?.()
    } catch {
      setNote('That folder could not be read — is the drive connected?')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setNote(null)
    try {
      await clearRawDumpRoot(bridge)
      await refresh()
      onDeclarationChanged?.()
    } catch {
      setNote('The folder is still declared — this Mac could not let go of it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ActionGroup
      label="Raw Dump folder"
      note="One folder of uncurated photographs — a cloud camera backup, a card you never culled — grouped into events on this Mac. Nothing leaves the device: no timestamp, path or photograph is uploaded for it."
    >
      {status.configured ? (
        <>
          <ActionRow label="Folder" value={status.label ?? 'Declared folder'} chevron={false} />
          <ActionRow label="Last indexed" value={formatIndexedAgo(status.lastIndexedAt, now())} chevron={false} />
          <ActionRow
            label="Events"
            value={status.eventCount === 1 ? '1 event' : `${status.eventCount} events`}
            chevron={false}
          />
          {status.isAvailable ? null : (
            <p class="desktop-badge-unavailable">Not reachable right now — reconnect the source, then re-index.</p>
          )}
          <ActionRow label="Re-index" onClick={() => void reindex()} disabled={busy || !status.isAvailable} />
          <ActionRow label="Choose a different folder" onClick={() => void choose()} disabled={busy} />
          <ActionRow label="Stop using this folder" onClick={() => void remove()} disabled={busy} tone="destructive" />
        </>
      ) : (
        <ActionRow label="Choose a folder" onClick={() => void choose()} disabled={busy} />
      )}
      {note ? <p class="desktop-badge-unavailable" role="status">{note}</p> : null}
    </ActionGroup>
  )
}
