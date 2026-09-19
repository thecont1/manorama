import { afterAll, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import {
  createGallery,
  createGalleryWithinLimit,
  deleteGallery,
  getGallery,
  getStoredGallery,
  listGalleries,
  resetGalleryStore,
  updateGalleryImages,
  updateGalleryMetadata,
  updateGalleryOrder,
  updateGalleryRecord,
  updateGallerySlug,
  type GalleryEnv,
  type GalleryRecord,
} from './gallery-repository'
import { resetUserStore, setUserTier, upsertUser } from './user-repository'
import { GalleryPolicyError, PIPELINE_LIFETIME_MS, PIPELINE_LOCK_MESSAGE } from './gallery-policy'
import type { GalleryImage } from './imagesource'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 'dbid:AAATESTowner1'
const DAY_MS = 24 * 60 * 60 * 1000

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

const image = (id: string): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3,
  alt: 'a photograph', c2pa: false, placeholder: '',
})

const galleryRecord = (slug: string, extra: Partial<GalleryRecord> = {}): GalleryRecord => ({
  slug,
  title: slug,
  caption: '',
  date: '',
  createdAt: new Date().toISOString(),
  images: [image(`img-${slug}`)],
  ...extra,
})

type Backend = {
  env?: GalleryEnv
  seedUser: (tier?: 'free' | 'pro', id?: string) => Promise<void>
  seedRetained: (count: number, prefix?: string) => Promise<void>
  teardown: () => Promise<void>
}

const seedViaRepo = (env: GalleryEnv | undefined) => async (count: number, prefix = 'g'): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const result = await createGalleryWithinLimit(OWNER, galleryRecord(`${prefix}-${index}`), env)
    if (!result.ok || result.gallery.retention !== 'retained') {
      throw new Error(`seedRetained failed at ${prefix}-${index}: ${result.ok ? result.gallery.retention : result.reason}`)
    }
  }
}

const memoryBackend = async (): Promise<Backend> => {
  resetUserStore()
  resetGalleryStore()
  return {
    env: undefined,
    seedUser: async (tier = 'free', id = OWNER) => {
      await upsertUser({ dropboxAccountId: id, displayName: 'Test Owner' })
      if (tier === 'pro') await setUserTier(id, 'pro')
    },
    seedRetained: seedViaRepo(undefined),
    teardown: async () => {},
  }
}

let sharedD1: { proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> } | null = null

const sharedD1Database = async () => {
  if (!sharedD1) {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: `${repoRoot}/wrangler.toml`,
      persist: false,
    })
    await applyMigration(proxy.env.DB, '0001_users_and_galleries.sql')
    await applyMigration(proxy.env.DB, '0002_gallery_retention.sql')
    sharedD1 = { proxy }
  }
  return sharedD1.proxy.env.DB
}

afterAll(async () => {
  await sharedD1?.proxy.dispose()
  sharedD1 = null
})

