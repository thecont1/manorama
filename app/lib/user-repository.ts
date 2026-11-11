import type { D1Database } from '@cloudflare/workers-types'
import { isMasterAccountId, type MasterAccountEnv } from './master-accounts'

/**
 * Manorama user accounts. Identity is the immutable account ID —
 * never an email. The owner_slug is the user-facing URL segment
 * (`/<owner_slug>/...`) and can change at any time; galleries reference
 * the account ID, so a slug change never orphans them.
 */

export type UserRecord = {
  accountId: string
  ownerSlug: string
  displayName: string
  email?: string
  tier: 'free' | 'pro'
  billingEventTimestampMs?: number
  billingEventId?: string
  lastSeenCountry?: string
  /** IATA code of the Cloudflare edge datacenter that served the last
   *  sign-in (SIN, BOM…) — the location signal that isn't a stored IP. */
  lastSeenColo?: string
  /** When that last sign-in happened — the datetime behind the ops table's
   *  Last seen column. */
  lastSeenAt?: string
  /** Set when the master suspends sign-in; NULL/absent means active. The rows
   *  stay — disabling is deliberately non-destructive. */
  disabledAt?: string
  /** Rewritten on every disable/enable flip. Survives re-enable so tokens
   *  minted before the suspension stay dead instead of resurrecting. */
  sessionsRevokedAt?: string
  createdAt?: string
  updatedAt?: string
}

export type AdminUserSummary = UserRecord & {
  galleryCount: number
  deviceGalleryCount: number
  identityCount: number
  /** Provider of the account's earliest identity — how it first signed in. */
  primaryProvider?: 'dropbox' | 'google' | 'apple'
  createdAt?: string
  updatedAt?: string
  isMaster: boolean
}

export type AdminUserList = {
  users: AdminUserSummary[]
  total: number
}

export type UserRepositoryEnv = { DB?: D1Database }

export type BillingEventOrder = {
  timestampMs: number
  eventId: string
}

export const OWNER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const OWNER_SLUG_MAX = 48
export const OWNER_SLUG_MIN = 3

// In-memory fallback for runtimes without the D1 binding (vite dev, tests).
// Keyed by account ID, with an owner-slug index for lookups.
const users = new Map<string, UserRecord>()
const ownerSlugIndex = new Map<string, string>()
// slug → the account that last held it. Released slugs never go back on
// the market — only the same account may reclaim one, so an old shared
// link can never start serving a stranger's galleries.
const ownerSlugReservations = new Map<string, string>()

const d1Configured = (env?: UserRepositoryEnv): env is UserRepositoryEnv & { DB: D1Database } =>
  Boolean(env?.DB)

const rowToUser = (row: Record<string, unknown> | null): UserRecord | null => {
  if (!row || typeof row.account_id !== 'string') return null
  const user: UserRecord = {
    accountId: row.account_id,
    ownerSlug: row.owner_slug as string,
    displayName: row.display_name as string,
    tier: row.tier === 'pro' ? 'pro' : 'free',
  }
  if (typeof row.email === 'string' && row.email.length > 0) user.email = row.email
  if (typeof row.billing_event_timestamp_ms === 'number') {
    user.billingEventTimestampMs = row.billing_event_timestamp_ms
  }
  if (typeof row.billing_event_id === 'string' && row.billing_event_id.length > 0) {
    user.billingEventId = row.billing_event_id
  }
  if (typeof row.last_seen_country === 'string' && row.last_seen_country.length > 0) {
    user.lastSeenCountry = row.last_seen_country
  }
  if (typeof row.last_seen_colo === 'string' && row.last_seen_colo.length > 0) {
    user.lastSeenColo = row.last_seen_colo
  }
  if (typeof row.last_seen_at === 'string' && row.last_seen_at.length > 0) {
    user.lastSeenAt = row.last_seen_at
  }
  if (typeof row.disabled_at === 'string' && row.disabled_at.length > 0) {
    user.disabledAt = row.disabled_at
  }
  if (typeof row.sessions_revoked_at === 'string' && row.sessions_revoked_at.length > 0) {
    user.sessionsRevokedAt = row.sessions_revoked_at
  }
  if (typeof row.created_at === 'string') user.createdAt = row.created_at
  if (typeof row.updated_at === 'string') user.updatedAt = row.updated_at
  return user
}

