import type { D1Database } from '@cloudflare/workers-types'
import type { GalleryImage, GalleryManifest } from './imagesource'
import manifest from './gallery-manifest'

/**
 * Gallery storage. Every gallery belongs to exactly one owner (a Dropbox
 * account ID) — the composite key (owner_id, slug) means two owners can
 * independently use the same gallery slug. Public URLs resolve through
 * the owner first: /<owner_slug>/<gallery_slug>.
 *
 * D1 is the production store. Without the DB binding (vite dev, tests)
 * an in-memory store is used, where the bundled italy-2018 fixture
 * resolves for every owner so the dev server has content to show.
 */

export type GalleryRecord = GalleryManifest & {
  sourceUrl?: string
  createdAt?: string
}

type GalleryRow = {
  slug: string
  title: string
  caption: string | null
  date: string | null
  source_url: string | null
  images_json: string | null
  created_at: string | null
}

export type GalleryEnv = { DB?: D1Database }

const cloneImages = (images: readonly GalleryImage[]) => images.map((image) => ({
  ...image,
  variants: image.variants ? [...image.variants] : undefined,
}))

export const bundledGallery: GalleryRecord = {
  ...manifest,
  images: cloneImages(manifest.images),
}

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

const rowToRecord = (row: GalleryRow | null): GalleryRecord | null => {
  if (!row || !row.slug) return null
  const gallery: GalleryRecord = {
    slug: row.slug,
    title: row.title || row.slug,
    caption: row.caption ?? '',
    date: row.date ?? '',
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at ?? undefined,
    images: [],
  }
  if (row.images_json) {
    try {
      const images = JSON.parse(row.images_json) as GalleryImage[]
      if (Array.isArray(images)) gallery.images = images
    } catch {
      // A malformed images payload yields an empty gallery, not a crash.
    }
  }
  return gallery
}

const recordToRow = (gallery: GalleryRecord): GalleryRow => ({
  slug: gallery.slug,
  title: gallery.title,
  caption: gallery.caption || null,
  date: gallery.date || null,
  source_url: gallery.sourceUrl ?? null,
  images_json: JSON.stringify(gallery.images),
  created_at: gallery.createdAt || new Date().toISOString(),
})

const sortRecent = (galleries: GalleryRecord[]) => galleries.sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

export const listGalleries = async (ownerId: string, env?: GalleryEnv): Promise<GalleryRecord[]> => {
  if (d1Configured(env)) {
    const result = await env.DB
      .prepare('SELECT slug, title, caption, date, source_url, images_json, created_at FROM galleries WHERE owner_id = ?')
      .bind(ownerId)
      .all<GalleryRow>()
    const external = (result.results ?? [])
      .map((row) => rowToRecord(row))
      .filter((item): item is GalleryRecord => (item?.images?.length ?? 0) > 0)
    return sortRecent(external)
  }
  const store = ownerStore(ownerId)
  const merged = new Map<string, GalleryRecord>([[bundledGallery.slug, bundledGallery]])
  store.forEach((gallery) => merged.set(gallery.slug, gallery))
  return sortRecent([...merged.values()])
}

export const getGallery = async (ownerId: string, slug: string, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT slug, title, caption, date, source_url, images_json, created_at FROM galleries WHERE owner_id = ? AND slug = ?')
      .bind(ownerId, slug)
      .first<GalleryRow>()
    const external = rowToRecord(row)
    return external && external.images.length > 0 ? external : null
  }
  const runtime = ownerStore(ownerId).get(slug) ?? null
  return runtime ?? (slug === bundledGallery.slug ? bundledGallery : null)
}