const d1Backend = async (): Promise<Backend> => {
  const db = await sharedD1Database()
  await db.prepare('DELETE FROM galleries').run()
  await db.prepare('DELETE FROM users').run()
  const env: GalleryEnv = { DB: db }
  return {
    env,
    seedUser: async (tier = 'free', id = OWNER) => {
      await db
        .prepare('INSERT INTO users (dropbox_account_id, owner_slug, display_name, tier) VALUES (?, ?, ?, ?)')
        .bind(id, `u-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'Test Owner', tier)
        .run()
    },
    seedRetained: seedViaRepo(env),
    teardown: async () => {},
  }
}

const openBackend = (name: 'memory' | 'd1') => (name === 'memory' ? memoryBackend() : d1Backend())

const withBackend = (name: 'memory' | 'd1', fn: (backend: Backend) => Promise<void>) => async () => {
  const backend = await openBackend(name)
  try {
    await fn(backend)
  } finally {
    await backend.teardown()
  }
}

const BACKENDS = ['memory', 'd1'] as const

const expectReadOnly = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(GalleryPolicyError)
    expect((error as GalleryPolicyError).code).toBe('GALLERY_READ_ONLY')
    expect((error as GalleryPolicyError).message).toBe(PIPELINE_LOCK_MESSAGE)
    return
  }
  throw new Error('expected a GalleryPolicyError')
}

describe('migration 0002 on a legacy database', () => {
  test('pre-existing rows become retained galleries with no expiry', async () => {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: `${repoRoot}/wrangler.toml`,
      persist: false,
    })
    const db = proxy.env.DB
    try {
      await applyMigration(db, '0001_users_and_galleries.sql')
      await db.prepare('INSERT INTO users (dropbox_account_id, owner_slug, display_name) VALUES (?, ?, ?)')
        .bind(OWNER, 'test-owner', 'Test Owner').run()
      await db.prepare(`INSERT INTO galleries (slug, owner_id, title, caption, date, source_url, images_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind('legacy', OWNER, 'Legacy', '', '', 'https://www.dropbox.com/scl/fo/legacy', '[]', '2026-01-01T00:00:00.000Z')
        .run()
      await applyMigration(db, '0002_gallery_retention.sql')

      const row = await db.prepare('SELECT retention, expires_at FROM galleries WHERE slug = ?')
        .bind('legacy').first<{ retention: string; expires_at: string | null }>()
      expect(row?.retention).toBe('retained')
      expect(row?.expires_at).toBeNull()

      const record = await getStoredGallery(OWNER, 'legacy', { DB: db })
      expect(record?.retention).toBe('retained')
      expect(record?.expiresAt).toBeNull()
    } finally {
      await proxy.dispose()
    }
  })
})

