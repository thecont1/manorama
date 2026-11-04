/**
 * One-time operator migration for the legacy encrypted-source cohort.
 *
 *   bun scripts/migrate-encrypted-sources.ts [--out out/encrypted-migration.sql]
 *
 * For every gallery whose stored source_url still carries a MEGA key, this
 * runs the same client scanner a browser would (scanMegaSource) on this
 * machine, validates the keyless manifest, merges it over the stored
 * curation (order + hidden flags), and writes a reviewable SQL file that
 * rewrites each row to the v2 shape while retiring the stored key in the
 * same statement. The keyed source URL lives only in this process's memory —
 * it is never logged — but the file IS still key-bearing: each UPDATE's
 * optimistic-concurrency guard embeds the stored images_json, which carries
 * legacy per-item k= secrets. Review it in place, apply it promptly, and
 * delete it afterwards — never commit it or attach it to a ticket. The
 * galleries table has no key-free concurrency token (no updated_at, digest,
 * or revision column), so the guard compares the snapshot verbatim.
 *
 * Reads use `bunx wrangler d1 execute`, so the only credential needed is the
 * operator's normal wrangler login. Applying is a separate, reviewed step:
 *
 *   bunx wrangler d1 execute manorama --remote --file out/encrypted-migration.sql
 *
 * Prerequisite: migrations 0013 and 0014 must be applied to the database
 * (`bunx wrangler d1 migrations apply manorama --remote`). The script
 * refuses to write a file for a schema that lacks the custody columns.
 *
 * Idempotent: the UPDATEs only touch rows whose source_url still contains a
 * fragment, so re-running after a partial apply is safe.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { GalleryMediaItem } from '../app/lib/imagesource'
import { scanMegaSource } from '../app/lib/mega-client'
import { validateEncryptedManifest } from '../app/lib/encrypted-manifest'
import { mergeMigratedImages } from '../app/lib/encrypted-migration'

const DB_NAME = 'manorama'
/** D1 rejects statements longer than 100,000 bytes — a serialized manifest
 *  alone can reach ~1.8 MB, so oversized UPDATEs are skipped, not shipped. */
const D1_STATEMENT_MAX_BYTES = 100_000
const outFlag = process.argv.indexOf('--out')
const OUT_FILE = outFlag > -1 ? process.argv[outFlag + 1] : 'out/encrypted-migration.sql'

type LegacyRow = {
  id: string
  slug: string
  source_url: string
  images_json: string
}

const d1 = <T>(sql: string): T[] => {
  const result = spawnSync('bunx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql], { maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`wrangler query failed: ${result.stderr?.toString().slice(0, 300) || result.stdout?.toString().slice(0, 300)}`)
  const payload = JSON.parse(result.stdout.toString()) as { results?: T[] }[]
  return payload[0]?.results ?? []
}

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

const main = async () => {
  // The custody columns come from 0013+0014 — refuse early rather than emit
  // a file that cannot run or cannot record retirement.
  const columns = await d1<{ name: string }>(`SELECT name FROM pragma_table_info('galleries')`)
  const have = new Set(columns.map((column) => column.name))
  for (const needed of ['id', 'manifest_version', 'key_retired_at', 'migration_devices']) {
    if (!have.has(needed)) {
      console.error(`galleries.${needed} is missing — apply migrations 0013+0014 first:\n  bunx wrangler d1 migrations apply ${DB_NAME} --remote`)
      process.exit(1)
    }
  }

  const rows = await d1<LegacyRow>(
    `SELECT id, slug, source_url, images_json FROM galleries
     WHERE source_url LIKE 'https://mega.nz/%#%' AND key_retired_at IS NULL`)
  if (rows.length === 0) {
    console.log('no keyed MEGA galleries remain — nothing to migrate')
    return
  }
  console.log(`found ${rows.length} keyed MEGA ${rows.length === 1 ? 'gallery' : 'galleries'}`)

  const retiredAt = new Date().toISOString()
  const statements: string[] = []
  let planned = 0
  for (const row of rows) {
    let scan
    try {
      scan = await scanMegaSource(row.source_url)
    } catch (error) {
      console.error(`  ${row.slug}: scan failed — ${error instanceof Error ? error.message : error}; skipped`)
      continue
    }
    let submitted
    try {
      submitted = validateEncryptedManifest({ provider: 'mega', sourceUrl: scan.sourceUrl, title: scan.title, images: scan.images, ...(scan.truncated !== undefined ? { truncated: scan.truncated } : {}) })
    } catch (error) {
      console.error(`  ${row.slug}: scanned manifest failed validation — ${error instanceof Error ? error.message : error}; skipped`)
      continue
    }
    // Same rule as the migrate endpoint: a partial listing would silently
    // delete the tail while the key retires in the same statement.
    if (submitted.truncated !== undefined) {
      console.error(`  ${row.slug}: scan truncated at ${submitted.truncated} items — refusing to retire the key; skipped`)
      continue
    }
    const existing = JSON.parse(row.images_json) as GalleryMediaItem[]
    const images = mergeMigratedImages(existing, submitted.images as GalleryMediaItem[])
    const hidden = images.filter((image) => image.hidden).length
    const retained = images.filter((image) => existing.some((old) => (old.ref ?? old.filename) === (image.ref ?? image.filename))).length
    // Optimistic concurrency on images_json: the snapshot may be days old by
    // the time the file is applied — owner edits since then must not be
    // overwritten. The guard lives inside the measured statement so its cost
    // counts against the statement limit too.
    const statement =
      `UPDATE galleries SET images_json = ${sqlLiteral(JSON.stringify(images))}, manifest_version = 2, source_url = ${sqlLiteral(submitted.sourceUrl)}, key_retired_at = ${sqlLiteral(retiredAt)}, migration_devices = '["operator-script"]' WHERE id = ${sqlLiteral(row.id)} AND source_url LIKE '%#%' AND images_json = ${sqlLiteral(row.images_json)};`
    if (new TextEncoder().encode(statement).byteLength > D1_STATEMENT_MAX_BYTES) {
      console.error(`  ${row.slug}: UPDATE exceeds D1's ${D1_STATEMENT_MAX_BYTES}-byte statement limit — migrate this gallery manually; skipped`)
      continue
    }
    statements.push(statement)
    planned += 1
    console.log(`  ${row.slug}: ${existing.length} stored → ${images.length} scanned (${retained} kept${hidden ? `, ${hidden} hidden` : ''}, ${images.length - retained} new) → ${submitted.sourceUrl}`)
  }

  if (planned === 0) {
    console.log('nothing to write — every keyed gallery was skipped')
    return
  }
  const verify = `SELECT slug, manifest_version, source_url LIKE '%#%' AS keyed FROM galleries WHERE id IN (${rows.map((row) => sqlLiteral(row.id)).join(', ')});`
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, [
    '-- Legacy encrypted-source cohort migration (operator-run).',
    '-- Rewrites each keyed MEGA gallery to the v2 keyless shape and retires',
    '-- the stored key in the same statement. Idempotent: the WHERE clause',
    '-- no-ops on rows already migrated.',
    '-- SENSITIVE: the images_json guards echo legacy per-item k= secrets.',
    '-- Do not commit, share, or retain this file after applying.',
    '',
    ...statements,
    '',
    verify,
    '',
  ].join('\n'))
  console.log(`wrote ${planned} UPDATE${planned === 1 ? '' : 's'} to ${OUT_FILE}`)
  console.log(`review it, then apply: bunx wrangler d1 execute ${DB_NAME} --remote --file ${OUT_FILE}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
