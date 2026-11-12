import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { createManoramaApi } from './api'
import { createSessionToken } from './lib/session'
import { deleteAccount, getUserByAccountId, OwnerSlugError, resetUserStore, updateOwnerSlug } from './lib/user-repository'
import { upsertIdentitySignIn } from './lib/identity-repository'
import { createGallery, listGalleries, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

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

const countRows = async (db: D1Database, table: string, column: string, accountId: string) => {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(accountId).first<{ n: number }>()
  return row?.n ?? 0
}

describe('deleteAccount', () => {
  const OWNER_A = 'dbid:AAAdeleteA'
  const OWNER_B = 'dbid:BBBdeleteB'

  let sharedD1: { proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> } | null = null

  beforeAll(async () => {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: `${repoRoot}/wrangler.toml`,
      persist: false,
    })
    sharedD1 = { proxy }
    const db = proxy.env.DB
    for (const migration of [
      '0001_users_and_galleries.sql',
      '0002_gallery_retention.sql',
      '0003_revenuecat_event_ordering.sql',
      '0004_ad_suppressions.sql',
      '0005_provider_neutral_accounts.sql',
      '0006_auth_flows.sql',
      '0007_device_galleries.sql',
      '0008_master_accounts_and_country.sql',
      '0012_gallery_pinned.sql',
      '0015_gallery_key_vault.sql',
      '0016_gallery_hidden.sql',
      '0017_device_gallery_hidden.sql',
      '0019_owner_slug_reservations.sql',
    ]) {
      await applyMigration(db, migration)
    }
    const insertUser = `INSERT INTO users (account_id, owner_slug, display_name, email, tier) VALUES (?, ?, ?, ?, ?)`
    await db.prepare(insertUser).bind(OWNER_A, 'delete-a', 'Delete A', 'a@manorama.xyz', 'pro').run()
    await db.prepare(insertUser).bind(OWNER_B, 'delete-b', 'Delete B', null, 'free').run()
    const insertIdentity = `INSERT INTO auth_identities (provider, provider_subject, account_id, email, display_name) VALUES (?, ?, ?, ?, ?)`
    await db.prepare(insertIdentity).bind('dropbox', OWNER_A, OWNER_A, 'a@manorama.xyz', 'Delete A').run()
    await db.prepare(insertIdentity).bind('google', 'g-sub-b', OWNER_B, null, 'Delete B').run()
    await db.prepare(
      `INSERT INTO auth_flows (state, provider, intent, account_id, nonce, expires_at)
       VALUES ('flow-a', 'google', 'link', ?, 'nonce-a', '2030-01-01 00:00:00')`,
    ).bind(OWNER_A).run()
    const insertGallery = `INSERT INTO galleries (slug, owner_id, title) VALUES (?, ?, ?)`
    await db.prepare(insertGallery).bind('gone-with-a', OWNER_A, 'Gone A').run()
    await db.prepare(insertGallery).bind('kept-by-b', OWNER_B, 'Kept B').run()
    await db.prepare(
      `INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, device_label, updated_at)
       VALUES (?, 'dev-a', 'Mac folder', 'folder', 3, 'dev-1', 'Mac Studio', '2026-10-01 00:00:00')`,
    ).bind(OWNER_A).run()
  }, 15_000)

  afterAll(async () => {
    await sharedD1?.proxy.dispose()
    sharedD1 = null
  })

  const db = () => sharedD1!.proxy.env.DB

  test('removes every account-scoped row and leaves other accounts intact', async () => {
    // Seed the escrow rows too — ciphertext is still data about the owner.
    await db().prepare(
      `INSERT INTO owner_key_vault (owner_id, kdf_salt, kdf_iterations, wrapped_vk, vk_nonce, version, updated_at)
       VALUES (?, 'salt', 600000, 'cipher', 'nonce', 1, '2026-10-01 00:00:00')`,
    ).bind(OWNER_A).run()
    await db().prepare(
      `INSERT INTO gallery_keys (owner_id, gallery_id, wrapped_source, nonce, updated_at)
       VALUES (?, 'gal-1', 'cipher', 'nonce', '2026-10-01 00:00:00')`,
    ).bind(OWNER_A).run()
    expect(await deleteAccount(OWNER_A, { DB: db() })).toBe(true)
    for (const [table, column] of [
      ['users', 'account_id'],
      ['auth_identities', 'account_id'],
      ['auth_flows', 'account_id'],
      ['galleries', 'owner_id'],
      ['device_galleries', 'owner_id'],
      ['owner_key_vault', 'owner_id'],
      ['gallery_keys', 'owner_id'],
    ]) {
      expect(await countRows(db(), table, column, OWNER_A)).toBe(0)
    }
    expect(await countRows(db(), 'users', 'account_id', OWNER_B)).toBe(1)
    expect(await countRows(db(), 'auth_identities', 'account_id', OWNER_B)).toBe(1)
    expect(await countRows(db(), 'galleries', 'owner_id', OWNER_B)).toBe(1)
  })

  test('is idempotent: a second call or a missing account returns false', async () => {
    // Seeds its own account: relying on an earlier test's deletion would
    // couple the assertion to execution order.
    await db().prepare(
      `INSERT INTO users (account_id, owner_slug, display_name, email, tier) VALUES (?, ?, ?, ?, ?)`,
    ).bind('dbid:CCCdeleteC', 'delete-c', 'Delete C', null, 'free').run()
    expect(await deleteAccount('dbid:CCCdeleteC', { DB: db() })).toBe(true)
    expect(await deleteAccount('dbid:CCCdeleteC', { DB: db() })).toBe(false)
    expect(await deleteAccount('dbid:never-existed', { DB: db() })).toBe(false)
  })

  test('deletion reserves the slug — it cannot be claimed or derived again', async () => {
    // Seeds and deletes its own owner — never relies on a sibling test's
    // deletion having run first.
    await db().prepare(
      `INSERT INTO users (account_id, owner_slug, display_name, email, tier) VALUES (?, ?, ?, ?, ?)`,
    ).bind('dbid:EEdeleteE', 'delete-e', 'Delete E', null, 'free').run()
    expect(await deleteAccount('dbid:EEdeleteE', { DB: db() })).toBe(true)
    const reservation = await db().prepare(
      'SELECT account_id FROM owner_slug_reservations WHERE owner_slug = ?',
    ).bind('delete-e').first<{ account_id: string }>()
    expect(reservation?.account_id).toBe('dbid:EEdeleteE')
    // A stranger cannot take it through the rename path.
    await expect(updateOwnerSlug(OWNER_B, 'delete-e', { DB: db() }))
      .rejects.toBeInstanceOf(OwnerSlugError)
    // And a fresh sign-up named to collide derives past it instead of
    // landing on the dead account's address.
    const newcomer = await upsertIdentitySignIn(
      { provider: 'google', subject: 'goog:reserved-slug-check', displayName: 'Delete E' },
      { DB: db() },
    )
    expect(newcomer.ownerSlug).not.toBe('delete-e')
    expect(newcomer.ownerSlug.startsWith('delete-e-')).toBe(true)
  })

  test('a rename reserves the outgoing slug, and only the owner may reclaim it', async () => {
    await updateOwnerSlug(OWNER_B, 'delete-b-moved', { DB: db() })
    const reservation = await db().prepare(
      'SELECT account_id FROM owner_slug_reservations WHERE owner_slug = ?',
    ).bind('delete-b').first<{ account_id: string }>()
    expect(reservation?.account_id).toBe(OWNER_B)
    // The owner itself may take it back — history stays with the account.
    const reclaimed = await updateOwnerSlug(OWNER_B, 'delete-b', { DB: db() })
    expect(reclaimed.ownerSlug).toBe('delete-b')
  })

  test('the in-memory fallback clears the user and their galleries', async () => {
    resetUserStore()
    resetGalleryStore()
    const user = await seedTestUser()
    await createGallery(TEST_OWNER.accountId, {
      slug: 'in-memory-gallery',
      title: 'In Memory',
      caption: '',
      date: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      images: [],
    })
    expect(await deleteAccount(TEST_OWNER.accountId)).toBe(true)
    expect(await getUserByAccountId(TEST_OWNER.accountId)).toBeNull()
    expect(await listGalleries(TEST_OWNER.accountId)).toEqual([])
    expect(await deleteAccount(TEST_OWNER.accountId)).toBe(false)
    expect(user.ownerSlug).toBeTruthy()
  })
})

