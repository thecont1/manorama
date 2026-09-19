import type { D1Database } from '@cloudflare/workers-types'
import { isVideoItem, type GalleryMediaItem, type GalleryManifest } from './imagesource'
import { getUserByDropboxId } from './user-repository'
import {
  assertGalleryEditable,
  FREE_RETAINED_LIMIT,
  isGalleryExpired,
  PAID_RETAINED_LIMIT,
  paidGalleryLimitError,
  PIPELINE_LIFETIME_MS,
  type GalleryRetention,
} from './gallery-policy'

/**
 * Gallery storage. Every gallery belongs to exactly one owner (a Dropbox
 * account ID) — the composite key (owner_id, slug) means two owners can
 * independently use the same gallery slug. Public URLs resolve through
 * the owner first: /<owner_slug>/<gallery_slug>.
 *
 * D1 is the production store. Without the DB binding (vite dev, tests)
 * an in-memory store is used.
 */

export type GalleryRecord = GalleryManifest & {
  sourceUrl?: string
  createdAt?: string
  retention?: GalleryRetention
  expiresAt?: string | null
}

type GalleryRow = {
  slug: string
  title: string
  caption: string | null
  date: string | null
  source_url: string | null
  images_json: string | null
  created_at: string | null
  retention: string | null
  expires_at: string | null
}

export type GalleryEnv = { DB?: D1Database }

const runtimeGalleries = new Map<string, Map<string, GalleryRecord>>()

const d1Configured = (env?: GalleryEnv): env is GalleryEnv & { DB: D1Database } =>
  Boolean(env?.DB)

const ownerStore = (ownerId: string) => {
  let store = runtimeGalleries.get(ownerId)
  if (!store) {
    store = new Map<string, GalleryRecord>()
    runtimeGalleries.set(ownerId, store)
  }
  return store
}

const retentionOf = (gallery: { retention?: GalleryRetention }): GalleryRetention =>
  gallery.retention === 'pipeline' ? 'pipeline' : 'retained'

const normalizeRecord = (gallery: GalleryRecord): GalleryRecord => ({
  ...gallery,
  retention: retentionOf(gallery),
  expiresAt: gallery.expiresAt ?? null,
})

const rowToRecord = (row: GalleryRow | null): GalleryRecord | null => {
  if (!row || !row.slug) return null
  const gallery: GalleryRecord = {
    slug: row.slug,
    title: row.title || row.slug,
    caption: row.caption ?? '',
    date: row.date ?? '',
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at ?? undefined,
    retention: row.retention === 'pipeline' ? 'pipeline' : 'retained',
    expiresAt: row.expires_at ?? null,
    images: [],
  }
  if (row.images_json) {
    try {
      const images = JSON.parse(row.images_json) as GalleryMediaItem[]
      if (Array.isArray(images)) gallery.images = images
    } catch {
      // A malformed images payload yields an empty gallery, not a crash.
    }
  }
  return gallery
}

const GALLERY_COLUMNS = 'slug, title, caption, date, source_url, images_json, created_at, retention, expires_at'

type GalleryInsertRow = {
  slug: string
  title: string
  caption: string
  date: string
  source_url: string | null
  images_json: string
  created_at: string
}

const recordToRow = (gallery: GalleryRecord): GalleryInsertRow => ({
  slug: gallery.slug,
  title: gallery.title,
  caption: gallery.caption ?? '',
  date: gallery.date ?? '',
  source_url: gallery.sourceUrl ?? null,
  images_json: JSON.stringify(gallery.images),
  created_at: new Date(gallery.createdAt || Date.now()).toISOString(),
})

const sortRecent = (galleries: GalleryRecord[]) => galleries.sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

export const listGalleries = async (ownerId: string, env?: GalleryEnv): Promise<GalleryRecord[]> => {
  const now = new Date().toISOString()
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare(`SELECT ${GALLERY_COLUMNS} FROM galleries WHERE owner_id = ? AND (retention = 'retained' OR expires_at > ?)`)
      .bind(ownerId, now)
      .all<GalleryRow>()
    const external = (result.results ?? [])
      .map((row) => rowToRecord(row))
      .filter((item): item is GalleryRecord => (item?.images?.length ?? 0) > 0)
    return sortRecent(external)
  }
  return sortRecent(
    [...ownerStore(ownerId).values()]
      .map(normalizeRecord)
      .filter((gallery) => !isGalleryExpired(gallery, now)),
  )
}

