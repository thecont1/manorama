import type { D1Database } from '@cloudflare/workers-types'
import type { Context, Next } from 'hono'

/**
 * Opt-in local D1 for `bun run dev` (MANORAMA_DEV_D1=1).
 *
 * vite dev has no Worker bindings, so c.env carries plain env vars only.
 * Most repositories fall back to in-memory Maps without DB, but
 * auth_identities deliberately fails closed — there is no way to finish a
 * real provider OAuth in dev without one. When the flag is set, the
 * dev-seed plugin boots a wrangler platform proxy, applies migrations, and
 * parks the binding plus a readiness promise on the shared globalThis.
 * This middleware waits for that boot to settle, then exposes the binding
 * as env.DB so request handlers see exactly what a Worker would.
 * Production never sets the globals, so this is a no-op there.
 */
export const injectDevD1 = async (c: Context, next: Next) => {
  const g = globalThis as {
    __manoramaDevD1?: D1Database
    __manoramaDevD1Ready?: Promise<unknown>
  }
  if (g.__manoramaDevD1Ready) await g.__manoramaDevD1Ready.catch(() => undefined)
  const env = (c.env ?? {}) as Record<string, unknown>
  if (!env.DB && g.__manoramaDevD1) (c as { env: unknown }).env = { ...env, DB: g.__manoramaDevD1 }
  await next()
}

export type DevMigrationFile = { name: string; sql: string }

export const DEV_MIGRATIONS_TABLE = 'd1_migrations'

/**
 * Applies migration files in name order, recording each in
 * `d1_migrations` — the same tracking table wrangler itself keeps — so
 * repeat runs apply only what is new. Returns the names applied this run.
 * Statements are split on `;` after stripping `--` comment lines, matching
 * the helper every migration test already uses; the files under
 * migrations/ carry no semicolons inside literals.
 */
export const applyDevMigrations = async (
  db: D1Database,
  files: readonly DevMigrationFile[],
): Promise<string[]> => {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${DEV_MIGRATIONS_TABLE} (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  ).run()
  const applied = new Set(
    ((await db.prepare(`SELECT name FROM ${DEV_MIGRATIONS_TABLE}`).all<{ name: string }>()).results ?? [])
      .map((row) => row.name),
  )
  const ran: string[] = []
  for (const { name, sql } of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (applied.has(name)) continue
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
    // Each migration lands atomically: a crash between statements can't leave
    // half-applied DDL unrecorded for the next boot to trip over.
    await db.batch([
      ...statements.map((statement) => db.prepare(statement)),
      db.prepare(`INSERT INTO ${DEV_MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
        .bind(name, new Date().toISOString()),
    ])
    ran.push(name)
  }
  return ran
}