describe('DELETE /api/account', () => {
  const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
  const api = createManoramaApi()
  let cookie = ''
  let ownerSlug = ''

  beforeEach(async () => {
    resetUserStore()
    resetGalleryStore()
    const user = await seedTestUser()
    ownerSlug = user.ownerSlug
    cookie = await sessionCookieFor(TEST_OWNER.accountId)
  })

  const del = (init: RequestInit = {}) =>
    api.request('/api/account', { method: 'DELETE', ...init }, env)

  test('rejects an unauthenticated request with 401', async () => {
    const response = await del()
    expect(response.status).toBe(401)
  })

  test('rejects a wrong or missing confirmation with 400', async () => {
    const wrong = await del({
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ confirm: 'not-the-url-name' }),
    })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'Type your URL name to confirm' })

    const missing = await del({ headers: { Cookie: cookie } })
    expect(missing.status).toBe(400)

    // `null` parses as valid JSON — a null body must not 500 on the
    // confirmation read.
    const nullBody = await del({
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: 'null',
    })
    expect(nullBody.status).toBe(400)
  })

  test('GET /api/account answers the owner slug and tier so a client can recover both', async () => {
    const response = await api.request('/api/account', { headers: { Cookie: cookie } }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ownerSlug, tier: 'free' })
  })

  test('deletes the account, expires the session cookie, and invalidates it', async () => {
    const response = await del({
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ confirm: `  ${ownerSlug}  ` }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('manorama_session=')
    expect(setCookie.toLowerCase()).toMatch(/expires=thu, 01 jan 1970|max-age=0/)
    expect(await getUserByAccountId(TEST_OWNER.accountId)).toBeNull()

    const followUp = await api.request('/api/account/identities', { headers: { Cookie: cookie } }, env)
    expect(followUp.status).toBe(401)
  })

  test('the native bearer path reaches the route and dies with the account', async () => {
    const token = await createSessionToken(TEST_OWNER.accountId, TEST_SESSION_SECRET)
    const response = await del({
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ confirm: ownerSlug }),
    })
    expect(response.status).toBe(200)

    const followUp = await api.request('/api/account/identities', {
      headers: { Authorization: `Bearer ${token}` },
    }, env)
    expect(followUp.status).toBe(401)
  })
})