export const getGallery = async (ownerId: string, slug: string, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const now = new Date().toISOString()
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare(`SELECT ${GALLERY_COLUMNS} FROM galleries WHERE owner_id = ? AND slug = ? AND (retention = 'retained' OR expires_at > ?)`)
      .bind(ownerId, slug, now)
      .first<GalleryRow>()
    const external = rowToRecord(row)
    return external && external.images.length > 0 ? external : null
  }
  const stored = ownerStore(ownerId).get(slug)
  if (!stored) return null
  const gallery = normalizeRecord(stored)
  return isGalleryExpired(gallery, now) ? null : gallery
}

export const getStoredGallery = async (ownerId: string, slug: string, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare(`SELECT ${GALLERY_COLUMNS} FROM galleries WHERE owner_id = ? AND slug = ?`)
      .bind(ownerId, slug)
      .first<GalleryRow>()
    return rowToRecord(row)
  }
  const stored = ownerStore(ownerId).get(slug)
  return stored ? normalizeRecord(stored) : null
}

export type CreateWithinLimitResult =
  | { readonly ok: true; readonly gallery: GalleryRecord }
  | { readonly ok: false; readonly reason: 'limit' | 'conflict' | 'duplicate-source' }

/** Atomically checks the free-tier limit and inserts the gallery in one D1
 *  statement, so concurrent requests cannot both pass the count check and
 *  exceed the limit. Returns `conflict` when the (owner_id, slug) key
 *  already exists, or `duplicate-source` when the (owner_id, source_url)
 *  unique index already holds that Dropbox folder. */
export const createGalleryWithinLimit = async (
  ownerId: string,
  gallery: GalleryRecord,
  env?: GalleryEnv,
): Promise<CreateWithinLimitResult> => {
  const row = recordToRow(gallery)
  const pipelineExpiresAt = new Date(Date.parse(row.created_at) + PIPELINE_LIFETIME_MS).toISOString()
  if (d1Configured(env)) {
    try {
      const stored = await env.DB.prepare(
        `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at, retention, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN tier = 'pro' OR retained_count < 3 THEN 'retained' ELSE 'pipeline' END,
          CASE WHEN tier = 'pro' OR retained_count < 3 THEN NULL ELSE ? END
         FROM (
          SELECT COALESCE((SELECT tier FROM users WHERE dropbox_account_id = ?), 'free') AS tier,
          (SELECT COUNT(*) FROM galleries WHERE owner_id = ? AND retention = 'retained') AS retained_count
         )
         WHERE tier != 'pro' OR retained_count < 99
         RETURNING slug, title, caption, date, source_url, images_json, created_at, retention, expires_at`,
      ).bind(row.slug, ownerId, row.title, row.caption, row.date, row.source_url, row.images_json, row.created_at, pipelineExpiresAt, ownerId, ownerId).first<GalleryRow>()
      if (!stored) return { ok: false, reason: 'limit' }
      return { ok: true, gallery: rowToRecord(stored)! }
    } catch (error) {
      const message = String(error)
      if (message.includes('galleries.owner_id, galleries.source_url')) return { ok: false, reason: 'duplicate-source' }
      if (message.includes('UNIQUE')) return { ok: false, reason: 'conflict' }
      throw error
    }
  }
  const user = await getUserByDropboxId(ownerId, env)
  const store = ownerStore(ownerId)
  if (store.has(row.slug)) return { ok: false, reason: 'conflict' }
  const records = [...store.values()]
  if (row.source_url && records.some((item) => item.sourceUrl === row.source_url)) {
    return { ok: false, reason: 'duplicate-source' }
  }
  const retainedCount = records.filter((item) => retentionOf(item) === 'retained').length
  const tier = user?.tier ?? 'free'
  if (tier === 'pro' && retainedCount >= PAID_RETAINED_LIMIT) return { ok: false, reason: 'limit' }
  const retention: GalleryRetention = tier === 'pro' || retainedCount < FREE_RETAINED_LIMIT ? 'retained' : 'pipeline'
  const stored: GalleryRecord = {
    ...gallery,
    slug: row.slug,
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at,
    retention,
    expiresAt: retention === 'pipeline' ? pipelineExpiresAt : null,
  }
  store.set(row.slug, stored)
  return { ok: true, gallery: stored }
}

export const createGallery = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord> => {
  const result = await createGalleryWithinLimit(ownerId, gallery, env)
  if (result.ok) return result.gallery
  if (result.reason === 'limit') throw paidGalleryLimitError()
  if (result.reason === 'duplicate-source') throw new Error('A gallery from that link already exists')
  throw new Error('That gallery URL is already in use')
}

/** Updates an existing gallery row in place via an atomic D1 UPDATE (no
 *  create-then-delete). Returns null when no row matches. */
