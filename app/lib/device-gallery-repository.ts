import type { D1Database } from '@cloudflare/workers-types'
import type { DeviceGallery, DeviceGalleryInput } from '../../packages/core/device-gallery'

export type DeviceGalleryEnv = { DB?: D1Database }

const requireDb = (env?: DeviceGalleryEnv): D1Database => {
  if (!env?.DB) throw new Error('Device galleries require the D1 database binding')
  return env.DB
}

type DeviceGalleryRow = {
  id: string
  title: string
  source_kind: string
  item_count: number
  device_id: string
  device_label: string
  public_gallery_slug: string | null
  updated_at: string
}

const rowToDeviceGallery = (row: DeviceGalleryRow): DeviceGallery => {
  const gallery: DeviceGallery = {
    id: row.id,
    title: row.title,
    sourceKind: row.source_kind === 'card' ? 'card' : 'folder',
    itemCount: row.item_count,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    updatedAt: row.updated_at,
  }
  if (row.public_gallery_slug) gallery.publicGallerySlug = row.public_gallery_slug
  return gallery
}

export const listDeviceGalleries = async (ownerId: string, env?: DeviceGalleryEnv): Promise<DeviceGallery[]> => {
  const db = requireDb(env)
  const result = await db
    .prepare('SELECT id, title, source_kind, item_count, device_id, device_label, public_gallery_slug, updated_at FROM device_galleries WHERE owner_id = ? ORDER BY updated_at DESC, id ASC')
    .bind(ownerId)
    .all<DeviceGalleryRow>()
  return (result.results ?? []).map(rowToDeviceGallery)
}

export const putDeviceGallery = async (ownerId: string, id: string, input: DeviceGalleryInput, env?: DeviceGalleryEnv): Promise<DeviceGallery> => {
  const db = requireDb(env)
  const updatedAt = new Date().toISOString()
  await db
    .prepare('INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, device_label, public_gallery_slug, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET title = excluded.title, source_kind = excluded.source_kind, item_count = excluded.item_count, device_id = excluded.device_id, device_label = excluded.device_label, public_gallery_slug = excluded.public_gallery_slug, updated_at = excluded.updated_at')
    .bind(ownerId, id, input.title, input.sourceKind, input.itemCount, input.deviceId, input.deviceLabel, input.publicGallerySlug ?? null, updatedAt)
    .run()
  return { id, ...input, updatedAt }
}

export const deleteDeviceGallery = async (ownerId: string, id: string, env?: DeviceGalleryEnv): Promise<boolean> => {
  const db = requireDb(env)
  const result = await db
    .prepare('DELETE FROM device_galleries WHERE owner_id = ? AND id = ?')
    .bind(ownerId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}
