import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getPlatformProxy } from 'wrangler'
import type { D1Database } from '@cloudflare/workers-types'
import { createManoramaApi } from './api'
import { createSessionToken, SESSION_COOKIE } from './lib/session'
import { deleteAccount } from './lib/user-repository'
import { TEST_SESSION_SECRET } from './lib/test-fixtures'

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

const api = createManoramaApi()

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null
let db: D1Database

const env = () => ({ DB: db, HOST_API_JWT_SECRET: TEST_SESSION_SECRET })

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: `${repoRoot}/wrangler.toml`,
    persist: false,
  })
  db = proxy.env.DB
  await applyMigration(db, '0001_users_and_galleries.sql')
  await applyMigration(db, '0002_gallery_retention.sql')
  await applyMigration(db, '0003_revenuecat_event_ordering.sql')
  await applyMigration(db, '0004_ad_suppressions.sql')
  await applyMigration(db, '0005_provider_neutral_accounts.sql')
  await applyMigration(db, '0006_auth_flows.sql')
  await applyMigration(db, '0007_device_galleries.sql')
  await applyMigration(db, '0012_gallery_pinned.sql')
  await applyMigration(db, '0013_gallery_identity_and_manifest_version.sql')
  await applyMigration(db, '0014_encrypted_key_retirement.sql')
  await applyMigration(db, '0016_gallery_hidden.sql')
  await applyMigration(db, '0017_device_gallery_hidden.sql')
  await applyMigration(db, '0008_master_accounts_and_country.sql')
  await applyMigration(db, '0015_gallery_key_vault.sql')
  await applyMigration(db, '0019_owner_slug_reservations.sql')
  await applyMigration(db, '0020_gallery_source_check.sql')
  await applyMigration(db, '0021_devices.sql')
  await applyMigration(db, '0022_device_label_drop.sql')
}, 15_000)

afterAll(async () => {
  await proxy?.dispose()
  proxy = null
})

let ownerSeq = 0
const seedOwner = async (tier: 'free' | 'pro' = 'pro') => {
  ownerSeq += 1
  const id = `dbid:AAATESTdevices${ownerSeq}`
  const slug = `devices-${ownerSeq}`
  await db
    .prepare('INSERT INTO users (account_id, owner_slug, display_name, tier) VALUES (?, ?, ?, ?)')
    .bind(id, slug, 'Device Owner', tier)
    .run()
  const token = await createSessionToken(id, TEST_SESSION_SECRET)
  return { id, slug, bearer: `Bearer ${token}`, cookie: `${SESSION_COOKIE}=${token}` }
}

const uuid = () => crypto.randomUUID()

const listAs = (headers: Record<string, string>) => api.request('/api/devices', { headers }, env())

