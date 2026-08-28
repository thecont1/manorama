import type { GalleryImage, GalleryManifest } from './imagesource'
import manifest from './gallery-manifest'

export type GalleryRecord = GalleryManifest & {
  sourceUrl?: string
  createdAt?: string
}

type GalleryFields = {
  slug?: string
  title?: string
  caption?: string
  date?: string
  sourceUrl?: string
  createdAt?: string
  imagesJson?: string
}

type AirtableRecord = { id: string; fields: GalleryFields }
type AirtableListResponse = { records: AirtableRecord[]; offset?: string }
type AirtableEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
}

const cloneImages = (images: readonly GalleryImage[]) => images.map((image) => ({
  ...image,
  variants: image.variants ? [...image.variants] : undefined,
}))

export const bundledGallery: GalleryRecord = {
  ...manifest,
  images: cloneImages(manifest.images),
}

const runtimeGalleries = new Map<string, GalleryRecord>()
const airtableConfigured = (env?: AirtableEnv) => Boolean(env?.AIRTABLE_PAT && env?.AIRTABLE_BASE_ID)
const tableName = (env: AirtableEnv) => encodeURIComponent(env.AIRTABLE_GALLERIES_TABLE || 'Galleries')
const apiUrl = (env: AirtableEnv, suffix = '') => `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${tableName(env)}${suffix}`

