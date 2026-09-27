import { parseDeviceGalleryInput, type DeviceGalleryInput } from '../../packages/core/device-gallery'
import type { LocalGalleryItem } from './local-scan'

/**
 * The local gallery catalogue — the on-device record of every root the
 * user has opened. It lives in `catalogue.json` inside the app config dir
 * (written by the private-store commands at 0600) and is the ONLY place
 * paths exist. The sync payload is built by `deviceGalleryInput`, which
 * emits exactly the fields the server parses — paths and file lists can
 * never leak into it because they are not part of the shape.
 */

export const LOCAL_CATALOGUE_VERSION = 1

export type LocalGalleryRecord = {
  /** UUID — becomes the row id in PUT /api/device-galleries/:id. */
  id: string
  title: string
  /** Absolute path of the picked root. Local-only by contract. */
  rootPath: string
  sourceKind: 'folder' | 'card'
  /** Volume root (e.g. /Volumes/CARD) when the source is a mounted card. */
  mountPoint?: string
  itemCount: number
  items: LocalGalleryItem[]
  addedAt: string
  lastSeenAt: string
}

export type LocalCatalogue = {
  version: number
  /** Install-stable UUID for the deviceId field of every sync record. */
  deviceId: string
  deviceLabel: string
  galleries: LocalGalleryRecord[]
}

export type GalleryAvailability = 'available' | 'unavailable'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const newCatalogue = (deviceId: string, deviceLabel: string): LocalCatalogue => ({
  version: LOCAL_CATALOGUE_VERSION,
  deviceId,
  deviceLabel,
  galleries: [],
})

const parseItem = (value: unknown): LocalGalleryItem | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.name !== 'string' || !item.name) return null
  if (typeof item.path !== 'string' || !item.path) return null
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    ...(typeof item.width === 'number' && item.width > 0 ? { width: item.width } : {}),
    ...(typeof item.height === 'number' && item.height > 0 ? { height: item.height } : {}),
  }
}

const parseRecord = (value: unknown): LocalGalleryRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !UUID_PATTERN.test(record.id)) return null
  if (typeof record.title !== 'string' || !record.title) return null
  if (typeof record.rootPath !== 'string' || !record.rootPath) return null
  if (record.sourceKind !== 'folder' && record.sourceKind !== 'card') return null
  if (!Array.isArray(record.items)) return null
  const items = record.items.map(parseItem)
  if (items.some((item) => item === null)) return null
  const count = typeof record.itemCount === 'number' && Number.isInteger(record.itemCount) && record.itemCount >= 0
    ? record.itemCount
    : items.length
  return {
    id: record.id,
    title: record.title,
    rootPath: record.rootPath,
    sourceKind: record.sourceKind,
    ...(typeof record.mountPoint === 'string' && record.mountPoint ? { mountPoint: record.mountPoint } : {}),
    itemCount: count,
    items: items as LocalGalleryItem[],
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : '',
  }
}

/** Defensive deserialize: a corrupt catalogue degrades to an empty one
 *  rather than failing the launch — the folders are still on disk and a
 *  re-pick rebuilds the record. */
export const parseLocalCatalogue = (value: unknown): LocalCatalogue | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.version !== LOCAL_CATALOGUE_VERSION) return null
  if (typeof body.deviceId !== 'string' || !UUID_PATTERN.test(body.deviceId)) return null
  if (typeof body.deviceLabel !== 'string' || !body.deviceLabel) return null
  if (!Array.isArray(body.galleries)) return null
  const galleries = body.galleries.map(parseRecord)
  if (galleries.some((gallery) => gallery === null)) return null
  return {
    version: LOCAL_CATALOGUE_VERSION,
    deviceId: body.deviceId,
    deviceLabel: body.deviceLabel,
    galleries: galleries as LocalGalleryRecord[],
  }
}

export const serializeLocalCatalogue = (catalogue: LocalCatalogue): string =>
  JSON.stringify(catalogue)

export const deserializeLocalCatalogue = (contents: string | null | undefined): LocalCatalogue | null => {
  if (!contents) return null
  try {
    return parseLocalCatalogue(JSON.parse(contents))
  } catch {
    return null
  }
}

/**
 * Eject/mount transitions. `exists` probes the record's root (and the card
 * mount point when one is known); a missing source flips the record to
 * 'unavailable' and a returning one flips it back — the record itself is
 * never deleted either way.
 */
export const probeAvailability = async (
  record: LocalGalleryRecord,
  exists: (path: string) => Promise<boolean>,
): Promise<GalleryAvailability> => {
  try {
    if (await exists(record.rootPath)) return 'available'
  } catch {
    // A probe error is indistinguishable from an absent source.
  }
  return 'unavailable'
}

export const probeAllAvailability = async (
  records: readonly LocalGalleryRecord[],
  exists: (path: string) => Promise<boolean>,
): Promise<Record<string, GalleryAvailability>> => {
  const result: Record<string, GalleryAvailability> = {}
  for (const record of records) {
    result[record.id] = await probeAvailability(record, exists)
  }
  return result
}

/**
 * The sync projection — the ONLY shape that crosses the network. It has no
 * slot for a path, a filename, or bytes: adding one would fail
 * `parseDeviceGalleryInput` on the server side by design.
 */
export const deviceGalleryInput = (
  record: LocalGalleryRecord,
  catalogue: LocalCatalogue,
): DeviceGalleryInput => ({
  title: record.title,
  sourceKind: record.sourceKind,
  itemCount: record.itemCount,
  deviceId: catalogue.deviceId,
  deviceLabel: catalogue.deviceLabel,
})

/** The request descriptor for one record — kept pure so tests can assert
 *  the wire shape without a fetch. */
export const deviceGalleryRequest = (
  apiBase: string,
  record: LocalGalleryRecord,
  catalogue: LocalCatalogue,
): { method: 'PUT'; url: string; body: DeviceGalleryInput } => ({
  method: 'PUT',
  url: `${apiBase.replace(/\/+$/, '')}/api/device-galleries/${record.id}`,
  body: deviceGalleryInput(record, catalogue),
})

export { parseDeviceGalleryInput }
