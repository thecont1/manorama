import type { D1Database } from '@cloudflare/workers-types'
import { libraryLayout } from '../../packages/core/library-layout'
import { isVideoItem, mediaCountOf, type GalleryMediaItem, type GalleryManifest } from './imagesource'
import { getUserByAccountId } from './user-repository'
import { clearDeviceGalleryLink } from './device-gallery-repository'
import {
  assertGalleryEditable,
  FREE_RETAINED_LIMIT,
  GalleryPolicyError,
  isGalleryExpired,
  PAID_RETAINED_LIMIT,
  paidGalleryLimitError,
  PIPELINE_LIFETIME_MS,
  type GalleryRetention,
} from './gallery-policy'
import type { AccountTier } from '../../packages/core/account'

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
  /** Random immutable identity for client-held keys; optional only while
   *  reading pre-0013 records and constructing legacy test fixtures. */
  id?: string
  manifestVersion?: number
  sourceUrl?: string
  createdAt?: string
  retention?: GalleryRetention
  expiresAt?: string | null
  pinnedAt?: string | null
  keyRetiredAt?: string | null
  migrationDevices?: string[]
}

type GalleryRow = {
  id: string | null
  manifest_version: number | null
  slug: string
  title: string
  caption: string | null
  date: string | null
  source_url: string | null
  images_json: string | null
  created_at: string | null
  retention: string | null
  expires_at: string | null
  pinned_at: string | null
  key_retired_at: string | null
  migration_devices: string | null
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

export const retentionOf = (gallery: { retention?: GalleryRetention }): GalleryRetention =>
  gallery.retention === 'pipeline' ? 'pipeline' : 'retained'

const normalizeRecord = (gallery: GalleryRecord): GalleryRecord => ({
  ...gallery,
  retention: retentionOf(gallery),
  expiresAt: gallery.expiresAt ?? null,
  pinnedAt: gallery.pinnedAt ?? null,
  keyRetiredAt: gallery.keyRetiredAt ?? null,
  migrationDevices: gallery.migrationDevices ?? [],
})

const rowToRecord = (row: GalleryRow | null): GalleryRecord | null => {
  if (!row || !row.slug) return null
  const gallery: GalleryRecord = {
    id: row.id ?? undefined,
    manifestVersion: row.manifest_version ?? 1,
    slug: row.slug,
    title: row.title || row.slug,
    caption: row.caption ?? '',
    date: row.date ?? '',
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at ?? undefined,
    retention: row.retention === 'pipeline' ? 'pipeline' : 'retained',
    expiresAt: row.expires_at ?? null,
    pinnedAt: row.pinned_at ?? null,
    keyRetiredAt: row.key_retired_at ?? null,
    migrationDevices: JSON.parse(row.migration_devices || '[]') as string[],
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

const GALLERY_COLUMNS = 'id, manifest_version, slug, title, caption, date, source_url, images_json, created_at, retention, expires_at, pinned_at, key_retired_at, migration_devices'

type GalleryInsertRow = {
  id: string
  manifest_version: number
  slug: string
  title: string
  caption: string
  date: string
  source_url: string | null
  images_json: string
  created_at: string
  key_retired_at: string | null
  migration_devices: string
}

/** D1's row ceiling is the real constraint — the 1,000-item cap alone
 *  allows ~33 MB of worst-case exif/placeholder. 1.8 MB leaves headroom
 *  under the ~2 MB row limit for the row's other columns. */
export const MANIFEST_IMAGES_MAX_BYTES = 1_800_000
const manifestImagesJson = (images: readonly GalleryMediaItem[]): string => {
  const json = JSON.stringify(images)
  // D1's row limit is in UTF-8 bytes — json.length undercounts multibyte
  // metadata and would let an oversized row through.
  if (new TextEncoder().encode(json).byteLength > MANIFEST_IMAGES_MAX_BYTES) {
    throw new GalleryPolicyError('MANIFEST_TOO_LARGE', 'That manifest is too large to store — reduce the number of items or their metadata')
  }
  return json
}

const recordToRow = (gallery: GalleryRecord): GalleryInsertRow => ({
  id: gallery.id ?? crypto.randomUUID(),
  manifest_version: gallery.manifestVersion ?? 1,
  slug: gallery.slug,
  title: gallery.title,
  caption: gallery.caption ?? '',
  date: gallery.date ?? '',
  source_url: gallery.sourceUrl ?? null,
  images_json: manifestImagesJson(gallery.images),
  created_at: new Date(gallery.createdAt || Date.now()).toISOString(),
  key_retired_at: gallery.keyRetiredAt ?? null,
  migration_devices: JSON.stringify(gallery.migrationDevices ?? []),
})

const sortRecent = (galleries: GalleryRecord[]) => galleries.sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

/** Lists an owner's retained and unexpired pipeline galleries, newest first. */
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

/** Finds a visible gallery, treating an expired pipeline gallery as missing. */
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

/** Reads a stored gallery without applying the pipeline-expiration filter. */
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

/** Applies the account's retention policy and inserts the gallery atomically.
 *  Free accounts retain their first three galleries and receive 30-day
 *  pipeline galleries thereafter; paid accounts retain galleries up to the
 *  99-gallery cap. Returns `conflict` for an occupied owner/slug pair,
 *  `duplicate-source` for a reused owner/source URL, or `limit` at the paid
 *  cap. */
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
        `INSERT INTO galleries (id, manifest_version, slug, owner_id, title, caption, date, source_url, images_json, created_at, retention, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN tier = 'pro' OR retained_count < 3 THEN 'retained' ELSE 'pipeline' END,
          CASE WHEN tier = 'pro' OR retained_count < 3 THEN NULL ELSE ? END
         FROM (
          SELECT COALESCE((SELECT tier FROM users WHERE account_id = ?), 'free') AS tier,
          (SELECT COUNT(*) FROM galleries WHERE owner_id = ? AND retention = 'retained') AS retained_count
         )
         WHERE tier != 'pro' OR retained_count < 99
         RETURNING ${GALLERY_COLUMNS}`,
      ).bind(row.id, row.manifest_version, row.slug, ownerId, row.title, row.caption, row.date, row.source_url, row.images_json, row.created_at, pipelineExpiresAt, ownerId, ownerId).first<GalleryRow>()
      if (!stored) return { ok: false, reason: 'limit' }
      return { ok: true, gallery: rowToRecord(stored)! }
    } catch (error) {
      const message = String(error)
      if (message.includes('galleries.owner_id, galleries.source_url')) return { ok: false, reason: 'duplicate-source' }
      if (message.includes('UNIQUE')) return { ok: false, reason: 'conflict' }
      throw error
    }
  }
  const user = await getUserByAccountId(ownerId, env)
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
    id: row.id,
    manifestVersion: row.manifest_version,
    slug: row.slug,
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at,
    retention,
    expiresAt: retention === 'pipeline' ? pipelineExpiresAt : null,
  }
  store.set(row.slug, stored)
  return { ok: true, gallery: stored }
}

