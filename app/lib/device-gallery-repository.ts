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

/* A stored link only counts while its gallery is live: reads hide links to
   deleted or expired galleries — the same read-time expiry evaluation the
   rest of the API applies, no sweeper. Deleting a gallery also clears the
   stored slug (see clearDeviceGalleryLink), so an expired link that stays
   hidden is either re-armed by renewal or dies with its gallery — a new
   gallery reusing the slug cannot inherit it. */
const DEVICE_GALLERY_SELECT = `SELECT d.id, d.title, d.source_kind, d.item_count, d.device_id, d.device_label,
  CASE WHEN d.public_gallery_slug IS NOT NULL AND g.slug IS NOT NULL
    AND (g.retention != 'pipeline' OR g.expires_at IS NULL OR g.expires_at > ?)
    THEN d.public_gallery_slug ELSE NULL END AS public_gallery_slug,
  d.updated_at
  FROM device_galleries d
  LEFT JOIN galleries g ON g.owner_id = d.owner_id AND g.slug = d.public_gallery_slug`

export const listDeviceGalleries = async (ownerId: string, env?: DeviceGalleryEnv): Promise<DeviceGallery[]> => {
  const db = requireDb(env)
  const result = await db
    .prepare(`${DEVICE_GALLERY_SELECT} WHERE d.owner_id = ? ORDER BY d.updated_at DESC, d.id ASC`)
    .bind(new Date().toISOString(), ownerId)
    .all<DeviceGalleryRow>()
  return (result.results ?? []).map(rowToDeviceGallery)
}

export const putDeviceGallery = async (ownerId: string, id: string, input: DeviceGalleryInput, env?: DeviceGalleryEnv): Promise<DeviceGallery> => {
  const db = requireDb(env)
  const updatedAt = new Date().toISOString()
  await db
    // public_gallery_slug is COALESCE'd, not overwritten: a routine sync
    // PUT omits the field (parseDeviceGalleryInput leaves it undefined →
    // NULL here), and wiping a linked slug would unlink a published
    // gallery every sync. A real slug in the payload still applies.
    .prepare('INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, device_label, public_gallery_slug, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO UPDATE SET title = excluded.title, source_kind = excluded.source_kind, item_count = excluded.item_count, device_id = excluded.device_id, device_label = excluded.device_label, public_gallery_slug = COALESCE(excluded.public_gallery_slug, device_galleries.public_gallery_slug), updated_at = excluded.updated_at')
    .bind(ownerId, id, input.title, input.sourceKind, input.itemCount, input.deviceId, input.deviceLabel, input.publicGallerySlug ?? null, updatedAt)
    .run()
  // Answer the stored row, not the input echo — a slug the upsert just
  // preserved belongs in the response too.
  const row = await db
    .prepare(`${DEVICE_GALLERY_SELECT} WHERE d.owner_id = ? AND d.id = ?`)
    .bind(new Date().toISOString(), ownerId, id)
    .first<DeviceGalleryRow>()
  return row ? rowToDeviceGallery(row) : { id, ...input, updatedAt }
}

/* The link binds to the gallery that was published, not to its name: when
   that row goes, the stored slug goes with it. A later gallery reusing the
   slug must re-link through linkDeviceGallery on publish — it never
   inherits a link it did not make. */
export const clearDeviceGalleryLink = async (db: D1Database, ownerId: string, slug: string): Promise<void> => {
  await db
    .prepare('UPDATE device_galleries SET public_gallery_slug = NULL WHERE owner_id = ? AND public_gallery_slug = ?')
    .bind(ownerId, slug)
    .run()
}

export const deleteDeviceGallery = async (ownerId: string, id: string, env?: DeviceGalleryEnv): Promise<boolean> => {
  const db = requireDb(env)
  const result = await db
    .prepare('DELETE FROM device_galleries WHERE owner_id = ? AND id = ?')
    .bind(ownerId, id)
    .run()
  return (result.meta.changes ?? 0) > 0
}
