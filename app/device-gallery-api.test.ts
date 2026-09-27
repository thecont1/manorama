import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { createManoramaApi } from './api'
import { createNativeHandoffToken, createSessionToken, SESSION_COOKIE } from './lib/dropbox-session'
import { upsertUser } from './lib/user-repository'
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
  await applyMigration(db, '0005_device_galleries.sql')
})

afterAll(async () => {
  await proxy?.dispose()
  proxy = null
})

let ownerSeq = 0
const seedOwner = async (displayName = 'Device Owner') => {
  ownerSeq += 1
  const id = `dbid:AAATESTdevgal${ownerSeq}`
  const slug = `devgal-${ownerSeq}`
  await db
    .prepare('INSERT INTO users (dropbox_account_id, owner_slug, display_name) VALUES (?, ?, ?)')
    .bind(id, slug, displayName)
    .run()
  const token = await createSessionToken(id, TEST_SESSION_SECRET)
  return { id, slug, bearer: `Bearer ${token}`, cookie: `${SESSION_COOKIE}=${token}` }
}

const seedGallery = async (ownerId: string, slug: string, options: { expired?: boolean } = {}) => {
  await db
    .prepare('INSERT INTO galleries (slug, owner_id, title, retention, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(slug, ownerId, 'Seeded Gallery', options.expired ? 'pipeline' : 'retained', options.expired ? '2000-01-01T00:00:00.000Z' : null)
    .run()
}

const deviceInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Studio Laptop',
  sourceKind: 'folder',
  itemCount: 12,
  deviceId: crypto.randomUUID(),
  deviceLabel: 'Studio Mac',
  ...overrides,
})

const listAs = (bearer: string, headers: Record<string, string> = {}) =>
  api.request('/api/device-galleries', { headers: { Authorization: bearer, ...headers } }, env())