export const createGallery = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord> => {
  const row = recordToRow(gallery)
  if (d1Configured(env)) {
    await env.DB.prepare(
      `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.slug, ownerId, row.title, row.caption, row.date, row.source_url, row.images_json, row.created_at).run()
  } else {
    ownerStore(ownerId).set(gallery.slug, gallery)
  }
  return gallery
}

export type CreateWithinLimitResult =
  | { readonly ok: true; readonly gallery: GalleryRecord }
  | { readonly ok: false; readonly reason: 'limit' | 'conflict' }

/** Atomically checks the free-tier limit and inserts the gallery in one D1
 *  statement, so concurrent requests cannot both pass the count check and
 *  exceed the limit. Returns `conflict` when the (owner_id, slug) key
 *  already exists, so the caller can pick another slug. */
export const createGalleryWithinLimit = async (
  ownerId: string,
  gallery: GalleryRecord,
  limit: number,
  env?: GalleryEnv,
): Promise<CreateWithinLimitResult> => {
  const row = recordToRow(gallery)
  if (d1Configured(env)) {
    try {
      const result = await env.DB.prepare(
        `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM galleries WHERE owner_id = ? AND source_url IS NOT NULL) < ?`,
      ).bind(row.slug, ownerId, row.title, row.caption, row.date, row.source_url, row.images_json, row.created_at, ownerId, limit).run()
      if ((result.meta.changes ?? 0) === 0) return { ok: false, reason: 'limit' }
      return { ok: true, gallery }
    } catch (error) {
      if (String(error).includes('UNIQUE')) return { ok: false, reason: 'conflict' }
      throw error
    }
  }
  if (ownerStore(ownerId).has(gallery.slug)) return { ok: false, reason: 'conflict' }
  if (ownerStore(ownerId).size >= limit) return { ok: false, reason: 'limit' }
  ownerStore(ownerId).set(gallery.slug, gallery)
  return { ok: true, gallery }
}

/** Updates an existing gallery row in place via an atomic D1 UPDATE (no
 *  create-then-delete). Returns null when no row matches. */
export const updateGalleryRecord = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  const row = recordToRow(gallery)
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      `UPDATE galleries SET title = ?, caption = ?, date = ?, source_url = ?, images_json = ?
       WHERE owner_id = ? AND slug = ?`,
    ).bind(row.title, row.caption, row.date, row.source_url, row.images_json, ownerId, gallery.slug).run()
    return (result.meta.changes ?? 0) > 0 ? gallery : null
  }
  const exists = await getGallery(ownerId, gallery.slug, env)
  if (!exists) return null
  ownerStore(ownerId).set(gallery.slug, gallery)
  return gallery
}

export const updateGalleryMetadata = async (ownerId: string, slug: string, patch: { title?: string; caption?: string }, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const sets: string[] = []
    const params: unknown[] = []
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
    if (patch.caption !== undefined) { sets.push('caption = ?'); params.push(patch.caption) }
    if (sets.length === 0) return getGallery(ownerId, slug, env)
    params.push(ownerId, slug)
    const result = await env.DB.prepare(
      `UPDATE galleries SET ${sets.join(', ')} WHERE owner_id = ? AND slug = ?`,
    ).bind(...params).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return getGallery(ownerId, slug, env)
  }
  const current = await getGallery(ownerId, slug, env)
  if (!current) return null
  const updated: GalleryRecord = {
    ...current,
    title: patch.title ?? current.title,
    caption: patch.caption ?? current.caption,
    createdAt: current.createdAt || new Date().toISOString(),
  }
  ownerStore(ownerId).set(slug, updated)
  return updated
}

export const updateGallerySlug = async (ownerId: string, slug: string, nextSlug: string, env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (slug === nextSlug) return getGallery(ownerId, slug, env)
  if (d1Configured(env)) {
    try {
      const result = await env.DB.prepare(
        `UPDATE galleries SET slug = ? WHERE owner_id = ? AND slug = ?`,
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
  const current = await getGallery(ownerId, slug, env)
  if (!current) return null
  const conflicting = await getGallery(ownerId, nextSlug, env)
  if (conflicting) throw new Error('That gallery URL is already in use')
  const nextGallery = { ...current, slug: nextSlug }
  ownerStore(ownerId).delete(slug)
  ownerStore(ownerId).set(nextSlug, nextGallery)
  return nextGallery
}

export const updateGalleryOrder = async (ownerId: string, slug: string, order: string[], env?: GalleryEnv): Promise<GalleryRecord | null> => {
  if (d1Configured(env)) {
    const current = await getGallery(ownerId, slug, env)
    if (!current) return null
    const byFilename = new Map(current.images.map((image) => [image.filename, image]))
    const reordered = order.map((filename) => byFilename.get(filename)).filter((image): image is GalleryImage => Boolean(image))
    const seen = new Set(reordered.map((image) => image.filename))
    current.images.forEach((image) => { if (!seen.has(image.filename)) reordered.push(image) })
    const result = await env.DB.prepare(
      `UPDATE galleries SET images_json = ? WHERE owner_id = ? AND slug = ?`,
    ).bind(JSON.stringify(reordered), ownerId, slug).run()
    if ((result.meta.changes ?? 0) === 0) return null
    return { ...current, images: reordered }
  }
  const current = await getGallery(ownerId, slug, env)
  if (!current) return null
  const byFilename = new Map(current.images.map((image) => [image.filename, image]))
  const reordered = order.map((filename) => byFilename.get(filename)).filter((image): image is GalleryImage => Boolean(image))
  const seen = new Set(reordered.map((image) => image.filename))
  current.images.forEach((image) => { if (!seen.has(image.filename)) reordered.push(image) })
  const updated = { ...current, images: reordered }
  ownerStore(ownerId).set(slug, updated)
  return updated
}

const previewImages = (images: readonly GalleryImage[]) => images.map(({ id, filename, src, width, height, alt, placeholder, variants }) => ({ id, filename, src, width, height, alt, placeholder, variants }))

export const deleteGallery = async (ownerId: string, slug: string, env?: GalleryEnv, options?: { force?: boolean }): Promise<boolean> => {
  // The bundled fixture is dev-only content and can never be deleted; the
  // guard applies only to the in-memory fallback where it resolves.
  if (!options?.force && !d1Configured(env) && slug === bundledGallery.slug) return false
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
      .prepare('SELECT COUNT(*) AS count FROM galleries WHERE owner_id = ? AND source_url IS NOT NULL')
      .bind(ownerId)
      .first<{ count: number }>()
    return row?.count ?? 0
  }
  // The bundled fixture is dev-only content and never counts against a
  // real owner's limit; only explicitly created galleries do.
  return ownerStore(ownerId).size
}

export const toSummary = (gallery: GalleryRecord) => ({ slug: gallery.slug, title: gallery.title, caption: gallery.caption, date: gallery.date, imageCount: gallery.images.length, sourceUrl: gallery.sourceUrl, createdAt: gallery.createdAt, images: previewImages(gallery.images) })
export type GallerySummary = ReturnType<typeof toSummary>

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetGalleryStore = () => runtimeGalleries.clear()