export const slugifyName = (name: string) => name
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, OWNER_SLUG_MAX)

const ownerSlugTaken = async (slug: string, env?: UserRepositoryEnv) => {
  if (d1Configured(env)) {
    const row = await env.DB.prepare('SELECT 1 FROM users WHERE owner_slug = ?').bind(slug).first()
    return row !== null
  }
  return ownerSlugIndex.has(slug)
}

/** The account a released slug still belongs to — null when the slug was
 *  never used. Reservations outlive accounts by design. */
const ownerSlugReservedBy = async (slug: string, env?: UserRepositoryEnv): Promise<string | null> => {
  if (d1Configured(env)) {
    const row = await env.DB.prepare(
      'SELECT account_id FROM owner_slug_reservations WHERE owner_slug = ?',
    ).bind(slug).first<{ account_id: string }>()
    return row?.account_id ?? null
  }
  return ownerSlugReservations.get(slug) ?? null
}

/** Reserves a unique owner slug derived from a display name:
 * `mahesh-v`, then `mahesh-v-2`, `mahesh-v-3`, ... A new account may hold
 * no history, so every reserved slug is off-limits here regardless of who
 * reserved it. */
const deriveOwnerSlug = async (displayName: string, env?: UserRepositoryEnv) => {
  const base = slugifyName(displayName) || 'photographer'
  let slug = base
  let suffix = 2
  while (await ownerSlugTaken(slug, env) || (await ownerSlugReservedBy(slug, env)) !== null) {
    slug = `${base}-${suffix}`
    suffix += 1
  }
  return slug
}

/**
 * Creates the user on first sign-in and refreshes the profile (name,
 * email) on every later sign-in. The owner slug is minted once and never
 * touched here — only `updateOwnerSlug` changes it.
 */
export const upsertUser = async (
  account: { accountId: string; displayName: string; email?: string },
  env?: UserRepositoryEnv,
): Promise<UserRecord> => {
  const displayName = account.displayName.trim().slice(0, 120) || 'Photographer'
  const email = account.email?.trim() || undefined
  if (d1Configured(env)) {
    const existing = await env.DB
      .prepare('SELECT * FROM users WHERE account_id = ?')
      .bind(account.accountId)
      .first()
    if (existing) {
      await env.DB.prepare(
        `UPDATE users SET display_name = ?, email = ?, updated_at = datetime('now') WHERE account_id = ?`,
      ).bind(displayName, email ?? null, account.accountId).run()
      const updated = await env.DB
        .prepare('SELECT * FROM users WHERE account_id = ?')
        .bind(account.accountId)
        .first()
      return rowToUser(updated as Record<string, unknown>)!
    }
    // The reservation guard rides inside the INSERT: a released slug
    // cannot be claimed even if a rename lands between derive and write.
    const insertUser = (ownerSlug: string) => env.DB.prepare(
      `INSERT INTO users (account_id, owner_slug, display_name, email)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM owner_slug_reservations WHERE owner_slug = ?)`,
    ).bind(account.accountId, ownerSlug, displayName, email ?? null, ownerSlug).run()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ownerSlug = await deriveOwnerSlug(displayName, env)
      try {
        if ((await insertUser(ownerSlug)).meta.changes) break
        continue // reservation won the race — derive the next candidate
      } catch (error) {
        if (!String(error).includes('UNIQUE')) throw error
        // A concurrent sign-in may have created this user (account_id PK
        // conflict) OR claimed the same owner_slug. Query by account_id;
        // if the user exists, refresh the profile instead of retrying.
        const concurrent = await env.DB
          .prepare('SELECT * FROM users WHERE account_id = ?')
          .bind(account.accountId)
          .first()
        if (concurrent) {
          await env.DB.prepare(
            `UPDATE users SET display_name = ?, email = ?, updated_at = datetime('now') WHERE account_id = ?`,
          ).bind(displayName, email ?? null, account.accountId).run()
          const updated = await env.DB
            .prepare('SELECT * FROM users WHERE account_id = ?')
            .bind(account.accountId)
            .first()
          return rowToUser(updated as Record<string, unknown>)!
        }
        // The conflict was on owner_slug, not account_id — loop derives
        // a fresh slug on the next pass.
      }
    }
    const created = await env.DB
      .prepare('SELECT * FROM users WHERE account_id = ?')
      .bind(account.accountId)
      .first()
    if (!created) throw new Error('Could not allocate an owner slug')
    return rowToUser(created as Record<string, unknown>)!
  }
  const existing = users.get(account.accountId)
  if (existing) {
    existing.displayName = displayName
    if (email !== undefined) existing.email = email
    return existing
  }
  const ownerSlug = await deriveOwnerSlug(displayName, env)
  const now = new Date().toISOString()
  const user: UserRecord = { accountId: account.accountId, ownerSlug, displayName, tier: 'free', createdAt: now, updatedAt: now, ...(email !== undefined ? { email } : {}) }
  users.set(user.accountId, user)
  ownerSlugIndex.set(user.ownerSlug, user.accountId)
  return user
}

