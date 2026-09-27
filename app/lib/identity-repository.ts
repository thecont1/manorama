import type { D1Database } from '@cloudflare/workers-types'
import {
  getUserByAccountId,
  OWNER_SLUG_MAX,
  OWNER_SLUG_MIN,
  slugifyName,
  type UserRecord,
  type UserRepositoryEnv,
} from './user-repository'

export type AuthProvider = 'dropbox' | 'google' | 'apple'

export type IdentityInput = {
  provider: AuthProvider
  subject: string
  displayName?: string
  email?: string
}

export type LinkedIdentity = {
  provider: AuthProvider
  subject: string
  accountId: string
  displayName?: string
  email?: string
}

export class IdentityConflictError extends Error {}
export class LastIdentityError extends Error {}
export class IdentityStorageUnavailableError extends Error {}

const PROVIDERS: readonly string[] = ['dropbox', 'google', 'apple']
const SUBJECT_MAX = 1024
const DISPLAY_NAME_MAX = 120

const requireDb = (env?: UserRepositoryEnv): D1Database => {
  if (!env?.DB) throw new IdentityStorageUnavailableError('Identity storage is not available')
  return env.DB
}

const checked = (identity: IdentityInput) => {
  if (!PROVIDERS.includes(identity.provider)) throw new Error('Unsupported identity provider')
  if (typeof identity.subject !== 'string' || !identity.subject.trim() || identity.subject.length > SUBJECT_MAX) {
    throw new Error('Invalid identity subject')
  }
  const displayName = identity.displayName?.trim().slice(0, DISPLAY_NAME_MAX) || undefined
  const email = identity.email?.trim() || undefined
  return { provider: identity.provider, subject: identity.subject, displayName, email }
}

const checkedProvider = (provider: AuthProvider) => {
  if (!PROVIDERS.includes(provider)) throw new Error('Unsupported identity provider')
  return provider
}

const identityAccountId = async (db: D1Database, provider: AuthProvider, subject: string) => {
  const row = await db
    .prepare('SELECT account_id FROM auth_identities WHERE provider = ? AND provider_subject = ?')
    .bind(provider, subject)
    .first<{ account_id: string }>()
  return row?.account_id ?? null
}

const refreshIdentityMetadata = async (
  db: D1Database,
  provider: AuthProvider,
  subject: string,
  input: { displayName?: string; email?: string },
) => {
  await db.prepare(
    `UPDATE auth_identities SET email = COALESCE(?, email), display_name = COALESCE(?, display_name), updated_at = datetime('now')
     WHERE provider = ? AND provider_subject = ?`,
  ).bind(input.email ?? null, input.displayName ?? null, provider, subject).run()
}

export const findAccountByIdentity = async (
  provider: AuthProvider,
  subject: string,
  env: UserRepositoryEnv,
): Promise<UserRecord | null> => {
  const db = requireDb(env)
  const validated = checked({ provider, subject })
  const accountId = await identityAccountId(db, validated.provider, validated.subject)
  if (!accountId) return null
  return getUserByAccountId(accountId, env)
}

