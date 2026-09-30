import type { D1Database } from '@cloudflare/workers-types'

export type MasterAccountEnv = {
  DB?: D1Database
  MASTER_ACCOUNT_ID?: string
  MASTER_DROPBOX_SUBJECT?: string
}

const runtimeMasters = new Set<string>()

const d1Configured = (env?: MasterAccountEnv): env is MasterAccountEnv & { DB: D1Database } => Boolean(env?.DB)

/** Resets only the in-memory role store used by tests and the dev server. */
export const resetMasterAccountStore = () => {
  runtimeMasters.clear()
}

/** Returns the configured bootstrap account, if it can be resolved. */
export const configuredMasterAccountId = async (env?: MasterAccountEnv): Promise<string | null> => {
  const legacy = env?.MASTER_ACCOUNT_ID?.trim()
  if (legacy) return legacy
  const subject = env?.MASTER_DROPBOX_SUBJECT?.trim()
  if (!subject || !d1Configured(env)) return null
  try {
    const row = await env.DB
      .prepare('SELECT account_id FROM auth_identities WHERE provider = ? AND provider_subject = ?')
      .bind('dropbox', subject)
      .first<{ account_id: string }>()
    return row?.account_id ?? null
  } catch {
    return null
  }
}

export const isStoredMasterAccount = async (accountId: string, env?: MasterAccountEnv): Promise<boolean> => {
  if (d1Configured(env)) {
    try {
      const row = await env.DB
        .prepare('SELECT 1 FROM master_accounts WHERE account_id = ?')
        .bind(accountId)
        .first()
      return row !== null
    } catch {
      return false
    }
  }
  return runtimeMasters.has(accountId)
}

export const isMasterAccountId = async (accountId: string, env?: MasterAccountEnv): Promise<boolean> => {
  const configured = await configuredMasterAccountId(env)
  return configured === accountId || await isStoredMasterAccount(accountId, env)
}

export const grantMasterAccount = async (accountId: string, grantedBy: string, env?: MasterAccountEnv): Promise<void> => {
  if (d1Configured(env)) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO master_accounts (account_id, granted_by) VALUES (?, ?)',
    ).bind(accountId, grantedBy).run()
    return
  }
  runtimeMasters.add(accountId)
}

export const revokeMasterAccount = async (accountId: string, env?: MasterAccountEnv): Promise<void> => {
  if (d1Configured(env)) {
    await env.DB.prepare('DELETE FROM master_accounts WHERE account_id = ?').bind(accountId).run()
    return
  }
  runtimeMasters.delete(accountId)
}

export const listStoredMasterAccountIds = async (env?: MasterAccountEnv): Promise<string[]> => {
  if (d1Configured(env)) {
    const result = await env.DB.prepare(
      'SELECT account_id FROM master_accounts ORDER BY granted_at ASC, account_id ASC',
    ).all<{ account_id: string }>()
    return (result.results ?? []).map((row) => row.account_id)
  }
  return [...runtimeMasters].sort()
}