export const getUserByAccountId = async (
  accountId: string,
  env?: UserRepositoryEnv,
): Promise<UserRecord | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT * FROM users WHERE account_id = ?')
      .bind(accountId)
      .first()
    return rowToUser(row as Record<string, unknown> | null)
  }
  return users.get(accountId) ?? null
}

export const getUserByOwnerSlug = async (
  ownerSlug: string,
  env?: UserRepositoryEnv,
): Promise<UserRecord | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT * FROM users WHERE owner_slug = ?')
      .bind(ownerSlug)
      .first()
    return rowToUser(row as Record<string, unknown> | null)
  }
  const id = ownerSlugIndex.get(ownerSlug)
  return id ? users.get(id) ?? null : null
}

/** Lists account metadata only. This intentionally contains no photo bytes or
 * source URLs; the master console is an operations surface, not a gallery
 * index. The list is unbounded — every account renders — until the base
 * grows large enough to need paging again. */
export const listUsersForAdmin = async (
  env?: UserRepositoryEnv & MasterAccountEnv,
  options: { country?: string; bootstrapAccountId?: string } = {},
): Promise<AdminUserList> => {
  const country = options.country?.trim().toUpperCase() ?? ''
  const bootstrapAccountId = options.bootstrapAccountId?.trim() ?? ''
  if (d1Configured(env)) {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users
       WHERE (? = '' OR COALESCE(last_seen_country, '') = ?)`,
    ).bind(country, country).first<{ total: number }>()
    const result = await env.DB.prepare(`
      SELECT
        u.account_id,
        u.owner_slug,
        u.display_name,
        u.email,
        u.tier,
        u.created_at,
        u.updated_at,
        u.last_seen_country,
        u.last_seen_colo,
        u.last_seen_at,
        u.disabled_at,
        CASE WHEN u.account_id = ? THEN 0 ELSE 1 END AS bootstrap_order,
        CASE WHEN u.account_id = ? OR EXISTS (
          SELECT 1 FROM master_accounts m WHERE m.account_id = u.account_id
        ) THEN 1 ELSE 0 END AS is_master,
        (SELECT COUNT(*) FROM galleries g WHERE g.owner_id = u.account_id) AS gallery_count,
        (SELECT COUNT(DISTINCT d.device_id) FROM device_galleries d WHERE d.owner_id = u.account_id) AS device_gallery_count,
        (SELECT COUNT(*) FROM auth_identities i WHERE i.account_id = u.account_id) AS identity_count,
        (SELECT i.provider FROM auth_identities i WHERE i.account_id = u.account_id
          ORDER BY i.created_at ASC, i.provider ASC LIMIT 1) AS primary_provider
      FROM users u
      WHERE (? = '' OR COALESCE(u.last_seen_country, '') = ?)
      ORDER BY bootstrap_order ASC, is_master DESC, u.created_at DESC, u.account_id ASC
    `).bind(bootstrapAccountId, bootstrapAccountId, country, country).all<Record<string, unknown>>()
    const users = (result.results ?? []).flatMap((row) => {
      const user = rowToUser(row)
      if (!user) return []
      return [{
        ...user,
        galleryCount: Number(row.gallery_count) || 0,
        deviceGalleryCount: Number(row.device_gallery_count) || 0,
        identityCount: Number(row.identity_count) || 0,
        isMaster: Number(row.is_master) === 1,
        ...(typeof row.primary_provider === 'string'
          ? { primaryProvider: row.primary_provider as 'dropbox' | 'google' | 'apple' }
          : {}),
        ...(typeof row.created_at === 'string' ? { createdAt: row.created_at } : {}),
        ...(typeof row.updated_at === 'string' ? { updatedAt: row.updated_at } : {}),
      }]
    })
    const total = Number(totalRow?.total) || 0
    return { users, total }
  }
  const allUsers = [...users.values()].map((user) => ({
    ...user,
    galleryCount: 0,
    deviceGalleryCount: 0,
    identityCount: 0,
    isMaster: false,
  }))
  for (const user of allUsers) user.isMaster = await isMasterAccountId(user.accountId, env)
  const filtered = country ? allUsers.filter((user) => user.lastSeenCountry === country) : allUsers
  filtered.sort((a, b) => Number(b.accountId === bootstrapAccountId) - Number(a.accountId === bootstrapAccountId)
    || Number(b.isMaster) - Number(a.isMaster)
    || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    || a.accountId.localeCompare(b.accountId))
  return { users: filtered, total: filtered.length }
}

/** Stamps the sign-in's place and time. The timestamp always moves;
 *  country/colo write only when cf supplied a valid value — an absent
 *  edge (vite dev, tests) must never blank a real reading. */
export const setLastSeenLocation = async (
  accountId: string,
  country: string | undefined,
  colo: string | undefined,
  env?: UserRepositoryEnv,
  /** When >0, the write is refused while the stored stamp is fresher than
   *  this many milliseconds — the throttle rides inside the UPDATE, so a
   *  cold isolate cannot double-stamp the same day. */
  onlyIfStaleMs = 0,
): Promise<void> => {
  const validCountry = country && /^[A-Z]{2}$/.test(country) ? country : undefined
  const validColo = colo && /^[A-Z]{3}$/.test(colo) ? colo : undefined
  if (d1Configured(env)) {
    const sets = ['last_seen_at = datetime(\'now\')']
    const binds: string[] = []
    if (validCountry) { sets.push('last_seen_country = ?'); binds.push(validCountry) }
    if (validColo) { sets.push('last_seen_colo = ?'); binds.push(validColo) }
    const stale = onlyIfStaleMs > 0
      ? ` AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-${Math.max(1, Math.round(onlyIfStaleMs / 1000))} seconds'))`
      : ''
    await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE account_id = ?${stale}`).bind(...binds, accountId).run()
    return
  }
  const user = users.get(accountId)
  if (user) {
    if (onlyIfStaleMs > 0 && user.lastSeenAt && Date.now() - Date.parse(`${user.lastSeenAt.replace(' ', 'T')}Z`) < onlyIfStaleMs) return
    user.lastSeenAt = new Date().toISOString().replace('T', ' ').slice(0, 19)
    if (validCountry) user.lastSeenCountry = validCountry
    if (validColo) user.lastSeenColo = validColo
  }
}

/** How often activity may move the stamp — one write per day per account. */
export const LAST_ACTIVITY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** A rejected write is retried after this pause, not on the next request —
 *  a persistent D1 outage must not turn every API call into a doomed write. */
const LAST_ACTIVITY_RETRY_BACKOFF_MS = 5 * 60 * 1000

/** Isolate-local throttle: an isolate that already stamped an account today
 *  skips the UPDATE entirely, so routine traffic costs no D1 op at all. A
 *  cold isolate may write once more — the stale-guard inside the UPDATE
 *  still caps the day at one persisted stamp. */
const lastActivityStamped = new Map<string, number>()

/** Marks real account activity on traffic the app already makes — no
 *  beacon, no extra request, no new data (the geo is the `cf` Cloudflare
 *  supplies on every request anyway). Fire-and-forget; the write can never
 *  fail the request it rode in on. */
export const touchLastSeen = (
  accountId: string,
  cf: { country?: unknown; colo?: unknown } | undefined,
  env?: UserRepositoryEnv,
  executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void },
): void => {
  const stamped = lastActivityStamped.get(accountId)
  const now = Date.now()
  if (stamped && now - stamped < LAST_ACTIVITY_INTERVAL_MS) return
  lastActivityStamped.set(accountId, now)
  const write = setLastSeenLocation(
    accountId,
    typeof cf?.country === 'string' ? cf.country : undefined,
    typeof cf?.colo === 'string' ? cf.colo : undefined,
    env,
    LAST_ACTIVITY_INTERVAL_MS,
  ).catch(() => {
    // Keep a shortened stamp — the next touch waits out the backoff rather
    // than retrying a write that just failed.
    lastActivityStamped.set(accountId, Date.now() - LAST_ACTIVITY_INTERVAL_MS + LAST_ACTIVITY_RETRY_BACKOFF_MS)
  })
  if (executionCtx?.waitUntil) executionCtx.waitUntil(write)
  else void write
}

/** Sets or clears an account's sign-in suspension. Disabling is a flag flip,
 *  not a delete — galleries, identities, and tier all stay so enabling restores
 *  the account exactly as it was. The flag lands in `disabled_at` (a timestamp,
 *  not a boolean, so the audit trail keeps when it happened). */
export const setUserDisabled = async (
  accountId: string,
  disabled: boolean,
  env?: UserRepositoryEnv,
  now = new Date().toISOString(),
): Promise<UserRecord | null> => {
  const current = await getUserByAccountId(accountId, env)
  if (!current) return null
  // Idempotent flips are a no-op: restamping the markers would rewrite the
  // suspension timestamp and kill sessions minted since the real transition.
  if (Boolean(current.disabledAt) === disabled) return current
  if (d1Configured(env)) {
    await env.DB.prepare(
      `UPDATE users SET disabled_at = ?, sessions_revoked_at = ?, updated_at = datetime('now') WHERE account_id = ?`,
    ).bind(disabled ? now : null, now, accountId).run()
    return getUserByAccountId(accountId, env)
  }
  const user = users.get(accountId)
  if (!user) return null
  if (disabled) user.disabledAt = now
  else delete user.disabledAt
  user.sessionsRevokedAt = now
  return { ...user }
}

export class OwnerSlugError extends Error {}

/** Promotes or demotes an account's tier. Promotion also converts every
 *  unexpired pipeline gallery to retained and clears its deadline. There is no
 *  self-serve billing seam yet — upgrades land through this (or a manual D1
 *  update) only. Sign-in never writes tier: upsertUser keeps what is stored. */
export const setUserTier = async (
  accountId: string,
  tier: 'free' | 'pro',
  env?: UserRepositoryEnv,
  now = new Date().toISOString(),
  billingEvent?: BillingEventOrder,
): Promise<UserRecord | null> => {
  const current = await getUserByAccountId(accountId, env)
  if (!current) return null
  if (billingEvent && current.billingEventTimestampMs !== undefined) {
    const isOlder = billingEvent.timestampMs < current.billingEventTimestampMs
      || (billingEvent.timestampMs === current.billingEventTimestampMs
        && billingEvent.eventId <= (current.billingEventId ?? ''))
    if (isOlder) return null
  }
  if (d1Configured(env)) {
    if (billingEvent) {
      const eventTimestamp = billingEvent.timestampMs
      const eventId = billingEvent.eventId
      const update = await env.DB.prepare(
        `UPDATE users SET tier = ?, updated_at = ?, billing_event_timestamp_ms = ?, billing_event_id = ?
         WHERE account_id = ? AND (
           billing_event_timestamp_ms IS NULL
           OR billing_event_timestamp_ms < ?
           OR (billing_event_timestamp_ms = ? AND COALESCE(billing_event_id, '') < ?)
         )`,
      ).bind(tier, now, eventTimestamp, eventId, accountId, eventTimestamp, eventTimestamp, eventId)
      const statements = tier === 'pro'
        ? [
            update,
            env.DB.prepare(
              `UPDATE galleries SET retention = 'retained', expires_at = NULL
               WHERE owner_id = ? AND retention = 'pipeline' AND expires_at > ?`,
            ).bind(accountId, now),
          ]
        : [
            update,
            // A demotion ends Local galleries — the synced rows are the
            // devices' own catalogues, so they go rather than linger
            // served. The EXISTS guard ties the delete to *this* event's
            // stamp: a stale event that fails the ordering update leaves
            // different event fields stored and deletes nothing.
            env.DB.prepare(
              `DELETE FROM device_galleries WHERE owner_id = ? AND EXISTS (
                 SELECT 1 FROM users
                 WHERE users.account_id = device_galleries.owner_id
                   AND users.billing_event_timestamp_ms = ?
                   AND users.billing_event_id = ?
               )`,
            ).bind(accountId, eventTimestamp, eventId),
          ]
      const results = await env.DB.batch(statements)
      if (!results[0].meta.changes) return null
      return {
        ...current,
        tier,
        billingEventTimestampMs: eventTimestamp,
        billingEventId: eventId,
      }
    }
    if (tier === 'pro') {
      await env.DB.batch([
        env.DB.prepare(`UPDATE users SET tier = ?, updated_at = ? WHERE account_id = ?`).bind(tier, now, accountId),
        env.DB.prepare(`UPDATE galleries SET retention = 'retained', expires_at = NULL WHERE owner_id = ? AND retention = 'pipeline' AND expires_at > ?`).bind(accountId, now),
      ])
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET tier = ?, updated_at = datetime('now') WHERE account_id = ?`,
        ).bind(tier, accountId),
        env.DB.prepare('DELETE FROM device_galleries WHERE owner_id = ?').bind(accountId),
      ])
    }
    return { ...current, tier }
  }
  if (billingEvent) {
    current.billingEventTimestampMs = billingEvent.timestampMs
    current.billingEventId = billingEvent.eventId
  }
  if (tier === 'pro') {
    const { promotePipelineGalleries } = await import('./gallery-repository')
    current.tier = tier
    await promotePipelineGalleries(accountId, now, env)
  } else current.tier = tier
  return { ...current }
}

