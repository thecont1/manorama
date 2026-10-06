import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { createSessionToken, resolveManoramaSession, SESSION_COOKIE } from './session'
import {
  type AuthProvider,
  findAccountByIdentity,
  IdentityConflictError,
  IdentityStorageUnavailableError,
  LastIdentityError,
  linkIdentity,
  listIdentities,
  unlinkIdentity,
  upsertIdentitySignIn,
} from './identity-repository'
import { OWNER_SLUG_PATTERN } from './user-repository'
import { createAuthFlow } from './auth-flows'
import { TEST_SESSION_SECRET } from './test-fixtures'
import callbackRoute from '../routes/auth/dropbox/callback'

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

const OWNER_A = 'dbid:AAAownerA'
const OWNER_B = 'dbid:BBBownerB'

let sharedD1: { proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> } | null = null
let usersBefore: Record<string, unknown>[] = []
let galleriesBefore: Record<string, unknown>[] = []
let legacySessionToken = ''
let missingSchemaFailure: unknown

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: `${repoRoot}/wrangler.toml`,
    persist: false,
  })
  sharedD1 = { proxy }
  const db = proxy.env.DB
  try {
    await upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:NOSCHEMA' }, { DB: db })
  } catch (error) {
    missingSchemaFailure = error
  }
  await applyMigration(db, '0001_users_and_galleries.sql')
  await applyMigration(db, '0002_gallery_retention.sql')
  await applyMigration(db, '0003_revenuecat_event_ordering.sql')
  await applyMigration(db, '0004_ad_suppressions.sql')
  await db.prepare(
    `INSERT INTO users (dropbox_account_id, owner_slug, display_name, email, tier, created_at, updated_at, billing_event_timestamp_ms, billing_event_id)
     VALUES (?, ?, ?, ?, 'pro', ?, ?, ?, ?)`,
  ).bind(OWNER_A, 'owner-a', 'Owner A', 'a@manorama.xyz', '2026-01-01 00:00:00', '2026-01-02 00:00:00', 1_900_000_000_000, 'evt-99').run()
  await db.prepare(
    `INSERT INTO users (dropbox_account_id, owner_slug, display_name, email, tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'free', ?, ?)`,
  ).bind(OWNER_B, 'owner-b', 'Owner B', null, '2026-02-01 00:00:00', '2026-02-01 00:00:00').run()
  const insertGallery = `INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at, retention, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  await db.prepare(insertGallery)
    .bind('retained-a', OWNER_A, 'Retained A', 'cap', '2026-03-01', 'https://www.dropbox.com/scl/fo/aaa', '[{"id":"i1","src":"/images/i1.jpg"}]', '2026-03-01 00:00:00', 'retained', null).run()
  await db.prepare(insertGallery)
    .bind('expired-pipe', OWNER_A, 'Expired Pipe', '', '', 'https://www.dropbox.com/scl/fo/bbb', '[]', '2026-04-01 00:00:00', 'pipeline', '2026-01-01 00:00:00').run()
  await db.prepare(insertGallery)
    .bind('live-pipe', OWNER_A, 'Live Pipe', '', '', null, '[]', '2026-05-01 00:00:00', 'pipeline', '2026-12-01 00:00:00').run()
  await db.prepare(insertGallery)
    .bind('solo-b', OWNER_B, 'Solo B', '', '', 'https://www.dropbox.com/scl/fo/ccc', '[{"id":"i2","src":"/images/i2.jpg"}]', '2026-06-01 00:00:00', 'retained', null).run()
  usersBefore = (await db.prepare('SELECT * FROM users ORDER BY dropbox_account_id').all<Record<string, unknown>>()).results ?? []
  galleriesBefore = (await db.prepare('SELECT * FROM galleries ORDER BY owner_id, slug').all<Record<string, unknown>>()).results ?? []
  legacySessionToken = await createSessionToken(OWNER_A, TEST_SESSION_SECRET)
  await applyMigration(db, '0005_provider_neutral_accounts.sql')
  await applyMigration(db, '0006_auth_flows.sql')
}, 15_000)

afterAll(async () => {
  await sharedD1?.proxy.dispose()
  sharedD1 = null
})

const db = () => sharedD1!.proxy.env.DB

describe('migration 0005 renames the account primary key and backfills identities', () => {
  test('user rows are identical except for the renamed column', async () => {
    expect(usersBefore).toHaveLength(2)
    const users = await db().prepare('SELECT * FROM users ORDER BY account_id').all<Record<string, unknown>>()
    expect(users.results).toEqual(usersBefore.map(({ dropbox_account_id, ...rest }) => ({
      account_id: dropbox_account_id,
      ...rest,
    })))
  })

  test('gallery rows survive untouched', async () => {
    expect(galleriesBefore).toHaveLength(4)
    const galleries = await db().prepare('SELECT * FROM galleries ORDER BY owner_id, slug').all<Record<string, unknown>>()
    expect(galleries.results).toEqual(galleriesBefore)
  })

  test('auth_identities carries one dropbox row per account with email and name', async () => {
    const identities = await db().prepare(
      'SELECT provider, provider_subject, account_id, email, display_name FROM auth_identities ORDER BY account_id',
    ).all<Record<string, unknown>>()
    expect(identities.results).toEqual([
      { provider: 'dropbox', provider_subject: OWNER_A, account_id: OWNER_A, email: 'a@manorama.xyz', display_name: 'Owner A' },
      { provider: 'dropbox', provider_subject: OWNER_B, account_id: OWNER_B, email: null, display_name: 'Owner B' },
    ])
  })

  test('the galleries foreign key now targets account_id and no orphans exist', async () => {
    const fks = await db().prepare("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('galleries')").all<Record<string, unknown>>()
    expect(fks.results).toEqual([{ table: 'users', from: 'owner_id', to: 'account_id' }])
    const violations = await db().prepare('SELECT * FROM pragma_foreign_key_check').all()
    expect(violations.results).toEqual([])
  })

  test('identity uniqueness rejects duplicate provider subjects and per-account providers', async () => {
    await expect(db().prepare(
      "INSERT INTO auth_identities (provider, provider_subject, account_id) VALUES ('dropbox', ?, ?)",
    ).bind(OWNER_A, OWNER_B).run()).rejects.toThrow()
    await expect(db().prepare(
      "INSERT INTO auth_identities (provider, provider_subject, account_id) VALUES ('dropbox', 'dbid:CCCother', ?)",
    ).bind(OWNER_A).run()).rejects.toThrow()
    await expect(db().prepare(
      "INSERT INTO auth_identities (provider, provider_subject, account_id) VALUES ('vimeo', 'sub-1', ?)",
    ).bind(OWNER_A).run()).rejects.toThrow()
  })

  test('a pre-migration session JWT resolves the same account by its legacy id', async () => {
    const request = new Request('https://manorama.xyz/api/galleries', {
      headers: { Cookie: `${SESSION_COOKIE}=${legacySessionToken}` },
    })
    const session = await resolveManoramaSession(request, {
      DB: db(),
      HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
    })
    expect(session?.accountId).toBe(OWNER_A)
    expect(session?.id).toBe(`account:${OWNER_A}`)
    expect(session?.ownerSlug).toBe('owner-a')
    expect(session?.tier).toBe('pro')
  })
})

const ACCT_ID = /^acct_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const userCount = async () =>
  ((await db().prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0)

describe('identity sign-in and linking on the migrated schema', () => {
  test('a backfilled dropbox identity resolves the migrated account by its legacy id', async () => {
    const user = await findAccountByIdentity('dropbox', OWNER_A, { DB: db() })
    expect(user?.accountId).toBe(OWNER_A)
    expect(user?.tier).toBe('pro')
    const signedIn = await upsertIdentitySignIn(
      { provider: 'dropbox', subject: OWNER_A, displayName: 'Renamed Owner', email: 'a@manorama.xyz' },
      { DB: db() },
    )
    expect(signedIn.accountId).toBe(OWNER_A)
    expect(signedIn.ownerSlug).toBe('owner-a')
    const stored = await db().prepare('SELECT display_name FROM users WHERE account_id = ?').bind(OWNER_A).first<{ display_name: string }>()
    expect(stored?.display_name).toBe('Owner A')
  })

  test('a brand-new dropbox subject gets a fresh acct_ account', async () => {
    const user = await upsertIdentitySignIn(
      { provider: 'dropbox', subject: 'dbid:NEWdropbox1', displayName: 'New Person' },
      { DB: db() },
    )
    expect(user.accountId).toMatch(ACCT_ID)
    expect(user.ownerSlug).toBe('new-person')
    expect(user.tier).toBe('free')
    const again = await upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:NEWdropbox1' }, { DB: db() })
    expect(again.accountId).toBe(user.accountId)
    const identities = await listIdentities(user.accountId, { DB: db() })
    expect(identities).toEqual([{
      provider: 'dropbox',
      subject: 'dbid:NEWdropbox1',
      accountId: user.accountId,
      displayName: 'New Person',
    }])
  })

  test('google and apple subjects create distinct acct_ accounts even with one email', async () => {
    const google = await upsertIdentitySignIn(
      { provider: 'google', subject: 'goog-sub-1', displayName: 'Shared Mail', email: 'shared@manorama.xyz' },
      { DB: db() },
    )
    const apple = await upsertIdentitySignIn(
      { provider: 'apple', subject: 'apple-sub-1', email: 'shared@manorama.xyz' },
      { DB: db() },
    )
    expect(google.accountId).toMatch(ACCT_ID)
    expect(apple.accountId).toMatch(ACCT_ID)
    expect(google.accountId).not.toBe(apple.accountId)
    expect(google.ownerSlug).not.toBe(apple.ownerSlug)
    expect(apple.displayName).toBe('Photographer')
    // No displayName from Apple → a generated three-word slug, not photographer-N
    expect(apple.ownerSlug).toMatch(/^[a-z]+-[a-z]+-[a-z]+(-[0-9]+)?$/)
    expect(apple.ownerSlug.startsWith('photographer')).toBe(false)
  })

  test('linking google then apple lands on one account without touching slug, tier, billing or galleries', async () => {
    const before = await db().prepare('SELECT * FROM users WHERE account_id = ?').bind(OWNER_B).first<Record<string, unknown>>()
    const galleriesBeforeLink = (await db().prepare('SELECT * FROM galleries WHERE owner_id = ? ORDER BY slug')
      .bind(OWNER_B).all<Record<string, unknown>>()).results ?? []
    expect(galleriesBeforeLink.length).toBeGreaterThan(0)
    await linkIdentity(OWNER_B, { provider: 'google', subject: 'goog-linked-b', email: 'b@manorama.xyz' }, { DB: db() })
    await linkIdentity(OWNER_B, { provider: 'apple', subject: 'apple-linked-b', displayName: 'Bee' }, { DB: db() })
    const identities = await listIdentities(OWNER_B, { DB: db() })
    expect(identities.map((row) => `${row.provider}:${row.subject}`).sort())
      .toEqual([`apple:apple-linked-b`, `dropbox:${OWNER_B}`, `google:goog-linked-b`])
    const after = await db().prepare('SELECT * FROM users WHERE account_id = ?').bind(OWNER_B).first<Record<string, unknown>>()
    expect(after).toEqual(before)
    const galleriesAfterLink = (await db().prepare('SELECT * FROM galleries WHERE owner_id = ? ORDER BY slug')
      .bind(OWNER_B).all<Record<string, unknown>>()).results ?? []
    expect(galleriesAfterLink).toEqual(galleriesBeforeLink)
    const resolvedGoogle = await findAccountByIdentity('google', 'goog-linked-b', { DB: db() })
    const resolvedApple = await findAccountByIdentity('apple', 'apple-linked-b', { DB: db() })
    expect(resolvedGoogle?.accountId).toBe(OWNER_B)
    expect(resolvedApple?.accountId).toBe(OWNER_B)
  })

  test('link conflicts refuse foreign subjects and a second same-provider subject', async () => {
    await expect(linkIdentity(OWNER_B, { provider: 'dropbox', subject: OWNER_A }, { DB: db() }))
      .rejects.toBeInstanceOf(IdentityConflictError)
    await expect(linkIdentity(OWNER_A, { provider: 'dropbox', subject: 'dbid:SECONDsubject' }, { DB: db() }))
      .rejects.toBeInstanceOf(IdentityConflictError)
    await expect(linkIdentity('acct_00000000-0000-4000-8000-000000000000', { provider: 'google', subject: 'goog-orphan' }, { DB: db() }))
      .rejects.toThrow()
    await linkIdentity(OWNER_A, { provider: 'dropbox', subject: OWNER_A, displayName: 'Refreshed' }, { DB: db() })
  })

  test('the last identity cannot be unlinked', async () => {
    const solo = await upsertIdentitySignIn({ provider: 'google', subject: 'goog-solo' }, { DB: db() })
    await expect(unlinkIdentity(solo.accountId, 'google', { DB: db() })).rejects.toBeInstanceOf(LastIdentityError)
    expect(await unlinkIdentity(solo.accountId, 'apple', { DB: db() })).toBe(false)
    await linkIdentity(solo.accountId, { provider: 'apple', subject: 'apple-solo' }, { DB: db() })
    expect(await unlinkIdentity(solo.accountId, 'google', { DB: db() })).toBe(true)
    const identities = await listIdentities(solo.accountId, { DB: db() })
    expect(identities.map((row) => row.provider)).toEqual(['apple'])
  })

  test('concurrent sign-ups for one identity create one user and one identity row', async () => {
    const before = await userCount()
    const [first, second] = await Promise.all([
      upsertIdentitySignIn({ provider: 'google', subject: 'goog-race-1', displayName: 'Racer' }, { DB: db() }),
      upsertIdentitySignIn({ provider: 'google', subject: 'goog-race-1', displayName: 'Racer' }, { DB: db() }),
    ])
    expect(second.accountId).toBe(first.accountId)
    const identityRows = await db().prepare(
      "SELECT COUNT(*) AS n FROM auth_identities WHERE provider = 'google' AND provider_subject = 'goog-race-1'",
    ).first<{ n: number }>()
    expect(identityRows?.n).toBe(1)
    expect(await userCount()).toBe(before + 1)
  })

  test('concurrent same-name sign-ups land on distinct slugs within the length bound', async () => {
    const [one, two] = await Promise.all([
      upsertIdentitySignIn({ provider: 'google', subject: 'goog-twin-1', displayName: 'Twin Name' }, { DB: db() }),
      upsertIdentitySignIn({ provider: 'apple', subject: 'apple-twin-1', displayName: 'Twin Name' }, { DB: db() }),
    ])
    expect(one.accountId).not.toBe(two.accountId)
    expect(one.ownerSlug).not.toBe(two.ownerSlug)
    expect(one.ownerSlug.length).toBeLessThanOrEqual(48)
    expect(two.ownerSlug.length).toBeLessThanOrEqual(48)
    expect([one.ownerSlug, two.ownerSlug].sort()).toEqual(['twin-name', 'twin-name-2'])
  })

  test('input validation rejects bad providers and blank or oversized subjects', async () => {
    const bogus = 'vimeo' as unknown as AuthProvider
    for (const call of [
      () => findAccountByIdentity(bogus, 'sub', { DB: db() }),
      () => findAccountByIdentity('dropbox', '   ', { DB: db() }),
      () => findAccountByIdentity('dropbox', 'x'.repeat(1025), { DB: db() }),
      () => upsertIdentitySignIn({ provider: bogus, subject: 'sub' }, { DB: db() }),
      () => upsertIdentitySignIn({ provider: 'google', subject: '' }, { DB: db() }),
      () => upsertIdentitySignIn({ provider: 'google', subject: 'y'.repeat(2000) }, { DB: db() }),
      () => linkIdentity(OWNER_A, { provider: 'apple', subject: '\t' }, { DB: db() }),
      () => linkIdentity(OWNER_A, { provider: bogus, subject: 'sub' }, { DB: db() }),
    ]) {
      await expect(call()).rejects.toThrow()
    }
  })

  test('a max-length name with a hyphen at the cut boundary still mints a valid unique slug', async () => {
    const longName = `${'a'.repeat(47)} zzz`
    const [one, two] = await Promise.all([
      upsertIdentitySignIn({ provider: 'google', subject: 'goog-long-1', displayName: longName }, { DB: db() }),
      upsertIdentitySignIn({ provider: 'apple', subject: 'apple-long-1', displayName: longName }, { DB: db() }),
    ])
    expect(one.accountId).not.toBe(two.accountId)
    expect(one.ownerSlug).not.toBe(two.ownerSlug)
    for (const slug of [one.ownerSlug, two.ownerSlug]) {
      expect(slug).toMatch(OWNER_SLUG_PATTERN)
      expect(slug.length).toBeLessThanOrEqual(48)
    }
  })

  test('concurrent unlinks of the last two identities leave exactly one', async () => {
    const pair = await upsertIdentitySignIn({ provider: 'google', subject: 'goog-pair' }, { DB: db() })
    await linkIdentity(pair.accountId, { provider: 'apple', subject: 'apple-pair' }, { DB: db() })
    const results = await Promise.allSettled([
      unlinkIdentity(pair.accountId, 'google', { DB: db() }),
      unlinkIdentity(pair.accountId, 'apple', { DB: db() }),
    ])
    const remaining = await listIdentities(pair.accountId, { DB: db() })
    expect(remaining).toHaveLength(1)
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === true)).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason instanceof LastIdentityError).toBe(true)
  })

  test('every operation fails closed when the D1 binding is absent', async () => {
    for (const call of [
      () => findAccountByIdentity('dropbox', OWNER_A, {}),
      () => upsertIdentitySignIn({ provider: 'dropbox', subject: 'dbid:NOdb' }, {}),
      () => listIdentities(OWNER_A, {}),
      () => linkIdentity(OWNER_A, { provider: 'google', subject: 'goog-nodb' }, {}),
      () => unlinkIdentity(OWNER_A, 'dropbox', {}),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(IdentityStorageUnavailableError)
    }
  })

  test('a missing auth_identities schema propagates instead of falling back', () => {
    expect(missingSchemaFailure).toBeInstanceOf(Error)
    expect(missingSchemaFailure).not.toBeInstanceOf(IdentityStorageUnavailableError)
    expect((missingSchemaFailure as Error).message).toMatch(/no such table/i)
  })
})

const originalFetch = globalThis.fetch

const mockDropboxFetch = (accountId: string, email?: string) => {
  const calls: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    if (url === 'https://api.dropbox.com/oauth2/token') {
      return new Response(JSON.stringify({ access_token: 'mock-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === 'https://api.dropboxapi.com/2/users/get_current_account') {
      return new Response(JSON.stringify({
        account_id: accountId,
        email,
        email_verified: Boolean(email),
        name: { display_name: 'Callback Tester' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('unexpected fetch', { status: 500 })
  }
  return calls
}

const oauthEnv = () => ({
  HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
  DROPBOX_APP_KEY: 'test-key',
  DROPBOX_APP_SECRET: 'test-secret',
  DB: db(),
})

/** OAuth transaction state now lives server-side in auth_flows, so the
 *  callback tests mint a real flow row instead of a state cookie. */
const callbackState = () =>
  createAuthFlow({ provider: 'dropbox', intent: 'signin' }, { DB: db() }).then((flow) => flow.state)

describe('the Dropbox callback on the migrated schema', () => {
  test('a migrated subject signs into its legacy account id; a new subject gets acct_', async () => {
    const calls = mockDropboxFetch(OWNER_A, 'a@manorama.xyz')
    const app = new Hono()
    app.get('/auth/dropbox/callback', ...callbackRoute)
    try {
      const migrated = await app.request(`/auth/dropbox/callback?code=abc&state=${await callbackState()}`, undefined, oauthEnv())
      expect(migrated.status).toBe(302)
      expect(migrated.headers.get('Location')).toBe('/owner-a')
      expect(migrated.headers.get('Set-Cookie')).toContain(SESSION_COOKIE)
      expect(await db().prepare('SELECT COUNT(*) AS n FROM users WHERE account_id = ?').bind(OWNER_A).first<{ n: number }>())
        .toEqual({ n: 1 })
      expect(calls).toEqual([
        'https://api.dropbox.com/oauth2/token',
        'https://api.dropboxapi.com/2/users/get_current_account',
      ])

      calls.length = 0
      mockDropboxFetch('dbid:CALLBACKnew', 'new@manorama.xyz')
      const fresh = await app.request(`/auth/dropbox/callback?code=abc&state=${await callbackState()}`, undefined, oauthEnv())
      expect(fresh.status).toBe(302)
      const identity = await db().prepare(
        "SELECT account_id FROM auth_identities WHERE provider = 'dropbox' AND provider_subject = 'dbid:CALLBACKnew'",
      ).first<{ account_id: string }>()
      expect(identity?.account_id).toMatch(ACCT_ID)
      const created = await db().prepare('SELECT owner_slug FROM users WHERE account_id = ?')
        .bind(identity!.account_id).first<{ owner_slug: string }>()
      expect(fresh.headers.get('Location')).toBe(`/${created?.owner_slug}`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a missing D1 binding answers a no-store 503 rather than error=1', async () => {
    mockDropboxFetch('dbid:NODBcall', 'nodb@manorama.xyz')
    const app = new Hono()
    app.get('/auth/dropbox/callback', ...callbackRoute)
    try {
      // No DB binding anywhere: the flow lands on the memory fallback and
      // identity storage fails closed inside the callback.
      const { state } = await createAuthFlow({ provider: 'dropbox', intent: 'signin' })
      const response = await app.request(`/auth/dropbox/callback?code=abc&state=${state}`, undefined, {
        HOST_API_JWT_SECRET: TEST_SESSION_SECRET,
        DROPBOX_APP_KEY: 'test-key',
        DROPBOX_APP_SECRET: 'test-secret',
      })
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(await response.text()).toBe('Sign-in is temporarily unavailable')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
