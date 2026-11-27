import {
  isEventAssetId,
  isEventAssetLeaseUrl,
  isEventAssetRequest,
  parseEventAssetImages,
  parseRawDumpPick,
  parseRawDumpScanResult,
  parseRawDumpStatus,
  type EventAssetImage,
  type EventAssetRequest,
  type RawDumpPick,
  type RawDumpScanResult,
  type RawDumpStatus,
} from '../../packages/core/event-clustering'

export type RawDumpBridge = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void>
}

export const RAW_DUMP_CHANGED_EVENT = 'manorama://raw-dump-changed'

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

export const getRawDumpStatus = async (
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpStatus | null> => {
  try {
    return parseRawDumpStatus(await bridge.invoke('get_raw_dump_status'))
  } catch {
    return null
  }
}

export const pickRawDumpRoot = async (
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpPick | null> => parseRawDumpPick(await bridge.invoke('pick_raw_dump_root'))

export const scanRawDumpEvents = async (
  options: { force?: boolean } = {},
  bridge: RawDumpBridge = tauriBridge(),
): Promise<RawDumpScanResult> =>
  parseRawDumpScanResult(await bridge.invoke('scan_raw_dump_events', options.force ? { force: true } : {}))

export const clearRawDumpRoot = async (bridge: RawDumpBridge = tauriBridge()): Promise<void> => {
  await bridge.invoke('clear_raw_dump_root')
}

export const getEventAssetImage = async (
  options: EventAssetRequest,
  bridge: RawDumpBridge = tauriBridge(),
): Promise<EventAssetImage[]> => {
  if (!isEventAssetRequest(options)) throw new Error('Invalid event photograph request')
  if (options.allowNetwork === true) throw new Error('Desktop event assets never download')
  const raw = await bridge.invoke('get_event_asset_image', {
    ids: options.ids,
    purpose: options.purpose,
    ...(options.maxPixelSize === undefined ? {} : { maxPixelSize: options.maxPixelSize }),
    allowNetwork: false,
  })
  const items = parseEventAssetImages(raw, options.ids)
  if (!items || items.some((item) => item.state === 'ready' && !isEventAssetLeaseUrl(item.url))) {
    throw new Error('The event photograph reply could not be read')
  }
  return items
}

export const revealEventAsset = async (id: string, bridge: RawDumpBridge = tauriBridge()): Promise<void> => {
  if (!isEventAssetId(id)) throw new Error('Invalid event photograph identifier')
  await bridge.invoke('reveal_event_asset', { id })
}

export const onRawDumpChanged = async (
  handler: () => void,
  bridge: RawDumpBridge = tauriBridge(),
): Promise<() => void> => {
  if (!bridge.listen) return () => {}
  try {
    const unlisten = await bridge.listen(RAW_DUMP_CHANGED_EVENT, () => handler())
    return () => { try { unlisten() } catch { /* a dead emitter must not stall teardown */ } }
  } catch {
    return () => {}
  }
}

export const eventAssetSrc = (url: string | null): string | null =>
  isEventAssetLeaseUrl(url) ? url : null

export const readEventAssetRange = async (url: string, start: number, length: number): Promise<Uint8Array> => {
  if (!isEventAssetLeaseUrl(url) || !Number.isSafeInteger(start) || start < 0
    || !Number.isSafeInteger(length) || length <= 0 || length > 2 * 1024 * 1024
    || !Number.isSafeInteger(start + length)) throw new Error('Invalid event photograph range')
  const end = start + length - 1
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    credentials: 'omit',
    cache: 'no-store',
  })
  const contentRange = response.headers.get('content-range')
  if (response.status !== 206 || !contentRange
    || !new RegExp(`^bytes ${start}-${end}/[0-9]+$`).test(contentRange)) {
    throw new Error('The event photograph range could not be read')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== length) throw new Error('The event photograph range was incomplete')
  return bytes
}

export type EventPhoto = EventAssetImage & { src: string | null }

export const createEventClustering = (
  bridge: RawDumpBridge,
) => {
  let generation = 0
  return {
    async status() { return getRawDumpStatus(bridge) },
    async pick() {
      generation++
      return pickRawDumpRoot(bridge)
    },
    async scan(force = false) { return scanRawDumpEvents({ force }, bridge) },
    async clear() {
      generation++
      await clearRawDumpRoot(bridge)
    },
    async images(request: EventAssetRequest): Promise<EventPhoto[]> {
      const token = generation
      const items = await getEventAssetImage(request, bridge)
      if (token !== generation) throw new Error('Event photograph request cancelled')
      return items.map((item) => ({ ...item, src: eventAssetSrc(item.url) }))
    },
    async reveal(id: string) { await revealEventAsset(id, bridge) },
    async changes(listener: () => void) { return onRawDumpChanged(listener, bridge) },
    close() { generation++ },
  }
}

export type EventClusteringClient = ReturnType<typeof createEventClustering>
let client: EventClusteringClient | undefined
export const eventClusteringClient = (): EventClusteringClient =>
  client ??= createEventClustering(tauriBridge())

export const isEventClusteringAvailable = async (injected?: EventClusteringClient): Promise<boolean> => {
  try { return (await (injected ?? eventClusteringClient()).status()) !== null } catch { return false }
}
