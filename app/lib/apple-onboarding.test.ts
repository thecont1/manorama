import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import {
  deleteAppleOnboarding,
  readAppleOnboarding,
  stashAppleOnboarding,
} from './identity-repository'
import { confirmPendingAccount, stateCookieName } from './oauth-flow'
import { createAuthFlow, pkceChallenge, randomBase64Url } from './auth-flows'
import { createPendingAccountToken } from './session'
import { applySetCookie, TEST_SESSION_SECRET } from './test-fixtures'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const applyMigration = async (db: D1Database, name: string) => {
  const sql = readFileSync(`${repoRoot}/migrations/${name}`, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  for (const statement of sql.split(';')) {
    const trimmed = statement.trim()
    if (trimmed) await db.prepare(trimmed).run()
  }
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null
const db = () => proxy!.env.DB
const env = () => ({ DB: db(), HOST_API_JWT_SECRET: TEST_SESSION_SECRET })

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: `${repoRoot}/wrangler.toml`,
    persist: false,
  })
  // Production ran every migration in order; empty tables make the
  // data-dependent ones no-ops, so the chain reproduces the live schema.
  const names = readdirSync(`${repoRoot}/migrations`).filter((name) => name.endsWith('.sql')).sort()
  for (const name of names) await applyMigration(db(), name)
})

afterAll(async () => {
  await proxy?.dispose()
})

/** The confirm POST is bound to the browser by the state cookie — mint both
 *  halves the way the interstitial's real round trip leaves them. */
const confirmAttempt = async (input: { subject: string; name?: string }) => {
  const verifier = randomBase64Url(32)
  const flow = await createAuthFlow({
    provider: 'apple',
    intent: 'signin',
    stateCookieHash: await pkceChallenge(verifier),
  }, { DB: db() })
  const token = await createPendingAccountToken({
    provider: 'apple',
    subject: input.subject,
    name: input.name,
    state: flow.state,
    stateCookieHash: await pkceChallenge(verifier),
  }, TEST_SESSION_SECRET)
  const cookie = `${stateCookieName(flow.state)}=${verifier}`
  return { token, cookie }
}

const postConfirm = async (attempt: { token: string; cookie: string }) => {
  const app = new Hono()
  app.post('/auth/confirm-account', confirmPendingAccount)
  return app.request('/auth/confirm-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: attempt.cookie },
    body: `token=${encodeURIComponent(attempt.token)}`,
  }, env())
}

describe('the apple onboarding stash', () => {
  test('a read preserves the row until the success path deletes it', async () => {
    await stashAppleOnboarding('apple-sub-once', 'Meera Krishnan', { DB: db() })
    expect(await readAppleOnboarding('apple-sub-once', { DB: db() })).toBe('Meera Krishnan')
    // A retry after a failed creation must still find the name — the read
    // is not a consume.
    expect(await readAppleOnboarding('apple-sub-once', { DB: db() })).toBe('Meera Krishnan')
    await deleteAppleOnboarding('apple-sub-once', { DB: db() })
    expect(await readAppleOnboarding('apple-sub-once', { DB: db() })).toBeNull()
  })

  test('an expired row answers absent and is reaped', async () => {
    await stashAppleOnboarding('apple-sub-stale', 'Stale Name', { DB: db() })
    await db().prepare("UPDATE apple_onboarding SET expires_at = datetime('now', '-1 minute') WHERE subject = ?")
      .bind('apple-sub-stale').run()
    expect(await readAppleOnboarding('apple-sub-stale', { DB: db() })).toBeNull()
    expect(await db().prepare('SELECT COUNT(*) AS n FROM apple_onboarding WHERE subject = ?')
      .bind('apple-sub-stale').first<{ n: number }>()).toEqual({ n: 0 })
  })

  test('a neighbouring subject cannot read it', async () => {
    await stashAppleOnboarding('apple-sub-mine', 'Mine Alone', { DB: db() })
    expect(await readAppleOnboarding('apple-sub-other', { DB: db() })).toBeNull()
    expect(await readAppleOnboarding('apple-sub-mine', { DB: db() })).toBe('Mine Alone')
    await deleteAppleOnboarding('apple-sub-mine', { DB: db() })
  })

  test('a nameless confirm mints the account under the stashed name', async () => {
    await stashAppleOnboarding('apple-sub-confirm', 'Meera Krishnan', { DB: db() })
    const attempt = await confirmAttempt({ subject: 'apple-sub-confirm' })
    const response = await postConfirm(attempt)
    expect(response.status).toBe(302)
    const created = await db().prepare(
      `SELECT u.display_name, u.owner_slug FROM users u
       JOIN auth_identities ai ON ai.account_id = u.account_id
       WHERE ai.provider = 'apple' AND ai.provider_subject = ?`,
    ).bind('apple-sub-confirm').first<{ display_name: string; owner_slug: string }>()
    expect(created?.display_name).toBe('Meera Krishnan')
    expect(created?.owner_slug).toBe('meera-krishnan')
    // Consumed — a second account for the same subject can never reuse it.
    expect(await db().prepare('SELECT COUNT(*) AS n FROM apple_onboarding WHERE subject = ?')
      .bind('apple-sub-confirm').first<{ n: number }>()).toEqual({ n: 0 })
  })

  test('the web consent\'s own name wins over the stash', async () => {
    await stashAppleOnboarding('apple-sub-both', 'Stashed Name', { DB: db() })
    const attempt = await confirmAttempt({ subject: 'apple-sub-both', name: 'Fresh Name' })
    const response = await postConfirm(attempt)
    expect(response.status).toBe(302)
    const created = await db().prepare(
      `SELECT u.display_name FROM users u
       JOIN auth_identities ai ON ai.account_id = u.account_id
       WHERE ai.provider = 'apple' AND ai.provider_subject = ?`,
    ).bind('apple-sub-both').first<{ display_name: string }>()
    expect(created?.display_name).toBe('Fresh Name')
  })

  test('no stash falls back to the random-slug account shape', async () => {
    const attempt = await confirmAttempt({ subject: 'apple-sub-plain' })
    const response = await postConfirm(attempt)
    expect(response.status).toBe(302)
    const created = await db().prepare(
      `SELECT u.display_name, u.owner_slug FROM users u
       JOIN auth_identities ai ON ai.account_id = u.account_id
       WHERE ai.provider = 'apple' AND ai.provider_subject = ?`,
    ).bind('apple-sub-plain').first<{ display_name: string; owner_slug: string }>()
    expect(created?.display_name).toBe('Photographer')
    expect(created?.owner_slug).not.toBe('photographer')
  })
})