export const upsertIdentitySignIn = async (
  identity: IdentityInput,
  env: UserRepositoryEnv,
): Promise<UserRecord> => {
  const db = requireDb(env)
  const { provider, subject, displayName, email } = checked(identity)
  const existingAccountId = await identityAccountId(db, provider, subject)
  if (existingAccountId) {
    await refreshIdentityMetadata(db, provider, subject, { displayName, email })
    const user = await getUserByAccountId(existingAccountId, env)
    if (user) return user
  }
  const initialName = displayName ?? 'Photographer'
  const slugified = slugifyName(initialName).replace(/-+$/, '')
  const slugBase = slugified.length >= OWNER_SLUG_MIN ? slugified : 'photographer'
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`
    const stem = slugBase.slice(0, OWNER_SLUG_MAX - suffix.length).replace(/-+$/, '')
    const ownerSlug = `${stem}${suffix}`
    const accountId = `acct_${crypto.randomUUID()}`
    try {
      await db.batch([
        db.prepare('INSERT INTO users (account_id, owner_slug, display_name, email) VALUES (?, ?, ?, ?)').bind(accountId, ownerSlug, initialName, email ?? null),
        db.prepare('INSERT INTO auth_identities (provider, provider_subject, account_id, email, display_name) VALUES (?, ?, ?, ?, ?)').bind(provider, subject, accountId, email ?? null, displayName ?? null),
      ])
      const created = await getUserByAccountId(accountId, env)
      if (created) return created
    } catch (error) {
      if (!String(error).includes('UNIQUE')) throw error
      const winnerAccountId = await identityAccountId(db, provider, subject)
      if (winnerAccountId) {
        await refreshIdentityMetadata(db, provider, subject, { displayName, email })
        const winner = await getUserByAccountId(winnerAccountId, env)
        if (winner) return winner
      }
    }
  }
  throw new Error('Could not allocate an owner slug')
}

export const listIdentities = async (
  accountId: string,
  env: UserRepositoryEnv,
): Promise<LinkedIdentity[]> => {
  const db = requireDb(env)
  const rows = await db.prepare(
    'SELECT provider, provider_subject, email, display_name FROM auth_identities WHERE account_id = ? ORDER BY provider',
  ).bind(accountId).all<{ provider: string; provider_subject: string; email: string | null; display_name: string | null }>()
  return (rows.results ?? []).map((row) => ({
    provider: row.provider as AuthProvider,
    subject: row.provider_subject,
    accountId,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.email ? { email: row.email } : {}),
  }))
}

export const linkIdentity = async (
  accountId: string,
  identity: IdentityInput,
  env: UserRepositoryEnv,
): Promise<void> => {
  const db = requireDb(env)
  const { provider, subject, displayName, email } = checked(identity)
  const user = await getUserByAccountId(accountId, env)
  if (!user) throw new Error('Cannot link an identity to an unknown account')
  const boundAccountId = await identityAccountId(db, provider, subject)
  if (boundAccountId) {
    if (boundAccountId !== accountId) throw new IdentityConflictError('That identity is linked to a different account')
    await refreshIdentityMetadata(db, provider, subject, { displayName, email })
    return
  }
  try {
    await db.prepare(
      'INSERT INTO auth_identities (provider, provider_subject, account_id, email, display_name) VALUES (?, ?, ?, ?, ?)',
    ).bind(provider, subject, accountId, email ?? null, displayName ?? null).run()
  } catch (error) {
    if (!String(error).includes('UNIQUE')) throw error
    const racedAccountId = await identityAccountId(db, provider, subject)
    if (racedAccountId) {
      if (racedAccountId !== accountId) throw new IdentityConflictError('That identity is linked to a different account')
      await refreshIdentityMetadata(db, provider, subject, { displayName, email })
      return
    }
    throw new IdentityConflictError('That provider is already linked to this account')
  }
}

export const unlinkIdentity = async (
  accountId: string,
  provider: AuthProvider,
  env: UserRepositoryEnv,
): Promise<boolean> => {
  const db = requireDb(env)
  const checkedProviderName = checkedProvider(provider)
  const result = await db.prepare(
    `DELETE FROM auth_identities
     WHERE account_id = ? AND provider = ?
       AND (SELECT COUNT(*) FROM auth_identities WHERE account_id = ?) > 1`,
  ).bind(accountId, checkedProviderName, accountId).run()
  if ((result.meta.changes ?? 0) > 0) return true
  const stillBound = await db
    .prepare('SELECT 1 AS present FROM auth_identities WHERE account_id = ? AND provider = ?')
    .bind(accountId, checkedProviderName)
    .first()
  if (stillBound) throw new LastIdentityError('The last sign-in method cannot be removed')
  return false
}
