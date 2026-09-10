/**
 * One-time migration: Airtable galleries (plus the bundled italy-2018
 * fixture) into D1, owned by a single Dropbox account.
 *
 *   bun scripts/migrate-galleries.ts <dropbox-account-id> [--dry-run]
 *
 * Requires in the environment:
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (D1 edit permission)
 *   AIRTABLE_PAT, AIRTABLE_BASE_ID  (the legacy gallery source)
 *   D1_DATABASE_ID (optional — falls back to the ID in wrangler.toml)
 *
 * Idempotent: galleries are upserted by (owner_id, slug), so re-running
 * is safe. The owner must already exist (sign in once first — this script
 * refuses to invent a user).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import manifest from '../app/lib/gallery-manifest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const DATABASE_ID =
  process.env.D1_DATABASE_ID ??
  /database_id = "([^"]+)"/.exec(readFileSync(`${repoRoot}/wrangler.toml`, 'utf8'))?.[1]

const D1_QUERY_URL = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${DATABASE_ID}/query`

type GalleryImage = typeof manifest.images[number]
type GalleryRecord = {
  slug: string
  title: string
  caption: string
  date: string
  sourceUrl?: string
  createdAt?: string
  images: readonly GalleryImage[]
}

type AirtableFields = {
  slug?: string
  title?: string
  caption?: string
  date?: string
  sourceUrl?: string
  createdAt?: string
  imagesJson?: string
}
type AirtableRecord = { fields: AirtableFields }

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`missing ${name} in the environment`)
    process.exit(1)
  }
  return value
}

const humanizeSlug = (slug: string) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())

const recordFromFields = (fields: AirtableFields): GalleryRecord | null => {
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

const d1 = async (accountId: string, token: string, sql: string, params: unknown[]) => {
  const response = await fetch(D1_QUERY_URL(accountId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const payload = await response.json() as { success?: boolean; errors?: unknown[] }
  if (!response.ok || !payload.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(payload.errors ?? payload).slice(0, 300)}`)
  }
}

const main = async () => {
  const [ownerId, ...flags] = process.argv.slice(2)
  if (!ownerId || !/^dbid:/.test(ownerId)) {
    console.error('usage: bun scripts/migrate-galleries.ts <dropbox-account-id> [--dry-run]')
    process.exit(1)
  }
  const dryRun = flags.includes('--dry-run')
  const accountId = required('CLOUDFLARE_ACCOUNT_ID')
  const token = required('CLOUDFLARE_API_TOKEN')
  if (!DATABASE_ID) {
    console.error('could not determine the D1 database id (set D1_DATABASE_ID)')
    process.exit(1)
  }

  // The owner must exist: galleries reference the users table.
  const usersResponse = await fetch(D1_QUERY_URL(accountId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: 'SELECT owner_slug FROM users WHERE dropbox_account_id = ?', params: [ownerId] }),
  })
  if (!usersResponse.ok) {
    console.error(`D1 users query failed (${usersResponse.status})`)
    process.exit(1)
  }
  const users = await usersResponse.json() as { success?: boolean; result?: { success?: boolean; results?: { owner_slug?: string }[] }[] }
  if (!users.success || !users.result?.[0]?.success || !users.result?.[0]?.results?.length) {
    console.error(`no user exists yet for ${ownerId} — sign in once at the landing page, then re-run`)
    process.exit(1)
  }
  const ownerSlug = users.result![0]!.results![0]!.owner_slug
  console.log(`migrating galleries to ${ownerSlug} (${ownerId})`)

  // 1. The Airtable galleries — follow the offset to fetch every page.
  const airtableToken = required('AIRTABLE_PAT')
  const baseId = required('AIRTABLE_BASE_ID')
  const table = encodeURIComponent(process.env.AIRTABLE_GALLERIES_TABLE || 'Galleries')
  const airtableRecords: AirtableRecord[] = []
  let offset: string | undefined
  do {
    const airtableUrl = new URL(`https://api.airtable.com/v0/${baseId}/${table}`)
    airtableUrl.searchParams.set('pageSize', '100')
    if (offset) airtableUrl.searchParams.set('offset', offset)
    const airtableResponse = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${airtableToken}` },
    })
    if (!airtableResponse.ok) throw new Error(`Airtable list failed (${airtableResponse.status})`)
    const page = await airtableResponse.json() as { records: AirtableRecord[]; offset?: string }
    airtableRecords.push(...page.records)
    offset = page.offset
  } while (offset)
  const airtableGalleries = airtableRecords
    .map((record) => recordFromFields(record.fields))
    .filter((gallery): gallery is GalleryRecord => (gallery?.images?.length ?? 0) > 0)

  // 2. The bundled italy-2018 fixture, when Airtable does not carry it.
  const bundled: GalleryRecord = {
    slug: manifest.slug,
    title: manifest.title,
    caption: manifest.caption,
    date: manifest.date,
    images: manifest.images,
  }
  const galleries = airtableGalleries.some((gallery) => gallery.slug === bundled.slug)
    ? airtableGalleries
    : [bundled, ...airtableGalleries]

  console.log(`found ${airtableGalleries.length} Airtable galleries + ${galleries.length - airtableGalleries.length} bundled`)
  for (const gallery of galleries) {
    console.log(`  ${gallery.slug} — ${gallery.images.length} images`)
  }
  if (dryRun) {
    console.log('dry run: nothing written')
    return
  }

  for (const gallery of galleries) {
    await d1(accountId, token,
      `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, slug) DO UPDATE SET
         title = excluded.title, caption = excluded.caption, date = excluded.date,
         source_url = excluded.source_url, images_json = excluded.images_json`,
      [gallery.slug, ownerId, gallery.title, gallery.caption, gallery.date, gallery.sourceUrl ?? null,
       JSON.stringify(gallery.images), gallery.createdAt ?? new Date().toISOString()])
  }
  console.log(`migrated ${galleries.length} galleries`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