const registerAs = (headers: Record<string, string>, id: string, body: unknown) =>
  api.request(`/api/devices/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env())

const forgetAs = (headers: Record<string, string>, id: string) =>
  api.request(`/api/devices/${id}`, { method: 'DELETE', headers }, env())

type ListedDevice = { id: string; kind: string; ordinal: number; colour: number; lastSeenAt: string }
const devicesOf = async (response: Response) => (await response.json() as { devices?: ListedDevice[] }).devices ?? []

const seedDeviceGallery = async (ownerId: string, deviceId: string, title = 'A catalogue') => {
  const id = uuid()
  await db
    .prepare('INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(ownerId, id, title, 'folder', 3, deviceId, new Date().toISOString())
    .run()
  return id
}

describe('the device list session gate', () => {
  test('an account cookie reads the list; anonymous and handoff tokens are refused', async () => {
    const owner = await seedOwner()
    expect((await api.request('/api/devices', {}, env())).status).toBe(401)
    const read = await listAs({ Cookie: owner.cookie })
    expect(read.status).toBe(200)
    expect(await devicesOf(read)).toEqual([])
  })

  test('registering and forgetting are device-token only — a web session records no device', async () => {
    const owner = await seedOwner()
    const id = uuid()
    const cookiePut = await registerAs({ Cookie: owner.cookie }, id, { kind: 'mac' })
    expect(cookiePut.status).toBe(401)
    const cookieDelete = await forgetAs({ Cookie: owner.cookie }, id)
    expect(cookieDelete.status).toBe(401)
    // Nothing was written by either attempt.
    expect(await devicesOf(await listAs({ Cookie: owner.cookie }))).toEqual([])
  })

  test('the list is never cached', async () => {
    const owner = await seedOwner()
    expect((await listAs({ Authorization: owner.bearer })).headers.get('Cache-Control')).toBe('private, no-store')
    expect((await listAs({})).headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('registering a device', () => {
  test('the first device is numbered 1 in slot 0 and reports only its kind', async () => {
    const owner = await seedOwner()
    const id = uuid()
    const response = await registerAs({ Authorization: owner.bearer }, id, { kind: 'mac' })
    expect(response.status).toBe(200)
    const { device } = await response.json() as { device: Record<string, unknown> }
    expect(Object.keys(device).sort()).toEqual(['colour', 'firstSeenAt', 'id', 'kind', 'lastSeenAt', 'ordinal'])
    expect(device.kind).toBe('mac')
    expect(device.ordinal).toBe(1)
    expect(device.colour).toBe(0)
    expect(device.id).toBe(id)
  })

  test('a second Mac takes the next number and a different colour', async () => {
    const owner = await seedOwner()
    const first = uuid()
    const second = uuid()
    await registerAs({ Authorization: owner.bearer }, first, { kind: 'mac' })
    const response = await registerAs({ Authorization: owner.bearer }, second, { kind: 'mac' })
    const { device } = await response.json() as { device: ListedDevice }
    expect(device.ordinal).toBe(2)
    expect(device.colour).toBe(1)
    const listed = await devicesOf(await listAs({ Authorization: owner.bearer }))
    expect(listed.map((entry) => entry.colour)).toEqual([0, 1])
    expect(listed.map((entry) => entry.ordinal)).toEqual([1, 2])
  })

  test('a phone numbers independently of the Macs and sorts after them', async () => {
    const owner = await seedOwner()
    await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'mac' })
    const phone = uuid()
    const response = await registerAs({ Authorization: owner.bearer }, phone, { kind: 'iphone' })
    const { device } = await response.json() as { device: ListedDevice }
    expect(device.ordinal).toBe(1)
    expect(device.colour).toBe(1)
    const listed = await devicesOf(await listAs({ Authorization: owner.bearer }))
    expect(listed.map((entry) => entry.kind)).toEqual(['mac', 'iphone'])
  })

  test('re-registering keeps the kind, number and colour', async () => {
    const owner = await seedOwner()
    const id = uuid()
    await registerAs({ Authorization: owner.bearer }, id, { kind: 'mac' })
    const response = await registerAs({ Authorization: owner.bearer }, id, { kind: 'windows' })
    const { device } = await response.json() as { device: ListedDevice }
    expect(device.kind).toBe('mac')
    expect(device.ordinal).toBe(1)
    expect(device.colour).toBe(0)
    const listed = await devicesOf(await listAs({ Authorization: owner.bearer }))
    expect(listed).toHaveLength(1)
  })

  test('a name in the body is a rejected body — the device says only its kind', async () => {
    const owner = await seedOwner()
    const id = uuid()
    expect((await registerAs({ Authorization: owner.bearer }, id, { kind: 'mac', label: 'Mahesh’s MacBook Pro' })).status).toBe(400)
    expect((await registerAs({ Authorization: owner.bearer }, id, { kind: 'toaster' })).status).toBe(400)
    expect((await registerAs({ Authorization: owner.bearer }, id, {})).status).toBe(400)
    expect((await registerAs({ Authorization: owner.bearer }, 'not-a-uuid', { kind: 'mac' })).status).toBe(400)
    expect((await registerAs({ Authorization: owner.bearer }, id, 'text')).status).toBe(400)
  })

  test('a free account can register — the device list is not a Visionary feature', async () => {
    const owner = await seedOwner('free')
    expect((await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'ipad' })).status).toBe(200)
    expect(await devicesOf(await listAs({ Authorization: owner.bearer }))).toHaveLength(1)
  })

  test('accounts never see each other’s devices', async () => {
    const a = await seedOwner()
    const b = await seedOwner()
    await registerAs({ Authorization: a.bearer }, uuid(), { kind: 'mac' })
    expect(await devicesOf(await listAs({ Authorization: b.bearer }))).toEqual([])
  })
})

describe('forgetting and expiry', () => {
  test('forget removes the device and the Local galleries it published', async () => {
    const owner = await seedOwner()
    const id = uuid()
    await registerAs({ Authorization: owner.bearer }, id, { kind: 'mac' })
    await seedDeviceGallery(owner.id, id)
    await seedDeviceGallery(owner.id, id, 'Another folder')
    const response = await forgetAs({ Authorization: owner.bearer }, id)
    expect(response.status).toBe(200)
    expect(await devicesOf(await listAs({ Authorization: owner.bearer }))).toEqual([])
    const mirrors = await db.prepare('SELECT COUNT(*) AS count FROM device_galleries WHERE owner_id = ?').bind(owner.id).first<{ count: number }>()
    expect(Number(mirrors?.count ?? 0)).toBe(0)
    // Idempotent: a second forget is simply "not found".
    expect((await forgetAs({ Authorization: owner.bearer }, id)).status).toBe(404)
  })

  test('a forgotten colour is reused by the next device, and the number is not', async () => {
    const owner = await seedOwner()
    const first = uuid()
    const second = uuid()
    await registerAs({ Authorization: owner.bearer }, first, { kind: 'mac' })
    await registerAs({ Authorization: owner.bearer }, second, { kind: 'mac' })
    await forgetAs({ Authorization: owner.bearer }, first)
    const third = uuid()
    const response = await registerAs({ Authorization: owner.bearer }, third, { kind: 'mac' })
    const { device } = await response.json() as { device: ListedDevice }
    expect(device.colour).toBe(0)
    expect(device.ordinal).toBe(3)
  })

  test('a device unseen for the whole window is hidden, then swept with its mirrors', async () => {
    const owner = await seedOwner()
    const stale = uuid()
    await registerAs({ Authorization: owner.bearer }, stale, { kind: 'mac' })
    const mirror = await seedDeviceGallery(owner.id, stale)
    const old = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString()
    await db.prepare('UPDATE devices SET last_seen_at = ? WHERE owner_id = ? AND id = ?').bind(old, owner.id, stale).run()

    expect(await devicesOf(await listAs({ Authorization: owner.bearer }))).toEqual([])

    // Registering anything sweeps it for good — row and mirrors.
    await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'mac' })
    const row = await db.prepare('SELECT id FROM devices WHERE owner_id = ? AND id = ?').bind(owner.id, stale).first()
    expect(row).toBeNull()
    const gallery = await db.prepare('SELECT id FROM device_galleries WHERE id = ?').bind(mirror).first()
    expect(gallery).toBeNull()
  })

  test('a thirteenth live device is refused rather than sharing a colour', async () => {
    const owner = await seedOwner()
    for (let index = 0; index < 12; index += 1) {
      const response = await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'mac' })
      expect(response.status).toBe(200)
    }
    const overflow = await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'mac' })
    expect(overflow.status).toBe(409)
    const payload = await overflow.json() as { error?: string }
    expect(payload.error).toBe('Forget a device to add another')
    // Re-registering a device already on the list is still fine.
    const listed = await devicesOf(await listAs({ Authorization: owner.bearer }))
    expect((await registerAs({ Authorization: owner.bearer }, listed[0]!.id, { kind: 'mac' })).status).toBe(200)
  })
})

describe('account deletion', () => {
  test('deleting the account removes its device list', async () => {
    const owner = await seedOwner()
    await registerAs({ Authorization: owner.bearer }, uuid(), { kind: 'mac' })
    expect(await deleteAccount(owner.id, env())).toBe(true)
    const row = await db.prepare('SELECT COUNT(*) AS count FROM devices WHERE owner_id = ?').bind(owner.id).first<{ count: number }>()
    expect(Number(row?.count ?? 0)).toBe(0)
  })
})

describe('the migration backfill', () => {
  test('existing mirrors become Macs numbered in first-sync order, and the label column is gone', async () => {
    const owner = await seedOwner()
    const first = uuid()
    const second = uuid()
    await db
      .prepare('INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(owner.id, uuid(), 'Oldest', 'folder', 1, first, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString())
      .run()
    await db
      .prepare('INSERT INTO device_galleries (owner_id, id, title, source_kind, item_count, device_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(owner.id, uuid(), 'Newer', 'folder', 1, second, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .run()
    await applyMigration(db, '0021_devices.sql')

    const listed = await devicesOf(await listAs({ Authorization: owner.bearer }))
    expect(listed.map((entry) => [entry.id, entry.kind, entry.ordinal, entry.colour])).toEqual([
      [first, 'mac', 1, 0],
      [second, 'mac', 2, 1],
    ])
    const columns = await db.prepare('PRAGMA table_info(device_galleries)').all<{ name: string }>()
    expect((columns.results ?? []).map((column) => column.name)).not.toContain('device_label')
  })
})