const putAs = (bearer: string, id: string, body: unknown, headers: Record<string, string> = {}) =>
  api.request(`/api/device-galleries/${id}`, {
    method: 'PUT',
    headers: { Authorization: bearer, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env())

const deleteAs = (bearer: string, id: string, headers: Record<string, string> = {}) =>
  api.request(`/api/device-galleries/${id}`, {
    method: 'DELETE',
    headers: { Authorization: bearer, ...headers },
  }, env())

type ListedGallery = { id: string; title: string } & Record<string, unknown>
const galleriesOf = async (response: Response) => (await response.json() as { galleries?: ListedGallery[] }).galleries ?? []

describe('device catalogue session gate', () => {
  test('anonymous, cookie-only, and handoff-bearer requests are all refused', async () => {
    const owner = await seedOwner()
    expect((await api.request('/api/device-galleries', {}, env())).status).toBe(401)
    expect((await api.request('/api/device-galleries', { headers: { Cookie: owner.cookie } }, env())).status).toBe(401)
    const handoff = await createNativeHandoffToken(owner.id, TEST_SESSION_SECRET)
    expect((await api.request('/api/device-galleries', {
      headers: { Authorization: `Bearer ${handoff}` },
    }, env())).status).toBe(401)
    expect((await deleteAs(`Bearer ${handoff}`, crypto.randomUUID())).status).toBe(401)
  })

  test('a supplied bearer wins over an ambient session cookie', async () => {
    const a = await seedOwner('Owner A')
    const b = await seedOwner('Owner B')
    const id = crypto.randomUUID()
    expect((await putAs(a.bearer, id, deviceInput({ title: 'A catalogue' }))).status).toBe(200)
    const response = await api.request('/api/device-galleries', {
      headers: { Authorization: a.bearer, Cookie: b.cookie },
    }, env())
    expect(response.status).toBe(200)
    const galleries = await galleriesOf(response)
    expect(galleries.map((gallery) => gallery.id)).toEqual([id])
    const other = await api.request('/api/device-galleries', {
      headers: { Authorization: b.bearer, Cookie: a.cookie },
    }, env())
    expect((await galleriesOf(other)).map((gallery) => gallery.id)).toEqual([])
    const staleCookie = await api.request('/api/device-galleries', {
      headers: { Authorization: a.bearer, Cookie: `${SESSION_COOKIE}=expired-or-invalid` },
    }, env())
    expect(staleCookie.status).toBe(200)
    expect((await galleriesOf(staleCookie)).map((gallery) => gallery.id)).toEqual([id])
    expect((await api.request('/api/device-galleries', {
      headers: { Authorization: 'Bearer not-a-jwt', Cookie: a.cookie },
    }, env())).status).toBe(401)
    expect((await api.request('/api/device-galleries', {
      headers: { Cookie: a.cookie },
    }, env())).status).toBe(401)
  })

  test('a write under bearer A cannot be steered by an ambient cookie for B', async () => {
    const a = await seedOwner('Writer A')
    const b = await seedOwner('Writer B')
    const id = crypto.randomUUID()
    const response = await api.request(`/api/device-galleries/${id}`, {
      method: 'PUT',
      headers: { Authorization: a.bearer, Cookie: b.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceInput({ title: 'Written as A' })),
    }, env())
    expect(response.status).toBe(200)
    expect((await galleriesOf(await listAs(a.bearer))).map((gallery) => gallery.id)).toEqual([id])
    expect(await galleriesOf(await listAs(b.bearer))).toEqual([])
    const row = await db.prepare('SELECT owner_id FROM device_galleries WHERE id = ?').bind(id).first<{ owner_id: string }>()
    expect(row?.owner_id).toBe(a.id)
  })

  test('every response is private, no-store', async () => {
    const owner = await seedOwner()
    const response = await listAs(owner.bearer)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const denied = await api.request('/api/device-galleries', {}, env())
    expect(denied.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('device catalogue ownership', () => {
  test('two owners can hold the same catalogue id without leaking rows', async () => {
    const a = await seedOwner('Owner A')
    const b = await seedOwner('Owner B')
    const shared = crypto.randomUUID()
    expect((await putAs(a.bearer, shared, deviceInput({ title: 'A private' }))).status).toBe(200)
    expect(await galleriesOf(await listAs(b.bearer))).toEqual([])
    expect((await deleteAs(b.bearer, shared)).status).toBe(404)
    expect((await putAs(b.bearer, shared, deviceInput({ title: 'B private' }))).status).toBe(200)
    const aGalleries = await galleriesOf(await listAs(a.bearer))
    expect(aGalleries).toHaveLength(1)
    expect(aGalleries[0].title).toBe('A private')
    const bGalleries = await galleriesOf(await listAs(b.bearer))
    expect(bGalleries).toHaveLength(1)
    expect(bGalleries[0].title).toBe('B private')
  })

  test('the list returns only catalogue fields and never owner internals', async () => {
    const owner = await seedOwner()
    const id = crypto.randomUUID()
    const created = await putAs(owner.bearer, id, deviceInput())
    expect(created.status).toBe(200)
    const { gallery } = await created.json() as { gallery: Record<string, unknown> }
    expect(Object.keys(gallery).sort()).toEqual(['deviceId', 'deviceLabel', 'id', 'itemCount', 'sourceKind', 'title', 'updatedAt'])
    expect(gallery.id).toBe(id)
    expect(typeof gallery.updatedAt).toBe('string')
    const galleries = await galleriesOf(await listAs(owner.bearer))
    expect(galleries).toHaveLength(1)
    expect(Object.keys(galleries[0]).sort()).toEqual(['deviceId', 'deviceLabel', 'id', 'itemCount', 'sourceKind', 'title', 'updatedAt'])
    expect(galleries[0]).not.toHaveProperty('owner_id')
    expect(galleries[0]).not.toHaveProperty('ownerId')
  })

  test('a put upserts idempotently and a delete removes only that row', async () => {
    const owner = await seedOwner()
    const id = crypto.randomUUID()
    expect((await putAs(owner.bearer, id, deviceInput({ title: 'First' }))).status).toBe(200)
    const second = await putAs(owner.bearer, id, deviceInput({ title: 'Second', sourceKind: 'card', itemCount: 3 }))
    expect(second.status).toBe(200)
    const { gallery } = await second.json() as { gallery: { title: string; sourceKind: string; itemCount: number } }
    expect(gallery.title).toBe('Second')
    expect(gallery.sourceKind).toBe('card')
    expect(gallery.itemCount).toBe(3)
    expect(await galleriesOf(await listAs(owner.bearer))).toHaveLength(1)
    expect((await deleteAs(owner.bearer, id)).status).toBe(200)
    expect((await deleteAs(owner.bearer, id)).status).toBe(404)
    expect(await galleriesOf(await listAs(owner.bearer))).toEqual([])
    expect((await deleteAs(owner.bearer, 'not-a-uuid')).status).toBe(404)
    const rows = await db.prepare('SELECT COUNT(*) AS count FROM device_galleries WHERE owner_id = ?').bind(owner.id).first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })
})

describe('device catalogue validation', () => {
  test('rejects a non-UUID catalogue id and a non-JSON content type', async () => {
    const owner = await seedOwner()
    expect((await putAs(owner.bearer, 'not-a-uuid', deviceInput())).status).toBe(400)
    const wrongType = await api.request(`/api/device-galleries/${crypto.randomUUID()}`, {
      method: 'PUT',
      headers: { Authorization: owner.bearer, 'Content-Type': 'text/plain' },
      body: JSON.stringify(deviceInput()),
    }, env())
    expect(wrongType.status).toBe(415)
  })

  test('rejects malformed bodies and out-of-range fields', async () => {
    const owner = await seedOwner()
    const id = () => crypto.randomUUID()
    const malformed = await api.request(`/api/device-galleries/${id()}`, {
      method: 'PUT',
      headers: { Authorization: owner.bearer, 'Content-Type': 'application/json' },
      body: '{broken json',
    }, env())
    expect(malformed.status).toBe(400)
    for (const body of [null, [1, 2], 42, 'text', true]) {
      expect((await putAs(owner.bearer, id(), body)).status).toBe(400)
    }
    const invalid = [
      { itemCount: -1 },
      { itemCount: 1.5 },
      { itemCount: 1001 },
      { itemCount: '12' },
      { itemCount: null },
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { title: 42 },
      { deviceLabel: '' },
      { deviceLabel: 'y'.repeat(81) },
      { deviceId: 'not-a-uuid' },
      { deviceId: crypto.randomUUID().toUpperCase() },
      { sourceKind: 'album' },
      { publicGallerySlug: 'Not A Slug' },
      { publicGallerySlug: 'a'.repeat(49) },
      { publicGallerySlug: 7 },
      { path: '/Users/x/Photos' },
      { bookmark: 'bookmark-data' },
      { images: [] },
      { src: '/local/file.jpg' },
      { sourceUrl: 'https://example.com' },
      { ownerId: 'dbid:AAATESTspoof' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    for (const overrides of invalid) {
      expect((await putAs(owner.bearer, id(), deviceInput(overrides))).status).toBe(400)
    }
  })

  test('accepts item counts of 0 and 1000 and trims user labels', async () => {
    const owner = await seedOwner()
    const zero = await putAs(owner.bearer, crypto.randomUUID(), deviceInput({ itemCount: 0 }))
    expect(zero.status).toBe(200)
    const max = await putAs(owner.bearer, crypto.randomUUID(), deviceInput({ itemCount: 1000, title: '  Padded Title  ' }))
    expect(max.status).toBe(200)
    const { gallery } = await max.json() as { gallery: { itemCount: number; title: string } }
    expect(gallery.itemCount).toBe(1000)
    expect(gallery.title).toBe('Padded Title')
  })

  test('rejects a body beyond the 8 KiB bound', async () => {
    const owner = await seedOwner()
    const oversized = JSON.stringify(deviceInput({ title: 'x'.repeat(9000) }))
    const response = await api.request(`/api/device-galleries/${crypto.randomUUID()}`, {
      method: 'PUT',
      headers: { Authorization: owner.bearer, 'Content-Type': 'application/json' },
      body: oversized,
    }, env())
    expect(response.status).toBe(413)
  })
})

describe('device catalogue public gallery link', () => {
  test('accepts the owner’s own live gallery and echoes the slug', async () => {
    const owner = await seedOwner()
    await seedGallery(owner.id, 'linked-gallery')
    const response = await putAs(owner.bearer, crypto.randomUUID(), deviceInput({ publicGallerySlug: 'linked-gallery' }))
    expect(response.status).toBe(200)
    const { gallery } = await response.json() as { gallery: { publicGallerySlug?: string } }
    expect(gallery.publicGallerySlug).toBe('linked-gallery')
  })

  test('rejects foreign, missing, and expired gallery references', async () => {
    const owner = await seedOwner()
    const other = await seedOwner('Other Owner')
    await seedGallery(other.id, 'foreign-gallery')
    await seedGallery(owner.id, 'expired-gallery', { expired: true })
    for (const slug of ['foreign-gallery', 'missing-gallery', 'expired-gallery']) {
      expect((await putAs(owner.bearer, crypto.randomUUID(), deviceInput({ publicGallerySlug: slug }))).status).toBe(400)
    }
  })

  test('a catalogue entry never appears on public gallery surfaces', async () => {
    const owner = await seedOwner()
    const id = crypto.randomUUID()
    await putAs(owner.bearer, id, deviceInput({ title: 'DeviceOnlyTitle' }))
    const list = await api.request('/api/galleries', { headers: { Cookie: owner.cookie } }, env())
    expect(list.status).toBe(200)
    const { galleries } = await list.json() as { galleries: { slug: string; title: string }[] }
    expect(galleries.some((gallery) => gallery.title === 'DeviceOnlyTitle' || gallery.slug === id)).toBe(false)
    const manifest = await api.request(`/api/gallery/${owner.slug}/${id}`, {}, env())
    expect(manifest.status).toBe(404)
  })

  test('deleting a catalogue entry keeps its public gallery and never calls a provider', async () => {
    const owner = await seedOwner()
    await seedGallery(owner.id, 'source-gallery')
    const id = crypto.randomUUID()
    await putAs(owner.bearer, id, deviceInput({ publicGallerySlug: 'source-gallery' }))
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1
      return realFetch(...args)
    }) as typeof fetch
    try {
      expect((await deleteAs(owner.bearer, id)).status).toBe(200)
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
    const row = await db.prepare('SELECT COUNT(*) AS count FROM galleries WHERE owner_id = ? AND slug = ?').bind(owner.id, 'source-gallery').first<{ count: number }>()
    expect(row?.count).toBe(1)
  })
})

describe('device catalogue storage failures', () => {
  test('a missing DB binding answers 503 and writes nothing', async () => {
    const id = 'dbid:AAATESTnodbbinding'
    await upsertUser({ dropboxAccountId: id, displayName: 'No Binding' })
    const bearer = `Bearer ${await createSessionToken(id, TEST_SESSION_SECRET)}`
    const noDb = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
    expect((await api.request('/api/device-galleries', { headers: { Authorization: bearer } }, noDb)).status).toBe(503)
    const put = await api.request(`/api/device-galleries/${crypto.randomUUID()}`, {
      method: 'PUT',
      headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify(deviceInput()),
    }, noDb)
    expect(put.status).toBe(503)
  })

  test('an unmigrated database answers 503 rather than falling back', async () => {
    const id = 'dbid:AAATESTstaledb'
    await db
      .prepare('INSERT INTO users (dropbox_account_id, owner_slug, display_name) VALUES (?, ?, ?)')
      .bind(id, 'stale-db', 'Stale DB')
      .run()
    const bearer = `Bearer ${await createSessionToken(id, TEST_SESSION_SECRET)}`
    const staleEnv = { DB: db, HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
    await db.prepare('DROP TABLE device_galleries').run()
    try {
      const list = await api.request('/api/device-galleries', { headers: { Authorization: bearer } }, staleEnv)
      expect(list.status).toBe(503)
      const put = await api.request(`/api/device-galleries/${crypto.randomUUID()}`, {
        method: 'PUT',
        headers: { Authorization: bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceInput()),
      }, staleEnv)
      expect(put.status).toBe(503)
      const leftover = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_galleries'").first()
      expect(leftover).toBeNull()
    } finally {
      await applyMigration(db, '0005_device_galleries.sql')
    }
  })
})

describe('device catalogue CORS', () => {
  const preflight = (origin: string | null, method = 'GET') =>
    api.request('/api/device-galleries', {
      method: 'OPTIONS',
      headers: {
        ...(origin !== null ? { Origin: origin } : {}),
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }, env())

  test('the exact Tauri and Capacitor origins and PUT preflight are allowed', async () => {
    const tauri = await preflight('tauri://localhost', 'PUT')
    expect(tauri.status).toBe(204)
    expect(tauri.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost')
    expect(tauri.headers.get('Access-Control-Allow-Methods')).toContain('PUT')
    expect(tauri.headers.get('Vary')).toBe('Origin')
    const capacitor = await preflight('capacitor://localhost')
    expect(capacitor.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost')
    const dev = await preflight('http://localhost:5173')
    expect(dev.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  test('lookalike origins get no allow-origin but still carry Vary', async () => {
    for (const origin of [
      'tauri://localhost.evil',
      'tauri://localhost/',
      'https://tauri.localhost',
      'http://tauri.localhost',
      'null',
      'https://localhost',
    ]) {
      const response = await preflight(origin)
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(response.headers.get('Vary')).toBe('Origin')
    }
    const refused = await api.request('/api/device-galleries', {
      headers: { Origin: 'https://tauri.localhost' },
    }, env())
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(refused.headers.get('Vary')).toBe('Origin')
    expect(refused.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })
})
