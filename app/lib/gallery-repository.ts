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

// Per-gallery update serialization: a promise chain that ensures concurrent
// updates to the same gallery execute sequentially rather than interleaving
// their read-modify-write steps. Without this, two overlapping PATCH requests
// can both read the same stale state and the older write silently overwrites
// the newer one.
const updateLocks = new Map<string, Promise<unknown>>()
const withUpdateLock = <T>(lockKey: string, fn: () => Promise<T>): Promise<T> => {
  const previous = updateLocks.get(lockKey)
  const run = (previous ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  updateLocks.set(lockKey, tail)
  tail.finally(() => { if (updateLocks.get(lockKey) === tail) updateLocks.delete(lockKey) })
  return run
}

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
      .filter((item): item is GalleryRecord => Boolean(item?.sourceUrl) && (item?.images?.length ?? 0) > 0)
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
    return external?.sourceUrl && external.images.length ? external : null
  }
  const runtime = ownerStore(ownerId).get(slug) ?? null
  return runtime ?? (slug === bundledGallery.slug ? bundledGallery : null)
}

export const createGallery = async (ownerId: string, gallery: GalleryRecord, env?: GalleryEnv): Promise<GalleryRecord> => {
  const row = recordToRow(gallery)
  if (d1Configured(env)) {
    await env.DB.prepare(
      `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, slug) DO UPDATE SET
         title = excluded.title, caption = excluded.caption, date = excluded.date,
         source_url = excluded.source_url, images_json = excluded.images_json`,
    ).bind(row.slug, ownerId, row.title, row.caption, row.date, row.source_url, row.images_json, row.created_at).run()
  } else {
    ownerStore(ownerId).set(gallery.slug, gallery)
  }
  return gallery
}

export const updateGalleryMetadata = async (ownerId: string, slug: string, patch: { title?: string; caption?: string }, env?: GalleryEnv) =>
  withUpdateLock(`${ownerId}:${slug}`, async () => {
    const current = await getGallery(ownerId, slug, env)
    if (!current) return null
    return createGallery(ownerId, { ...current, title: patch.title ?? current.title, caption: patch.caption ?? current.caption, createdAt: current.createdAt || new Date().toISOString() }, env)
  })

export const updateGallerySlug = async (ownerId: string, slug: string, nextSlug: string, env?: GalleryEnv) =>
  withUpdateLock(`${ownerId}:${slug}`, async () => {
    const current = await getGallery(ownerId, slug, env)
    if (!current) return null
    if (slug === nextSlug) return current
    const conflicting = await getGallery(ownerId, nextSlug, env)
    if (conflicting) throw new Error('That gallery URL is already in use')
    const nextGallery = { ...current, slug: nextSlug }
    await createGallery(ownerId, nextGallery, env)
    await deleteGallery(ownerId, slug, env, { force: true })
    return nextGallery
  })

export const updateGalleryOrder = async (ownerId: string, slug: string, order: string[], env?: GalleryEnv) =>
  withUpdateLock(`${ownerId}:${slug}`, async () => {
    const current = await getGallery(ownerId, slug, env)
    if (!current) return null
    const byFilename = new Map(current.images.map((image) => [image.filename, image]))
    const reordered = order.map((filename) => byFilename.get(filename)).filter((image): image is GalleryImage => Boolean(image))
    const seen = new Set(reordered.map((image) => image.filename))
    current.images.forEach((image) => { if (!seen.has(image.filename)) reordered.push(image) })
    return createGallery(ownerId, { ...current, images: reordered }, env)
  })

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
      .prepare('SELECT COUNT(*) AS count FROM galleries WHERE owner_id = ?')
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