export const updateGalleryRecord = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, gallery.slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const row = recordToRow(gallery)
    const result = await env.DB.prepare(
      `UPDATE galleries SET title = ?, caption = ?, date = ?, source_url = ?, images_json = ?
       WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(row.title, row.caption, row.date, row.source_url, row.images_json, ownerId, gallery.slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return { ...gallery, createdAt: current.createdAt, retention: current.retention, expiresAt: current.expiresAt }
  }
  const store = ownerStore(ownerId)
  const current = store.get(gallery.slug)
  if (!current) return null
  assertGalleryEditable(current)
  const updated: GalleryRecord = {
    ...gallery,
    createdAt: current.createdAt,
    retention: retentionOf(current),
    expiresAt: current.expiresAt ?? null,
  }
  store.set(gallery.slug, updated)
  return updated
}

/** Updates only the images_json column of an existing gallery, leaving
 *  metadata (title, caption, date) untouched. Used by the refresh flow so
 *  a concurrent metadata change is not overwritten with stale read data. */
export const updateGalleryImages = async (ownerId: string, slug: string, images: readonly GalleryMediaItem[], env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const imagesJson = JSON.stringify(images)
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const result = await env.DB.prepare(
      `UPDATE galleries SET images_json = ? WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(imagesJson, ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getGallery(ownerId, slug, env)
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  const updated = { ...normalizeRecord(current), images: [...images] }
  store.set(slug, updated)
  return updated
}

export const updateGalleryMetadata = async (ownerId: string, slug: string, patch: { title?: string; caption?: string }, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
    if (patch.caption !== undefined) { sets.push('caption = ?'); params.push(patch.caption) }
    if (sets.length === 0) return current
    params.push(ownerId, slug)
    const result = await env.DB.prepare(
      `UPDATE galleries SET ${sets.join(', ')} WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(...params).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getGallery(ownerId, slug, env)
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  const updated: GalleryRecord = {
    ...normalizeRecord(current),
    title: patch.title ?? current.title,
    caption: patch.caption ?? current.caption,
    createdAt: current.createdAt || new Date().toISOString(),
  }
  store.set(slug, updated)
  return updated
}

export const updateGallerySlug = async (ownerId: string, slug: string, nextSlug: string, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    if (slug === nextSlug) return current
    try {
      const result = await env.DB.prepare(
        `UPDATE galleries SET slug = ? WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
      ).bind(nextSlug, ownerId, slug).run()
      if ((result.meta.changes ?? 0) === 0) return null
      return getGallery(ownerId, nextSlug, env)
    } catch (error) {
      // UNIQUE constraint violation on (owner_id, slug) — another gallery
      // already holds the target slug.
      if (String(error).includes('UNIQUE')) throw new Error('That gallery URL is already in use')
      throw error
    }
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  if (slug === nextSlug) return normalizeRecord(current)
  if (store.has(nextSlug)) throw new Error('That gallery URL is already in use')
  const nextGallery = { ...normalizeRecord(current), slug: nextSlug }
  store.delete(slug)
  store.set(nextSlug, nextGallery)
  return nextGallery
}

/** Order/dedupe key: `ref` when the provider gives a stable item ID
 *  (Drive file ID, iCloud photo GUID), else the filename (Dropbox names
 *  are unique per folder). Identical for images and videos — a mixed
 *  gallery orders and dedupes through exactly one key path. */
const imageKey = (image: GalleryMediaItem) => image.ref ?? image.filename