/** Validates and applies a new owner slug. Galleries follow automatically:
 * they reference the account ID, so their public URLs derive from the new
 * slug the moment it changes. Throws OwnerSlugError with a friendly
 * message on invalid input or collisions. */
export const updateOwnerSlug = async (
  accountId: string,
  nextSlug: string,
  env?: UserRepositoryEnv,
): Promise<UserRecord> => {
  const slug = nextSlug.trim().toLowerCase()
  if (slug.length < OWNER_SLUG_MIN || slug.length > OWNER_SLUG_MAX || !OWNER_SLUG_PATTERN.test(slug)) {
    throw new OwnerSlugError(`Use ${OWNER_SLUG_MIN}-${OWNER_SLUG_MAX} lowercase letters, numbers, and single hyphens`)
  }
  const taken = await ownerSlugTaken(slug, env)
  const current = await getUserByAccountId(accountId, env)
  if (!current) throw new OwnerSlugError('Sign in again before changing your URL')
  if (taken && slug !== current.ownerSlug) throw new OwnerSlugError('That URL is already in use')
  // History counts as ownership: a slug another account once released can
  // never be claimed — old links die rather than change hands. Only the
  // account that released it may take it back.
  const reservedBy = await ownerSlugReservedBy(slug, env)
  if (reservedBy !== null && reservedBy !== accountId) throw new OwnerSlugError('That URL is already in use')
  if (slug === current.ownerSlug) return current
  if (d1Configured(env)) {
    try {
      await env.DB.batch([
        // The outgoing slug stays this account's forever — the same rename
        // may release it more than once over the account's life.
        env.DB.prepare(
          'INSERT OR IGNORE INTO owner_slug_reservations (owner_slug, account_id) VALUES (?, ?)',
        ).bind(current.ownerSlug, accountId),
        env.DB.prepare(
          `UPDATE users SET owner_slug = ?, updated_at = datetime('now') WHERE account_id = ?`,
        ).bind(slug, accountId),
      ])
    } catch (error) {
      // UNIQUE constraint failure on owner_slug — another user holds it.
      if (String(error).includes('UNIQUE')) throw new OwnerSlugError('That URL is already in use')
      throw error
    }
  } else {
    ownerSlugIndex.delete(current.ownerSlug)
    ownerSlugReservations.set(current.ownerSlug, accountId)
    current.ownerSlug = slug
    ownerSlugIndex.set(slug, accountId)
  }
  return { ...current, ownerSlug: slug }
}

