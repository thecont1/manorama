import type { D1Database } from '@cloudflare/workers-types'

/**
 * Manorama user accounts. Identity is the immutable Dropbox account ID —
 * never an email. The owner_slug is the user-facing URL segment
 * (`/<owner_slug>/...`) and can change at any time; galleries reference
 * the account ID, so a slug change never orphans them.
 */

export type UserRecord = {
  dropboxAccountId: string
  ownerSlug: string
  displayName: string
  email?: string
  tier: 'free'
}

export type UserRepositoryEnv = { DB?: D1Database }

export const OWNER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const OWNER_SLUG_MAX = 48
export const OWNER_SLUG_MIN = 3

// In-memory fallback for runtimes without the D1 binding (vite dev, tests).
// Keyed by Dropbox account ID, with an owner-slug index for lookups.
const users = new Map<string, UserRecord>()
const ownerSlugIndex = new Map<string, string>()

const d1Configured = (env?: UserRepositoryEnv): env is UserRepositoryEnv & { DB: D1Database } =>
  Boolean(env?.DB)

const rowToUser = (row: Record<string, unknown> | null): UserRecord | null => {
  if (!row || typeof row.dropbox_account_id !== 'string') return null
  const user: UserRecord = {
    dropboxAccountId: row.dropbox_account_id,
    ownerSlug: row.owner_slug as string,
    displayName: row.display_name as string,
    tier: 'free',
  }
  if (typeof row.email === 'string' && row.email.length > 0) user.email = row.email
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

/** Reserves a unique owner slug derived from a display name:
 * `mahesh-v`, then `mahesh-v-2`, `mahesh-v-3`, ... */
const deriveOwnerSlug = async (displayName: string, env?: UserRepositoryEnv) => {
  const base = slugifyName(displayName) || 'photographer'
  let slug = base
  let suffix = 2
  while (await ownerSlugTaken(slug, env)) {
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
  account: { dropboxAccountId: string; displayName: string; email?: string },
  env?: UserRepositoryEnv,
): Promise<UserRecord> => {
  const displayName = account.displayName.trim().slice(0, 120) || 'Photographer'
  const email = account.email?.trim() || undefined
  if (d1Configured(env)) {
    const existing = await env.DB
      .prepare('SELECT * FROM users WHERE dropbox_account_id = ?')
      .bind(account.dropboxAccountId)
      .first()
    if (existing) {
      await env.DB.prepare(
        `UPDATE users SET display_name = ?, email = ?, updated_at = datetime('now') WHERE dropbox_account_id = ?`,
      ).bind(displayName, email ?? null, account.dropboxAccountId).run()
      const updated = await env.DB
        .prepare('SELECT * FROM users WHERE dropbox_account_id = ?')
        .bind(account.dropboxAccountId)
        .first()
      return rowToUser(updated as Record<string, unknown>)!
    }
    const ownerSlug = await deriveOwnerSlug(displayName, env)
    await env.DB.prepare(
      'INSERT INTO users (dropbox_account_id, owner_slug, display_name, email) VALUES (?, ?, ?, ?)',
    ).bind(account.dropboxAccountId, ownerSlug, displayName, email ?? null).run()
    const created = await env.DB
      .prepare('SELECT * FROM users WHERE dropbox_account_id = ?')
      .bind(account.dropboxAccountId)
      .first()
    return rowToUser(created as Record<string, unknown>)!
  }
  const existing = users.get(account.dropboxAccountId)
  if (existing) {
    existing.displayName = displayName
    if (email !== undefined) existing.email = email
    return existing
  }
  const ownerSlug = await deriveOwnerSlug(displayName, env)
  const user: UserRecord = { dropboxAccountId: account.dropboxAccountId, ownerSlug, displayName, tier: 'free', ...(email !== undefined ? { email } : {}) }
  users.set(user.dropboxAccountId, user)
  ownerSlugIndex.set(user.ownerSlug, user.dropboxAccountId)
  return user
}

export const getUserByDropboxId = async (
  dropboxAccountId: string,
  env?: UserRepositoryEnv,
): Promise<UserRecord | null> => {
  if (d1Configured(env)) {
    const row = await env.DB
      .prepare('SELECT * FROM users WHERE dropbox_account_id = ?')
      .bind(dropboxAccountId)
      .first()
    return rowToUser(row as Record<string, unknown> | null)
  }
  return users.get(dropboxAccountId) ?? null
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

export class OwnerSlugError extends Error {}

/** Validates and applies a new owner slug. Galleries follow automatically:
 * they reference the account ID, so their public URLs derive from the new
 * slug the moment it changes. Throws OwnerSlugError with a friendly
 * message on invalid input or collisions. */
export const updateOwnerSlug = async (
  dropboxAccountId: string,
  nextSlug: string,
  env?: UserRepositoryEnv,
): Promise<UserRecord> => {
  const slug = nextSlug.trim().toLowerCase()
  if (slug.length < OWNER_SLUG_MIN || slug.length > OWNER_SLUG_MAX || !OWNER_SLUG_PATTERN.test(slug)) {
    throw new OwnerSlugError(`Use ${OWNER_SLUG_MIN}-${OWNER_SLUG_MAX} lowercase letters, numbers, and single hyphens`)
  }
  const taken = await ownerSlugTaken(slug, env)
  const current = await getUserByDropboxId(dropboxAccountId, env)
  if (!current) throw new OwnerSlugError('Sign in again before changing your URL')
  if (taken && slug !== current.ownerSlug) throw new OwnerSlugError('That URL is already in use')
  if (slug === current.ownerSlug) return current
  if (d1Configured(env)) {
    await env.DB.prepare(
      `UPDATE users SET owner_slug = ?, updated_at = datetime('now') WHERE dropbox_account_id = ?`,
    ).bind(slug, dropboxAccountId).run()
  } else {
    ownerSlugIndex.delete(current.ownerSlug)
    current.ownerSlug = slug
    ownerSlugIndex.set(slug, dropboxAccountId)
  }
  return { ...current, ownerSlug: slug }
}

/** Test seam: reset the in-memory fallback. Production never calls this. */
export const resetUserStore = () => {
  users.clear()
  ownerSlugIndex.clear()
}