export const updateGalleryOrder = async (ownerId: string, slug: string, order: string[], env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const reorder = (current: GalleryRecord) => {
    const byKey = new Map(current.images.map((image) => [imageKey(image), image]))
    const reordered = order.map((key) => byKey.get(key)).filter((image): image is GalleryMediaItem => Boolean(image))
    const seen = new Set(reordered.map(imageKey))
    current.images.forEach((image) => { if (!seen.has(imageKey(image))) reordered.push(image) })
    return reordered
  }
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const reordered = reorder(current)
    const result = await env.DB.prepare(
      `UPDATE galleries SET images_json = ? WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(JSON.stringify(reordered), ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return { ...current, images: reordered }
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  const reordered = reorder(current)
  const updated = { ...normalizeRecord(current), images: reordered }
  store.set(slug, updated)
  return updated
}

/** The trimmed item shape the admin dashboard receives. Video entries
 *  additionally carry `type`, `durationSeconds` and `poster` so the rail
 *  can badge them; image entries are byte-identical to before — no `type`
 *  key is invented for them. */
const previewImages = (images: readonly GalleryMediaItem[]) => images.map((image) => {
  const { id, ref, filename, src, width, height, alt, placeholder, variants } = image
  const base = { id, ref, filename, src, width, height, alt, placeholder, variants }
  return isVideoItem(image)
    ? { ...base, type: 'video' as const, durationSeconds: image.durationSeconds, poster: image.poster }
    : base
})

export const deleteGallery = async (ownerId: string, slug: string, env?: GalleryEnv, options?: { force?: boolean }): Promise<boolean> => {
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare('DELETE FROM galleries WHERE owner_id = ? AND slug = ?')
      .bind(ownerId, slug)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
  return ownerStore(ownerId).delete(slug)
}

export const countGalleries = async (ownerId: string, env?: GalleryEnv): Promise<number> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM galleries WHERE owner_id = ? AND retention = 'retained'")
      .bind(ownerId)
      .first<{ count: number }>()
    return row?.count ?? 0
  }
  return [...ownerStore(ownerId).values()].filter((gallery) => retentionOf(gallery) === 'retained').length
}

export const promotePipelineGalleries = async (ownerId: string, now: string, env?: GalleryEnv): Promise<number> => {
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      `UPDATE galleries SET retention = 'retained', expires_at = NULL WHERE owner_id = ? AND retention = 'pipeline' AND expires_at > ?`,
    ).bind(ownerId, now).run()
    return result.meta.changes ?? 0
  }
  let promoted = 0
  const store = runtimeGalleries.get(ownerId)
  if (!store) return 0
  for (const gallery of store.values()) {
    if (retentionOf(gallery) === 'pipeline' && gallery.expiresAt && gallery.expiresAt > now) {
      gallery.retention = 'retained'
      gallery.expiresAt = null
      promoted += 1
    }
  }
  return promoted
}

export type ExpiredGalleryKey = { ownerId: string; slug: string; expiresAt: string }

const compareExpiryKeys = (a: ExpiredGalleryKey, b: ExpiredGalleryKey) =>
  a.expiresAt < b.expiresAt ? -1
    : a.expiresAt > b.expiresAt ? 1
      : a.ownerId < b.ownerId ? -1
        : a.ownerId > b.ownerId ? 1
          : a.slug < b.slug ? -1
            : a.slug > b.slug ? 1
              : 0

export const listExpiredPipelineGalleries = async (
  now: string,
  env?: GalleryEnv,
  after?: ExpiredGalleryKey,
  limit = 100,
): Promise<ExpiredGalleryKey[]> => {
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      `SELECT owner_id, slug, expires_at FROM galleries
       WHERE retention = 'pipeline' AND expires_at <= ?
       AND (expires_at, owner_id, slug) > (?, ?, ?)
       ORDER BY expires_at, owner_id, slug LIMIT ?`,
    ).bind(now, after?.expiresAt ?? '', after?.ownerId ?? '', after?.slug ?? '', limit)
      .all<{ owner_id: string; slug: string; expires_at: string }>()
    return (result.results ?? []).map((row) => ({ ownerId: row.owner_id, slug: row.slug, expiresAt: row.expires_at }))
  }
  const expired: ExpiredGalleryKey[] = []
  for (const [owner, store] of runtimeGalleries) {
    for (const gallery of store.values()) {
      if (retentionOf(gallery) === 'pipeline' && gallery.expiresAt && gallery.expiresAt <= now) {
        expired.push({ ownerId: owner, slug: gallery.slug, expiresAt: gallery.expiresAt })
      }
    }
  }
  expired.sort(compareExpiryKeys)
  const rest = after ? expired.filter((key) => compareExpiryKeys(key, after) > 0) : expired
  return rest.slice(0, limit)
}

export const deleteExpiredPipelineGallery = async (key: ExpiredGalleryKey, now: string, env?: GalleryEnv): Promise<boolean> => {
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      `DELETE FROM galleries WHERE owner_id = ? AND slug = ? AND retention = 'pipeline' AND expires_at <= ? AND expires_at = ?`,
    ).bind(key.ownerId, key.slug, now, key.expiresAt).run()
    return (result.meta.changes ?? 0) > 0
  }
  const current = ownerStore(key.ownerId).get(key.slug)
  if (!current || retentionOf(current) !== 'pipeline') return false
  if (!current.expiresAt || current.expiresAt !== key.expiresAt || current.expiresAt > now) return false
  return ownerStore(key.ownerId).delete(key.slug)
}

export const toSummary = (gallery: GalleryRecord) => ({ slug: gallery.slug, title: gallery.title, caption: gallery.caption, date: gallery.date, imageCount: gallery.images.length, sourceUrl: gallery.sourceUrl, createdAt: gallery.createdAt, retention: retentionOf(gallery), expiresAt: gallery.expiresAt ?? null, images: previewImages(gallery.images) })
export type GallerySummary = ReturnType<typeof toSummary>

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetGalleryStore = () => runtimeGalleries.clear()
