import type { D1Database } from '@cloudflare/workers-types'

/**
 * Master plate suppression. The owner can hide house plates for a UTC day or
 * a viewer region; the public visibility endpoint reads this store per
 * request and the native client fails open (shows plates) when it cannot be
 * reached — suppression is a courtesy, never a gate.
 *
 * Without a D1 binding (dev, tests) an in-memory store is used.
 */
export type AdSuppressionKind = 'day' | 'region'

export type AdSuppression = {
  id: number
  kind: AdSuppressionKind
  /** 'YYYY-MM-DD' for days, ISO-3166 alpha-2 for regions. */
  value: string
  createdAt: string
}

export type AdVisibilityEnv = { DB?: D1Database }

type SuppressionRow = { id: number; kind: string; value: string; created_at: string }

const runtimeSuppressions = new Map<string, AdSuppression>()
let runtimeId = 0

const d1Configured = (env?: AdVisibilityEnv): env is AdVisibilityEnv & { DB: D1Database } =>
  Boolean(env?.DB)

const keyFor = (kind: AdSuppressionKind, value: string) => `${kind}:${value}`

/** Resets only the in-memory store — test and dev-server state. */
export const resetAdSuppressionStore = () => {
  runtimeSuppressions.clear()
  runtimeId = 0
}

const rowToSuppression = (row: SuppressionRow): AdSuppression => ({
  id: row.id,
  kind: row.kind === 'region' ? 'region' : 'day',
  value: row.value,
  createdAt: row.created_at,
})

export const listAdSuppressions = async (env?: AdVisibilityEnv): Promise<AdSuppression[]> => {
  if (!d1Configured(env)) {
    return [...runtimeSuppressions.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value))
  }
  const result = await env.DB.prepare(
    'SELECT id, kind, value, created_at FROM ad_suppressions ORDER BY kind, value',
  ).all<SuppressionRow>()
  return (result.results ?? []).map(rowToSuppression)
}

/** Adds a suppression; idempotent so the toggle can be retapped safely. */
export const setAdSuppression = async (kind: AdSuppressionKind, value: string, env?: AdVisibilityEnv): Promise<void> => {
  if (!d1Configured(env)) {
    runtimeSuppressions.set(keyFor(kind, value), {
      id: ++runtimeId,
      kind,
      value,
      createdAt: new Date().toISOString(),
    })
    return
  }
  await env.DB.prepare(
    'INSERT OR IGNORE INTO ad_suppressions (kind, value) VALUES (?, ?)',
  ).bind(kind, value).run()
}

export const clearAdSuppression = async (kind: AdSuppressionKind, value: string, env?: AdVisibilityEnv): Promise<void> => {
  if (!d1Configured(env)) {
    runtimeSuppressions.delete(keyFor(kind, value))
    return
  }
  await env.DB.prepare(
    'DELETE FROM ad_suppressions WHERE kind = ? AND value = ?',
  ).bind(kind, value).run()
}

/** A plate is suppressed when the viewer's UTC day OR geo region is listed. */
export const adSuppressionFor = async (day: string, region: string, env?: AdVisibilityEnv): Promise<'day' | 'region' | null> => {
  if (!d1Configured(env)) {
    if (runtimeSuppressions.has(keyFor('day', day))) return 'day'
    if (region && runtimeSuppressions.has(keyFor('region', region))) return 'region'
    return null
  }
  const row = await env.DB.prepare(
    'SELECT kind FROM ad_suppressions WHERE (kind = ? AND value = ?) OR (kind = ? AND value = ?) LIMIT 1',
  ).bind('day', day, 'region', region).first<{ kind: string }>()
  if (!row) return null
  return row.kind === 'region' ? 'region' : 'day'
}
