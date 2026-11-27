import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  isEventAssetFileUrl, isEventAssetId, isEventAssetRequest, parseEventAssetImages,
  parseEventAssetProgress, parseRawDumpPick, parseRawDumpScanResult, parseRawDumpStatus,
  type EventAssetImage, type EventAssetProgress, type EventAssetRequest,
} from '../../packages/core/event-clustering'

/** App-local transport only. There is deliberately no web implementation,
 * Filesystem fallback, catalogue writer or account-sync dependency. */
export type EventClusteringBridge = {
  pickRawDumpRoot(): Promise<unknown>
  getRawDumpStatus(): Promise<unknown>
  scanRawDumpEvents(options: { force: boolean }): Promise<unknown>
  clearRawDumpRoot(): Promise<unknown>
  getEventAssetImage(options: EventAssetRequest): Promise<unknown>
  cancelEventAssetImage(options: { ids: string[] }): Promise<unknown>
  releaseEventAssetImages(options: { urls: string[] }): Promise<unknown>
  setEventCloudDownload(options: { enabled: boolean }): Promise<unknown>
  presentLimitedLibraryPicker(): Promise<unknown>
  openEventPhotosSettings(): Promise<unknown>
  openEventAssetInPhotos(options: { id: string }): Promise<unknown>
  addListener(event: string, listener: (payload: unknown) => void): Promise<PluginListenerHandle>
}

export type EventPhoto = EventAssetImage & { src: string | null }

export const createEventClustering = (
  bridge: EventClusteringBridge,
  convertFileSrc: (url: string) => string = Capacitor.convertFileSrc,
) => {
  let generation = 0
  const active = new Set<string>()
  const owned = new Set<string>()
  const requireIds = (ids: string[]) => {
    if (!isEventAssetRequest({ ids, purpose: 'viewer' })) throw new Error('Invalid event photograph identifiers')
  }
  const release = async (urls: string[]) => {
    const valid = urls.filter(isEventAssetFileUrl)
    for (let start = 0; start < valid.length; start += 64) {
      const batch = valid.slice(start, start + 64)
      await bridge.releaseEventAssetImages({ urls: batch })
      for (const url of batch) owned.delete(url)
    }
  }
  return {
    async status() { return parseRawDumpStatus(await bridge.getRawDumpStatus()) },
    async pick() { return parseRawDumpPick(await bridge.pickRawDumpRoot()) },
    async scan(force = false) { return parseRawDumpScanResult(await bridge.scanRawDumpEvents({ force })) },
    async clear() {
      generation++
      active.clear()
      await bridge.clearRawDumpRoot()
      owned.clear()
    },
    async images(request: EventAssetRequest): Promise<EventPhoto[]> {
      if (!isEventAssetRequest(request)) throw new Error('Invalid event photograph request')
      const token = generation
      if (request.purpose === 'viewer') for (const id of request.ids) active.add(id)
      const raw = await bridge.getEventAssetImage({ ...request, allowNetwork: request.allowNetwork === true })
      const items = parseEventAssetImages(raw, request.ids)
      if (!items) throw new Error('The event photograph reply could not be read')
      const isThumbnail = (url: string) => url.includes('/Caches/event-thumbs/') || url.includes('/cache/event-thumbs/')
      if (items.some((item) => item.url && (isThumbnail(item.url) !== (request.purpose === 'thumbnail')))) {
        await release(items.flatMap((item) => item.url ? [item.url] : []))
        throw new Error('The event photograph reply has the wrong rendition')
      }
      if (token !== generation) {
        await release(items.flatMap((item) => item.url ? [item.url] : []))
        throw new Error('Event photograph request cancelled')
      }
      if (request.purpose === 'viewer') for (const item of items) {
        if (item.url) owned.add(item.url)
        if (item.state !== 'downloading') active.delete(item.id)
      }
      return items.map((item) => ({ ...item, src: item.url ? convertFileSrc(item.url) : null }))
    },
    async cancel(ids: string[]) {
      requireIds(ids)
      generation++
      for (const id of ids) active.delete(id)
      await bridge.cancelEventAssetImage({ ids })
    },
    release,
    async close() {
      generation++
      const ids = [...active]
      active.clear()
      for (let start = 0; start < ids.length; start += 64) await bridge.cancelEventAssetImage({ ids: ids.slice(start, start + 64) })
      await release([...owned])
    },
    async progress(listener: (value: EventAssetProgress) => void) {
      return bridge.addListener('eventAssetProgress', (raw) => {
        const value = parseEventAssetProgress(raw)
        if (value && active.has(value.id)) listener(value)
      })
    },
    async changes(listener: () => void) {
      return bridge.addListener('eventLibraryChanged', (raw) => {
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) listener()
      })
    },
    async setDownload(enabled: boolean) { await bridge.setEventCloudDownload({ enabled }) },
    async limitedPicker() { await bridge.presentLimitedLibraryPicker() },
    async settings() { await bridge.openEventPhotosSettings() },
    async photos(id: string) {
      if (!isEventAssetId(id)) throw new Error('Invalid event photograph identifier')
      await bridge.openEventAssetInPhotos({ id })
    },
  }
}

export type EventClusteringClient = ReturnType<typeof createEventClustering>
let client: EventClusteringClient | undefined
export const eventClusteringClient = (): EventClusteringClient =>
  client ??= createEventClustering(registerPlugin<EventClusteringBridge>('EventClustering'))

/** Native is a privacy boundary, not an iOS check. Support itself is probed
 * by a validated cheap reply, so another Capacitor shell can light up later. */
export const isEventClusteringAvailable = async (injected?: EventClusteringClient): Promise<boolean> => {
  if (!injected && !Capacitor.isNativePlatform()) return false
  try { return (await (injected ?? eventClusteringClient()).status()) !== null } catch { return false }
}