// The escrowed vault is where a lost race costs real data — prove the
// compare-and-swap is atomic on the real D1 schema, not just in memory.
describe('key-vault CAS on D1', () => {
  const OWNER = 'dbid:DDvaultCAS'
  let sharedD1: { proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> } | null = null

  beforeAll(async () => {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: `${repoRoot}/wrangler.toml`,
      persist: false,
    })
    sharedD1 = { proxy }
    await applyMigration(proxy.env.DB, '0015_gallery_key_vault.sql')
  }, 15_000)

  afterAll(async () => {
    await sharedD1?.proxy.dispose()
    sharedD1 = null
  })

  const env = () => ({ DB: sharedD1!.proxy.env.DB })
  const vaultRecord = (wrappedVk: string) => ({ kdfSalt: 'salt', kdfIterations: 600_000, wrappedVk, vkNonce: 'nonce', version: 1 })

  test('a create-only write conflicts on an existing row; a stale stamp cannot replace it', async () => {
    const { getOwnerVault, putOwnerVault, putGalleryKey, getGalleryKey } = await import('./lib/key-vault-repository')
    const stored = await putOwnerVault(OWNER, vaultRecord('first'), null, env())
    expect(stored?.updatedAt).toBeTruthy()
    // Second create → conflict, row untouched.
    expect(await putOwnerVault(OWNER, vaultRecord('usurper'), null, env())).toBeNull()
    expect((await getOwnerVault(OWNER, env()))?.wrappedVk).toBe('first')
    // Stale stamp → conflict; the read-back stamp → lands.
    expect(await putOwnerVault(OWNER, vaultRecord('usurper'), 'not-the-stamp', env())).toBeNull()
    expect((await putOwnerVault(OWNER, vaultRecord('second'), stored!.updatedAt, env()))?.wrappedVk).toBe('second')
    // Same contract on gallery keys.
    const key = await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'w1', nonce: 'n1' }, null, env())
    expect(key).not.toBeNull()
    expect(await putGalleryKey(OWNER, 'gal-cas', { wrappedSource: 'w2', nonce: 'n2' }, null, env())).toBeNull()
    expect((await getGalleryKey(OWNER, 'gal-cas', env()))?.wrappedSource).toBe('w1')
  })
})