/** Creates a gallery under the retention policy. Throws a typed limit error at
 *  the paid cap and an Error when the owner already uses its slug or source. */
export const createGallery = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord> => {
  const result = await createGalleryWithinLimit(ownerId, gallery, env)
  if (result.ok) return result.gallery
  if (result.reason === 'limit') throw paidGalleryLimitError()
  if (result.reason === 'duplicate-source') throw new Error('A gallery from that link already exists')
  throw new Error('That gallery URL is already in use')
}

/** Updates an existing gallery row in place via an atomic D1 UPDATE (no
 *  create-then-delete). When `expected.migrationDevices` is supplied the
 *  write is conditional on migration_devices still holding that snapshot —
 *  the state the caller's verified-device union was built from — so two
 *  devices migrating concurrently cannot silently drop each other. A
 *  conditional miss returns null like a missing row; callers that need the
 *  distinction re-read before retrying. Returns null when no row matches
 *  and throws a typed read-only error for pipeline galleries. */
export const updateGalleryRecord = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv, expected?: { migrationDevices?: string[] }): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, gallery.slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const row = recordToRow({
      ...gallery,
      manifestVersion: gallery.manifestVersion ?? current.manifestVersion,
      keyRetiredAt: gallery.keyRetiredAt ?? current.keyRetiredAt,
      migrationDevices: gallery.migrationDevices ?? current.migrationDevices,
    })
    const result = await env.DB.prepare(
      `UPDATE galleries SET manifest_version = ?, title = ?, caption = ?, date = ?, source_url = ?, images_json = ?, key_retired_at = ?, migration_devices = ?
       WHERE owner_id = ? AND slug = ? AND retention = 'retained'${expected ? ' AND migration_devices = ?' : ''}`,
    ).bind(row.manifest_version, row.title, row.caption, row.date, row.source_url, row.images_json, row.key_retired_at, row.migration_devices, ownerId, gallery.slug, ...(expected ? [JSON.stringify(expected.migrationDevices ?? [])] : [])).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getStoredGallery(ownerId, gallery.slug, env)
  }
  const store = ownerStore(ownerId)
  const current = store.get(gallery.slug)
  if (!current) return null
  assertGalleryEditable(current)
  if (expected && JSON.stringify(current.migrationDevices ?? []) !== JSON.stringify(expected.migrationDevices ?? [])) return null
  const updated: GalleryRecord = {
    ...gallery,
    id: current.id,
    manifestVersion: gallery.manifestVersion ?? current.manifestVersion,
    keyRetiredAt: gallery.keyRetiredAt ?? current.keyRetiredAt ?? null,
    migrationDevices: gallery.migrationDevices ?? current.migrationDevices ?? [],
    createdAt: current.createdAt,
    retention: retentionOf(current),
    expiresAt: current.expiresAt ?? null,
  }
  store.set(gallery.slug, updated)
  return updated
}