const airtableRequest = async <T>(env: AirtableEnv, input: RequestInfo | URL, init?: RequestInit) => {
  const response = await fetch(input, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Airtable request failed (${response.status}): ${detail.slice(0, 240)}`)
  }
  return response.json() as Promise<T>
}

const humanizeSlug = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const recordFromFields = (fields: GalleryFields): GalleryRecord | null => {
  if (!fields.slug) return null
  if (!fields.imagesJson) {
    return { slug: fields.slug, title: fields.title || humanizeSlug(fields.slug), caption: fields.caption ?? '', date: fields.date ?? '', sourceUrl: fields.sourceUrl, createdAt: fields.createdAt, images: [] }
  }
  try {
    const images = JSON.parse(fields.imagesJson) as GalleryImage[]
    if (!Array.isArray(images)) return null
    return { slug: fields.slug, title: fields.title || humanizeSlug(fields.slug), caption: fields.caption ?? '', date: fields.date ?? '', sourceUrl: fields.sourceUrl, createdAt: fields.createdAt, images }
  } catch {
    return null
  }
}

const fieldsFromRecord = (gallery: GalleryRecord): GalleryFields => {
  const fields: GalleryFields = {
    slug: gallery.slug,
    title: gallery.title,
    sourceUrl: gallery.sourceUrl,
    createdAt: gallery.createdAt,
    imagesJson: JSON.stringify(gallery.images),
  }
  if (gallery.caption) fields.caption = gallery.caption
  if (gallery.date) fields.date = gallery.date
  return fields
}

const recordForSlug = async (slug: string, env: AirtableEnv) => {
  const formula = encodeURIComponent(`{slug}='${slug.replaceAll("'", "\\'")}'`)
  const response = await airtableRequest<AirtableListResponse>(env, apiUrl(env, `?filterByFormula=${formula}&maxRecords=1`))
  return response.records[0]
}

const sortRecent = (galleries: GalleryRecord[]) => galleries.sort((a, b) => {
  const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
  const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
  return bTime - aTime || a.title.localeCompare(b.title)
})

export const listGalleries = async (env?: AirtableEnv): Promise<GalleryRecord[]> => {
  if (airtableConfigured(env)) {
    const response = await airtableRequest<AirtableListResponse>(env, apiUrl(env, '?pageSize=100'))
    const external = response.records
      .map((record) => recordFromFields(record.fields))
      .filter((item): item is GalleryRecord => Boolean(item?.sourceUrl) && item.images.length > 0)
    return sortRecent(external)
  }
  const merged = new Map<string, GalleryRecord>([[bundledGallery.slug, bundledGallery]])
  runtimeGalleries.forEach((gallery) => merged.set(gallery.slug, gallery))
  return sortRecent([...merged.values()])
}

export const getGallery = async (slug: string, env?: AirtableEnv): Promise<GalleryRecord | null> => {
  if (airtableConfigured(env)) {
    const record = await recordForSlug(slug, env)
    const external = recordFromFields(record?.fields ?? {})
    return external?.sourceUrl && external.images.length ? external : null
  }
  if (slug === bundledGallery.slug) return runtimeGalleries.get(slug) ?? bundledGallery
  return runtimeGalleries.get(slug) ?? null
}

export const createGallery = async (gallery: GalleryRecord, env?: AirtableEnv): Promise<GalleryRecord> => {
  if (airtableConfigured(env)) {
    const existing = await recordForSlug(gallery.slug, env)
    if (existing) {
      await airtableRequest(env, apiUrl(env, `/${existing.id}`), { method: 'PATCH', body: JSON.stringify({ fields: fieldsFromRecord(gallery) }) })
    } else {
      await airtableRequest(env, apiUrl(env), { method: 'POST', body: JSON.stringify({ records: [{ fields: fieldsFromRecord(gallery) }] }) })
    }
  } else {
    runtimeGalleries.set(gallery.slug, gallery)
  }
  return gallery
}

export const updateGalleryMetadata = async (slug: string, patch: { title?: string; caption?: string }, env?: AirtableEnv) => {
  const current = await getGallery(slug, env)
  if (!current) return null
  return createGallery({ ...current, title: patch.title ?? current.title, caption: patch.caption ?? current.caption, createdAt: current.createdAt || new Date().toISOString() }, env)
}

export const updateGallerySlug = async (slug: string, nextSlug: string, env?: AirtableEnv) => {
  const current = await getGallery(slug, env)
  if (!current) return null
  if (slug === nextSlug) return current
  const conflicting = await getGallery(nextSlug, env)
  if (conflicting) throw new Error('That gallery URL is already in use')
  const nextGallery = { ...current, slug: nextSlug }
  if (airtableConfigured(env)) {
    const record = await recordForSlug(slug, env)
    if (!record) return null
    await airtableRequest(env, apiUrl(env, `/${record.id}`), { method: 'PATCH', body: JSON.stringify({ fields: fieldsFromRecord(nextGallery) }) })
  } else {
    runtimeGalleries.delete(slug)
    runtimeGalleries.set(nextSlug, nextGallery)
  }
  return nextGallery
}

export const updateGalleryOrder = async (slug: string, order: string[], env?: AirtableEnv) => {
  const current = await getGallery(slug, env)
  if (!current) return null
  const byFilename = new Map(current.images.map((image) => [image.filename, image]))
  const reordered = order.map((filename) => byFilename.get(filename)).filter((image): image is GalleryImage => Boolean(image))
  const seen = new Set(reordered.map((image) => image.filename))
  current.images.forEach((image) => { if (!seen.has(image.filename)) reordered.push(image) })
  return createGallery({ ...current, images: reordered }, env)
}

const previewImages = (images: readonly GalleryImage[]) => images.map(({ id, filename, src, width, height, alt, placeholder, variants }) => ({ id, filename, src, width, height, alt, placeholder, variants }))

export const deleteGallery = async (slug: string, env?: AirtableEnv): Promise<boolean> => {
  if (slug === bundledGallery.slug) return false
  if (airtableConfigured(env)) {
    const record = await recordForSlug(slug, env)
    if (!record) return false
    await airtableRequest(env, apiUrl(env, `/${record.id}`), { method: 'DELETE' })
    return true
  }
  return runtimeGalleries.delete(slug)
}

export const toSummary = (gallery: GalleryRecord) => ({ slug: gallery.slug, title: gallery.title, caption: gallery.caption, date: gallery.date, imageCount: gallery.images.length, sourceUrl: gallery.sourceUrl, createdAt: gallery.createdAt, images: previewImages(gallery.images) })
export type GallerySummary = ReturnType<typeof toSummary>