/**
 * Removes the account and every row that references it — galleries, sign-in
 * methods, in-flight auth flows, and the device catalogue — in one batch so
 * no child row can outlive the user. ad_suppressions is a global switch list
 * and the RevenueCat ordering fields are user columns; neither survives the
 * account because neither is a separate table. Nothing at any provider is
 * touched. Returns false when the account was already gone so a repeated
 * call stays safe.
 */
export const deleteAccount = async (accountId: string, env?: UserRepositoryEnv): Promise<boolean> => {
  if (d1Configured(env)) {
    const results = await env.DB.batch([
      // Reserve the outgoing slug first — the row must survive the user
      // delete in the same batch, so a deleted account's address can never
      // be recycled into someone else's gallery links.
      env.DB.prepare(
        'INSERT OR IGNORE INTO owner_slug_reservations (owner_slug, account_id) SELECT owner_slug, account_id FROM users WHERE account_id = ?',
      ).bind(accountId),
      env.DB.prepare('DELETE FROM auth_identities WHERE account_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM auth_flows WHERE account_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM device_galleries WHERE owner_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM galleries WHERE owner_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM gallery_keys WHERE owner_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM owner_key_vault WHERE owner_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM master_accounts WHERE account_id = ?').bind(accountId),
      env.DB.prepare('DELETE FROM users WHERE account_id = ?').bind(accountId),
    ])
    return (results[results.length - 1]?.meta.changes ?? 0) > 0
  }
  const user = users.get(accountId)
  if (!user) return false
  ownerSlugReservations.set(user.ownerSlug, accountId)
  users.delete(accountId)
  ownerSlugIndex.delete(user.ownerSlug)
  const { dropOwnerGalleries } = await import('./gallery-repository')
  dropOwnerGalleries(accountId)
  const { dropOwnerKeyVault } = await import('./key-vault-repository')
  await dropOwnerKeyVault(accountId)
  return true
}

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetUserStore = () => {
  users.clear()
  ownerSlugIndex.clear()
  ownerSlugReservations.clear()
  lastActivityStamped.clear()
}