/** Updates only the images_json column of an existing gallery, leaving
 *  metadata (title, caption, date) untouched. Used by the refresh flow so
 *  a concurrent metadata change is not overwritten with stale read data.
 *  manifestVersion is written only when a caller supplies it — a refresh
 *  that persisted a client-scanned manifest promotes the gallery to it.
 *  Throws a typed read-only error for pipeline galleries. */
export const updateGalleryImages = async (ownerId: string, slug: string, images: readonly GalleryMediaItem[], env?: GalleryEnv, manifestVersion?: number): Promise<GalleryRecord | null> => {
  const imagesJson = manifestImagesJson(images)
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const sets = manifestVersion === undefined ? 'images_json = ?' : 'images_json = ?, manifest_version = ?'
    const binds = manifestVersion === undefined ? [imagesJson] : [imagesJson, manifestVersion]
    const result = await env.DB.prepare(
      `UPDATE galleries SET ${sets} WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(...binds, ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getGallery(ownerId, slug, env)
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  const updated = { ...normalizeRecord(current), images: [...images], ...(manifestVersion === undefined ? {} : { manifestVersion }) }
  store.set(slug, updated)
  return updated
}

/** Applies supplied title or caption fields to a retained gallery. Returns null
 *  when the gallery is missing and throws a typed error when it is read-only. */
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

/** Renames a retained gallery. Returns null when it is missing and throws when
 *  the gallery is read-only or the owner already uses the target slug. */
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
      // The rename frees the old name: device links follow the gallery to
      // its new slug rather than staying behind for a stranger to inherit.
      await env.DB.prepare(
        `UPDATE device_galleries SET public_gallery_slug = ? WHERE owner_id = ? AND public_gallery_slug = ?`,
      ).bind(nextSlug, ownerId, slug).run()
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

/** Sets or clears the pinned timestamp — a display choice only. A pin
 *  moves a card between the strip and compact sections; permanence lives
 *  on `retention` and changes through `swapGalleryRetention`,
 *  `setGalleryRetained`, or a tier change — never through the pin, so an
 *  unpin cannot launder a fresh expiry window. */
export const setGalleryPinned = async (ownerId: string, slug: string, pinned: boolean, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const pinnedAt = pinned ? new Date().toISOString() : null
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare(`UPDATE galleries SET pinned_at = ? WHERE owner_id = ? AND slug = ?`)
      .bind(pinnedAt, ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getGallery(ownerId, slug, env)
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  const updated = { ...normalizeRecord(current), pinnedAt }
  store.set(slug, updated)
  return updated
}

/** Promotes a pipeline gallery into a permanent slot on its own — used
 *  when the owner's permanent set has room and no swap is needed. The
 *  slot check rides inside the same UPDATE (a count-and-write pre-check
 *  would race a concurrent promote and overfill the quota); `limit`
 *  of null means unlimited. Returns 'limit' when the quota was the
 *  reason nothing changed, null for a missing or non-pipeline row. */
export const setGalleryRetained = async (ownerId: string, slug: string, limit: number | null, env?: GalleryEnv): Promise<GalleryRecord | 'limit' | null> => {
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare(`UPDATE galleries SET retention = 'retained', expires_at = NULL
                WHERE owner_id = ? AND slug = ? AND retention = 'pipeline'
                  AND (? IS NULL OR (SELECT COUNT(*) FROM galleries WHERE owner_id = ? AND retention = 'retained') < ?)`)
      .bind(ownerId, slug, limit, ownerId, limit).run()
    if ((result.meta.changes ?? 0) > 0) return getGallery(ownerId, slug, env)
    const current = await getStoredGallery(ownerId, slug, env)
    return current && current.retention === 'pipeline' ? 'limit' : null
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current || retentionOf(current) !== 'pipeline') return null
  const retainedCount = [...store.values()].filter((item) => retentionOf(item) === 'retained').length
  if (limit !== null && retainedCount >= limit) return 'limit'
  const updated = { ...normalizeRecord(current), retention: 'retained' as const, expiresAt: null }
  store.set(slug, updated)
  return updated
}

/** The one-tap permanence swap: the pipeline gallery takes the retained
 *  one's slot — permanent, no expiry, and its pinned position — while
 *  the retained one takes the pipeline row's place and *its* expiry
 *  (the temp's own clock, not a fresh window). Position and permanence
 *  cross together so the owner sees exactly the exchange they chose. */
export const swapGalleryRetention = async (ownerId: string, pipelineSlug: string, retainedSlug: string, env?: GalleryEnv): Promise<{ incoming: GalleryRecord; outgoing: GalleryRecord } | null> => {
  if (d1Configured(env)) {
    // One guarded statement: the CASE columns cross each row's values onto
    // the other, and the WHERE clause proves the expected retention of
    // both rows at update time — a read-then-write would let either row
    // drift in between. Exactly two changed rows is the acceptance test.
    const result = await env.DB
      .prepare(`UPDATE galleries SET
                  retention = CASE WHEN slug = ? THEN 'retained' ELSE 'pipeline' END,
                  expires_at = CASE WHEN slug = ? THEN NULL
                    ELSE (SELECT expires_at FROM galleries WHERE owner_id = ? AND slug = ?) END,
                  pinned_at = CASE WHEN slug = ?
                    THEN (SELECT pinned_at FROM galleries WHERE owner_id = ? AND slug = ?)
                    ELSE (SELECT pinned_at FROM galleries WHERE owner_id = ? AND slug = ?) END
                WHERE owner_id = ? AND slug IN (?, ?)
                  AND (SELECT retention FROM galleries WHERE owner_id = ? AND slug = ?) = 'pipeline'
                  AND (SELECT retention FROM galleries WHERE owner_id = ? AND slug = ?) = 'retained'`)
      .bind(
        pipelineSlug,
        pipelineSlug, ownerId, pipelineSlug,
        pipelineSlug, ownerId, retainedSlug, ownerId, pipelineSlug,
        ownerId, pipelineSlug, retainedSlug,
        ownerId, pipelineSlug,
        ownerId, retainedSlug,
      ).run()
    if ((result.meta.changes ?? 0) !== 2) return null
    const [nextIn, nextOut] = await Promise.all([getGallery(ownerId, pipelineSlug, env), getGallery(ownerId, retainedSlug, env)])
    return nextIn && nextOut ? { incoming: nextIn, outgoing: nextOut } : null
  }
  const store = ownerStore(ownerId)
  const incoming = store.get(pipelineSlug)
  const outgoing = store.get(retainedSlug)
  if (!incoming || !outgoing || retentionOf(incoming) === 'retained' || retentionOf(outgoing) === 'pipeline') return null
  const a = normalizeRecord(incoming)
  const b = normalizeRecord(outgoing)
  const nextIn = { ...a, retention: 'retained' as const, expiresAt: null, pinnedAt: b.pinnedAt ?? null }
  const nextOut = { ...b, retention: 'pipeline' as const, expiresAt: a.expiresAt ?? null, pinnedAt: a.pinnedAt ?? null }
  store.set(pipelineSlug, nextIn)
  store.set(retainedSlug, nextOut)
  return { incoming: nextIn, outgoing: nextOut }
}

/** Order/dedupe key: `ref` when the provider gives a stable item ID
 *  (Drive file ID, iCloud photo GUID), else the filename (Dropbox names
 *  are unique per folder). Identical for images and videos — a mixed
 *  gallery orders and dedupes through exactly one key path. */
const imageKey = (image: GalleryMediaItem) => image.ref ?? image.filename

/** Reorders known items by provider key, appending omitted items in their
 *  existing order. Throws a typed read-only error for pipeline galleries. */
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

/** Sets the owner-visible `hidden` flag on the given provider keys and
 *  clears it everywhere else. The flag — not removal — is what a source
 *  refresh merges against, so a hidden item stays hidden instead of being
 *  rediscovered and appended. Throws a typed read-only error for pipeline
 *  galleries. */
export const updateGalleryHidden = async (ownerId: string, slug: string, hiddenKeys: readonly string[], env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const mark = (current: GalleryRecord) => {
    const keys = new Set(hiddenKeys)
    return current.images.map((image) => {
      const hidden = keys.has(imageKey(image))
      if (hidden === (image.hidden === true)) return image
      const next = { ...image }
      if (hidden) next.hidden = true
      else delete next.hidden
      return next
    })
  }
  if (d1Configured(env)) {
    const current = await getStoredGallery(ownerId, slug, env)
    if (!current) return null
    assertGalleryEditable(current)
    const marked = mark(current)
    const result = await env.DB.prepare(
      `UPDATE galleries SET images_json = ? WHERE owner_id = ? AND slug = ? AND retention = 'retained'`,
    ).bind(JSON.stringify(marked), ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return { ...current, images: marked }
  }
  const store = ownerStore(ownerId)
  const current = store.get(slug)
  if (!current) return null
  assertGalleryEditable(current)
  const marked = mark(current)
  const updated = { ...normalizeRecord(current), images: marked }
  store.set(slug, updated)
  return updated
}

/** The trimmed item shape the admin dashboard receives. Video entries
 *  additionally carry `type`, `durationSeconds` and `poster` so the rail
 *  can badge them; image entries are byte-identical to before — no `type`
 *  key is invented for them. */
const previewImages = (images: readonly GalleryMediaItem[]) => images.map((image) => {
  const { id, ref, filename, src, width, height, alt, placeholder, variants } = image
  const base = {
    id, ref, filename, src, width, height, alt, placeholder, variants,
    ...('media' in image && image.media ? { media: image.media } : {}),
    ...('contentVersion' in image && image.contentVersion ? { contentVersion: image.contentVersion } : {}),
    ...('fidelity' in image && image.fidelity ? { fidelity: image.fidelity } : {}),
    ...('thumbnailFidelity' in image && image.thumbnailFidelity ? { thumbnailFidelity: image.thumbnailFidelity } : {}),
  }
  // `hidden` stays optional like the stored flag — the conditional spread
  // keeps it absent on visible items, so summary shapes are unchanged.
  const flagged = { ...base, ...(image.hidden ? { hidden: true as const } : {}) }
  return isVideoItem(image)
    ? { ...flagged, type: 'video' as const, durationSeconds: image.durationSeconds, poster: image.poster }
    : flagged
})

export const deleteGallery = async (ownerId: string, slug: string, env?: GalleryEnv, options?: { force?: boolean }): Promise<boolean> => {
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare('DELETE FROM galleries WHERE owner_id = ? AND slug = ?')
      .bind(ownerId, slug)
      .run()
    // The device link bound to this gallery — a different gallery that
    // later takes the slug must not inherit it.
    if ((result.meta.changes ?? 0) > 0) await clearDeviceGalleryLink(env.DB, ownerId, slug)
    return (result.meta.changes ?? 0) > 0
  }
  return ownerStore(ownerId).delete(slug)
}

/** Counts retained galleries only; pipeline galleries do not consume the cap. */
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

/** Promotes every unexpired pipeline gallery for an owner and clears its
 *  deadline. Returns the number promoted; repeated calls are idempotent. */
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

/** Lists expired pipeline keys in expiration/owner/slug order for keyset
 *  pagination. The optional cursor is exclusive. */
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

/** Deletes a scanned expiry candidate only if it is still a pipeline gallery
 *  with the same deadline and is expired at `now`. Returns whether it deleted. */
export const deleteExpiredPipelineGallery = async (key: ExpiredGalleryKey, now: string, env?: GalleryEnv): Promise<boolean> => {
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      `DELETE FROM galleries WHERE owner_id = ? AND slug = ? AND retention = 'pipeline' AND expires_at <= ? AND expires_at = ?`,
    ).bind(key.ownerId, key.slug, now, key.expiresAt).run()
    if ((result.meta.changes ?? 0) > 0) await clearDeviceGalleryLink(env.DB, key.ownerId, key.slug)
    return (result.meta.changes ?? 0) > 0
  }
  const current = ownerStore(key.ownerId).get(key.slug)
  if (!current || retentionOf(current) !== 'pipeline') return false
  if (!current.expiresAt || current.expiresAt !== key.expiresAt || current.expiresAt > now) return false
  return ownerStore(key.ownerId).delete(key.slug)
}

export const toSummary = (gallery: GalleryRecord) => {
  // stills/videos count what the published gallery shows — the route
  // filters `hidden` — while `hidden` carries the concealed total so owner
  // surfaces can state it. `imageCount` stays the full count: the native
  // vault's "Saving n of imageCount" progress reads it.
  const visible = gallery.images.filter((image) => !image.hidden)
  const { stills, videos } = mediaCountOf(visible)
  return { id: gallery.id, manifestVersion: gallery.manifestVersion ?? 1, slug: gallery.slug, title: gallery.title, caption: gallery.caption, date: gallery.date, imageCount: gallery.images.length, mediaCount: { stills, videos, hidden: gallery.images.length - visible.length }, sourceUrl: gallery.sourceUrl, createdAt: gallery.createdAt, retention: retentionOf(gallery), expiresAt: gallery.expiresAt ?? null, pinnedAt: gallery.pinnedAt ?? null, keyRetiredAt: gallery.keyRetiredAt ?? null, images: previewImages(gallery.images) }
}
export type GallerySummary = ReturnType<typeof toSummary>

/** The Library's payload diet: a strip gallery ships its whole rail in
 *  stored order (hidden items ride along — the owner rail dims them),
 *  a compact gallery ships only its first visible item as a cover, and
 *  every summary keeps its real counts. `layout` names the treatment so
 *  the Admin island never recomputes it. */
export const toLibrarySummaries = (galleries: readonly GalleryRecord[], tier: AccountTier) => {
  const layout = libraryLayout(galleries, tier)
  const strips = new Set(layout.strips)
  return galleries.map((gallery) => {
    const summary = toSummary(gallery)
    if (strips.has(gallery.slug)) return { ...summary, layout: 'strip' as const }
    return { ...summary, images: summary.images.filter((image) => !image.hidden).slice(0, 1), layout: 'compact' as const }
  })
}
export type LibrarySummary = ReturnType<typeof toLibrarySummaries>[number]

/** Drops one owner's whole in-memory store so the non-D1 branch of
 *  deleteAccount leaves no orphaned gallery records behind. */
export const dropOwnerGalleries = (ownerId: string) => {
  runtimeGalleries.delete(ownerId)
}

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetGalleryStore = () => runtimeGalleries.clear()