for (const backend of BACKENDS) {
  describe(`retained vs pipeline allocation (${backend})`, () => {
    for (const [retained, expected] of [[0, 'retained'], [2, 'retained'], [3, 'pipeline']] as const) {
      test(`a free owner with ${retained} retained galleries gets a ${expected} gallery`, withBackend(backend, async (b) => {
        await b.seedUser('free')
        await b.seedRetained(retained)
        const result = await createGalleryWithinLimit(OWNER, galleryRecord('next'), b.env)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.gallery.retention).toBe(expected)
      }))
    }

    test('a pipeline gallery expires exactly 30 days after creation', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      const createdAt = '2026-09-10T12:00:00.000Z'
      const result = await createGalleryWithinLimit(OWNER, galleryRecord('temp', { createdAt }), b.env)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.gallery.retention).toBe('pipeline')
      expect(result.gallery.createdAt).toBe(createdAt)
      expect(result.gallery.expiresAt).toBe(new Date(Date.parse(createdAt) + PIPELINE_LIFETIME_MS).toISOString())
    }))

    test('two concurrent creates at 2 retained produce one retained and one pipeline', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(2)
      const [first, second] = await Promise.all([
        createGalleryWithinLimit(OWNER, galleryRecord('race-a'), b.env),
        createGalleryWithinLimit(OWNER, galleryRecord('race-b'), b.env),
      ])
      expect(first.ok && second.ok).toBe(true)
      const retentions = [first, second]
        .map((result) => (result.ok ? result.gallery.retention : 'failed'))
        .sort()
      expect(retentions).toEqual(['pipeline', 'retained'])
      const third = await createGalleryWithinLimit(OWNER, galleryRecord('race-c'), b.env)
      expect(third.ok).toBe(true)
      if (third.ok) expect(third.gallery.retention).toBe('pipeline')
    }))

    test('a pro owner is capped at 99 retained galleries through both create wrappers', withBackend(backend, async (b) => {
      await b.seedUser('pro')
      await b.seedRetained(99)
      const result = await createGalleryWithinLimit(OWNER, galleryRecord('one-hundred'), b.env)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('limit')
      try {
        await createGallery(OWNER, galleryRecord('one-hundred-one'), b.env)
        throw new Error('expected createGallery to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(GalleryPolicyError)
        expect((error as GalleryPolicyError).code).toBe('GALLERY_LIMIT')
      }
    }))

    test('an incoming retention flag cannot bypass the pipeline assignment', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      const result = await createGalleryWithinLimit(
        OWNER,
        galleryRecord('spoofed', { retention: 'retained', expiresAt: null }),
        b.env,
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.gallery.retention).toBe('pipeline')
      const stored = await getStoredGallery(OWNER, 'spoofed', b.env)
      expect(stored?.retention).toBe('pipeline')
      expect(stored?.expiresAt).toBeTruthy()
    }))

    test('duplicate slugs and duplicate sources fail the same on both stores', withBackend(backend, async (b) => {
      await b.seedUser('free')
      const sourceUrl = 'https://www.dropbox.com/scl/fo/album'
      const first = await createGalleryWithinLimit(OWNER, galleryRecord('one', { sourceUrl }), b.env)
      expect(first.ok).toBe(true)
      const sameSlug = await createGalleryWithinLimit(OWNER, galleryRecord('one'), b.env)
      expect(sameSlug.ok).toBe(false)
      if (!sameSlug.ok) expect(sameSlug.reason).toBe('conflict')
      const sameSource = await createGalleryWithinLimit(OWNER, galleryRecord('two', { sourceUrl }), b.env)
      expect(sameSource.ok).toBe(false)
      if (!sameSource.ok) expect(sameSource.reason).toBe('duplicate-source')
    }))
  })

  describe(`pipeline galleries are read-only (${backend})`, () => {
    const seedPipeline = async (b: Backend) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      const result = await createGalleryWithinLimit(OWNER, galleryRecord('locked'), b.env)
      if (!result.ok || result.gallery.retention !== 'pipeline') throw new Error('pipeline seed failed')
    }

    test('every editorial helper rejects a pipeline gallery', withBackend(backend, async (b) => {
      await seedPipeline(b)
      const stored = (await getStoredGallery(OWNER, 'locked', b.env))!
      await expectReadOnly(updateGalleryRecord(OWNER, { ...stored, title: 'New title' }, b.env))
      await expectReadOnly(updateGalleryImages(OWNER, 'locked', [image('replacement')], b.env))
      await expectReadOnly(updateGalleryMetadata(OWNER, 'locked', { title: 'New title' }, b.env))
      await expectReadOnly(updateGalleryMetadata(OWNER, 'locked', {}, b.env))
      await expectReadOnly(updateGallerySlug(OWNER, 'locked', 'renamed', b.env))
      await expectReadOnly(updateGallerySlug(OWNER, 'locked', 'locked', b.env))
      await expectReadOnly(updateGalleryOrder(OWNER, 'locked', ['img-locked.jpg'], b.env))
      await expectReadOnly(updateGalleryRecord(OWNER, { ...stored, retention: 'retained', expiresAt: null }, b.env))
      const after = (await getStoredGallery(OWNER, 'locked', b.env))!
      expect(after.title).toBe('locked')
      expect(after.retention).toBe('pipeline')
      expect(after.images.map((item) => item.id)).toEqual(['img-locked'])
    }))

    test('the owner can still delete a pipeline gallery, even an expired one', withBackend(backend, async (b) => {
      await seedPipeline(b)
      expect(await deleteGallery(OWNER, 'locked', b.env)).toBe(true)
      const expired = await createGalleryWithinLimit(
        OWNER,
        galleryRecord('gone', { createdAt: new Date(Date.now() - 40 * DAY_MS).toISOString() }),
        b.env,
      )
      expect(expired.ok).toBe(true)
      expect(await deleteGallery(OWNER, 'gone', b.env)).toBe(true)
      expect(await getStoredGallery(OWNER, 'gone', b.env)).toBeNull()
    }))

    test('reads hide expired pipeline galleries while stored records remain reachable', withBackend(backend, async (b) => {
      await seedPipeline(b)
      const live = await createGalleryWithinLimit(
        OWNER,
        galleryRecord('dying', { createdAt: new Date(Date.now() - 40 * DAY_MS).toISOString() }),
        b.env,
      )
      expect(live.ok).toBe(true)
      expect(await getGallery(OWNER, 'dying', b.env)).toBeNull()
      const slugs = (await listGalleries(OWNER, b.env)).map((gallery) => gallery.slug)
      expect(slugs).not.toContain('dying')
      expect(slugs).toContain('locked')
      const stored = await getStoredGallery(OWNER, 'dying', b.env)
      expect(stored?.retention).toBe('pipeline')
      expect(stored?.expiresAt).toBeTruthy()
    }))
  })

  describe(`upgrading to pro promotes live pipeline galleries (${backend})`, () => {
    test('unexpired pipelines are promoted; expired and boundary rows are not', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      const now = new Date().toISOString()
      await createGalleryWithinLimit(OWNER, galleryRecord('fresh'), b.env)
      await createGalleryWithinLimit(OWNER, galleryRecord('stale', { createdAt: new Date(Date.now() - 40 * DAY_MS).toISOString() }), b.env)
      await createGalleryWithinLimit(
        OWNER,
        galleryRecord('boundary', { createdAt: new Date(Date.parse(now) - PIPELINE_LIFETIME_MS).toISOString() }),
        b.env,
      )

      await setUserTier(OWNER, 'pro', b.env, now)

      const fresh = await getStoredGallery(OWNER, 'fresh', b.env)
      expect(fresh?.retention).toBe('retained')
      expect(fresh?.expiresAt).toBeNull()
      expect((await getStoredGallery(OWNER, 'stale', b.env))?.retention).toBe('pipeline')
      expect((await getStoredGallery(OWNER, 'boundary', b.env))?.retention).toBe('pipeline')

      await setUserTier(OWNER, 'pro', b.env, now)
      expect((await getStoredGallery(OWNER, 'fresh', b.env))?.retention).toBe('retained')

      const updated = await updateGalleryMetadata(OWNER, 'fresh', { title: 'Editable again' }, b.env)
      expect(updated?.title).toBe('Editable again')
    }))

    test('a create racing the upgrade can never strand a live pipeline', async () => {
      for (const order of ['upgrade-first', 'create-first'] as const) {
        const b = await openBackend(backend)
        try {
          await b.seedUser('free')
          await b.seedRetained(3)
          const piped = await createGalleryWithinLimit(OWNER, galleryRecord('piped'), b.env)
          expect(piped.ok && piped.gallery.retention === 'pipeline').toBe(true)
          const upgrade = () => setUserTier(OWNER, 'pro', b.env, new Date().toISOString())
          const create = () => createGalleryWithinLimit(OWNER, galleryRecord('racing'), b.env)
          const [upgradeResult, createResult] = order === 'upgrade-first'
            ? await Promise.all([upgrade(), create()])
            : await Promise.all([create(), upgrade()]).then(([created, upgraded]) => [upgraded, created] as const)
          expect(upgradeResult?.tier).toBe('pro')
          expect(createResult.ok).toBe(true)
          const stored = await listGalleries(OWNER, b.env)
          expect(stored).toHaveLength(5)
          expect(stored.every((gallery) => gallery.retention === 'retained')).toBe(true)
          expect(stored.every((gallery) => gallery.expiresAt === null)).toBe(true)
        } finally {
          await b.teardown()
        }
      }
    })

    test('a deleted pipeline gallery is not resurrected by promotion', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      await createGalleryWithinLimit(OWNER, galleryRecord('doomed'), b.env)
      expect(await deleteGallery(OWNER, 'doomed', b.env)).toBe(true)
      await setUserTier(OWNER, 'pro', b.env, new Date().toISOString())
      expect(await getStoredGallery(OWNER, 'doomed', b.env)).toBeNull()
    }))

    test('promotion is uncapped beyond 99, but the next create is denied', withBackend(backend, async (b) => {
      await b.seedUser('free')
      await b.seedRetained(3)
      for (let index = 0; index < 100; index += 1) {
        const result = await createGalleryWithinLimit(OWNER, galleryRecord(`extra-${index}`), b.env)
        if (!result.ok || result.gallery.retention !== 'pipeline') throw new Error(`pipeline seed failed at ${index}`)
      }
      await setUserTier(OWNER, 'pro', b.env, new Date().toISOString())
      const spot = await getStoredGallery(OWNER, 'extra-42', b.env)
      expect(spot?.retention).toBe('retained')
      expect(spot?.expiresAt).toBeNull()
      const denied = await createGalleryWithinLimit(OWNER, galleryRecord('over-the-top'), b.env)
      expect(denied.ok).toBe(false)
      if (!denied.ok) expect(denied.reason).toBe('limit')
    }))
  })
}
