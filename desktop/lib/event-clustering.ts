/**
 * The raw dump's desktop bridge.
 *
 * Four `invoke` wrappers over the contract in
 * `docs/event-clustering-bridge-contract.md`, plus the shell's
 * `manorama://raw-dump-changed` subscription, and nothing else: every answer
 * is parsed by `packages/core/event-clustering` before it reaches a page, so
 * a half-written index degrades instead of crashing the Library.
 *
 * The bridge is injectable for the same reason `local-scan.ts` injects its
 * `ReadDir` and `native/lib/local-gallery.ts` injects its plugin: the wrappers
 * are the part worth testing, and `@tauri-apps` must not stand between a test
 * and them. `tauri.ts` imports it at module scope because nothing there is
 * unit-tested; the shape here follows `onFolderDrop`, which reaches for the
 * event plugin through a dynamic import for exactly that reason.
 */

import {
  formatEventDateSpan,
  joinDumpPath,
  parseRawDumpPick,
  parseRawDumpScanResult,
  parseRawDumpStatus,
  type EventCluster,
  type RawDumpPick,
  type RawDumpScanResult,
  type RawDumpStatus,
} from '../../packages/core/event-clustering'
import { baseName, type LocalGalleryItem } from './local-scan'
import type { LocalGalleryRecord } from './catalogue'

/** The seam: Tauri's own `invoke`, and its `listen` reduced to a payload
 *  callback with an unlisten. Both are optional-shaped on purpose — a stub
 *  that only answers commands can omit `listen`. */
export type RawDumpBridge = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>
}

/** The shell emits this when the declared dump moves underneath the app —
 *  a folder removed from another window, an index written by the menu's
 *  re-index, a grant that expired. The payload carries nothing the page needs:
 *  the answer is always "ask the shell again", never "trust this". */
export const RAW_DUMP_CHANGED_EVENT = 'manorama://raw-dump-changed'

/** Production bridge. Built per call, never cached: an island may mount
 *  before the Tauri globals exist, and a module-scope capture would then
 *  hand it a bridge that answers nothing for the rest of the session. */
const tauriBridge = (): RawDumpBridge => ({
  invoke: async (command, args) => {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke(command, args ?? {})
  },
  listen: async (event, handler) => {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<unknown>(event, (message) => handler(message.payload))
    return unlisten
  },
})

/**
 * Ask the shell which folder is declared, and whether it can be read.
 *
 * The contract's cheapest command — it touches no photographs — so calling it
 * on every mount is the intended use.
 *
 * Null means this shell has no answer to give: it rejected the command, so it
 * predates the feature, or it never saw one because there is no shell at all.
 * That is deliberately not the same as `{ configured: false }`, which is an
 * answer — the difference between a Mac that could take a Raw Dump folder and
 * a runtime that has nowhere to remember one. Invariant 7 turns on it: only
 * the first may be shown a control.
 */
export const getRawDumpStatus = async (
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpStatus | null> => {
  try {
    return parseRawDumpStatus(await bridge.invoke('get_raw_dump_status'))
  } catch {
    return null
  }
}

/**
 * The folder chooser. Resolves null when the user cancels or the shell refuses
 * to answer with a label — a declaration needs a name to show, and half a
 * declaration is a cancel.
 *
 * A native failure (the security-scoped bookmark could not be written)
 * propagates: the Settings control has to say the folder was not taken,
 * because a silently un-taken folder would leave the user believing their
 * dump is indexed.
 */
export const pickRawDumpRoot = async (
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpPick | null> => parseRawDumpPick(await bridge.invoke('pick_raw_dump_root'))

/**
 * Cluster the declared dump. Incremental unless `force` asks for a rebuild of
 * the metadata cache.
 *
 * This one throws on purpose. "No root is configured" and "the root cannot be
 * reached" are both real states the page must show rather than render as an
 * empty timeline — an empty event list where a drive should be is the kind of
 * lie that makes someone think their photographs are gone.
 */
export const scanRawDumpEvents = async (
  options: { force?: boolean } = {},
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpScanResult> =>
  parseRawDumpScanResult(await bridge.invoke('scan_raw_dump_events', options.force ? { force: true } : {}))

/**
 * Un-declare the dump. The grant itself stays: the shell's contract is that
 * un-granting a folder is the folder's own UI, not a side effect of turning
 * off a feature that happened to be reading it.
 */
export const clearRawDumpRoot = async (bridge: RawDumpBridge = tauriBridge()): Promise<void> => {
  await bridge.invoke('clear_raw_dump_root')
}

/**
 * Listen for the dump changing underneath the app. Returns the unlisten, and
 * a no-op when there is no listener to have — the same graceful shape
 * `onFolderDrop` keeps, so a torn-down webview cannot stall a component's
 * effect cleanup.
 */
export const onRawDumpChanged = async (
  handler: () => void,
  bridge: RawDumpBridge = tauriBridge(),
): Promise<() => void> => {
  const listen = bridge.listen
  if (!listen) return () => {}
  try {
    const unlisten = await listen(RAW_DUMP_CHANGED_EVENT, () => handler())
    return () => {
      try {
        unlisten()
      } catch {
        /* a dead emitter must not stall teardown */
      }
    }
  } catch {
    return () => {}
  }
}

/**
 * An event as the viewer already understands it: a local gallery record that
 * exists only in memory, for as long as the event is open.
 *
 * This is the whole reuse story. The photostrip and grid viewer, its dim
 * healing, its Info-sheet metadata read and its position reporting all work
 * off a `LocalGalleryRecord`, so an event is handed to them as one — with the
 * engine's member ids joined under the dump root. No second viewer, no
 * parallel manifest format, and nothing written back to `catalogue.json`: the
 * record is a view over the index, not a gallery the owner declared.
 *
 * A member id that will not join under the root is dropped rather than
 * rendered as a dead frame, and an event left with no frames at all answers
 * null so the card simply does not open.
 */
export const eventGalleryRecord = (
  cluster: EventCluster,
  rootPath: string | null | undefined,
): LocalGalleryRecord | null => {
  const items: LocalGalleryItem[] = []
  for (const itemId of cluster.itemIds) {
    const path = joinDumpPath(rootPath, itemId)
    if (path === null) continue
    items.push({ id: itemId, name: baseName(itemId), path })
  }
  if (items.length === 0) return null
  const stamp = new Date(cluster.startDate).toISOString()
  return {
    // The event id, which the contract keeps stable across rescans — so a
    // viewer open on an event survives a re-index underneath it.
    id: cluster.id,
    title: formatEventDateSpan(cluster),
    rootPath: rootPath ?? '',
    sourceKind: 'folder',
    itemCount: items.length,
    items,
    addedAt: stamp,
    lastSeenAt: stamp,
  }
}
