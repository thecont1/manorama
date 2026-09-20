import { afterAll, describe, expect, test } from 'bun:test'
import { getPlatformProxy } from 'wrangler'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { expirePipelineGalleries } from './gallery-expiry'
import {
  createGalleryWithinLimit,
  deleteExpiredPipelineGallery,
  deleteGallery,
  getStoredGallery,
  listExpiredPipelineGalleries,
  resetGalleryStore,
  type ExpiredGalleryKey,
  type GalleryEnv,
} from './gallery-repository'
import { resetUserStore, setUserTier, upsertUser } from './user-repository'
import { PIPELINE_LIFETIME_MS } from './gallery-policy'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 'dbid:AAATESTowner1'
const NOW = '2026-10-01T00:00:00.000Z'

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

const key = (slug: string, expiresAt = NOW, ownerId = OWNER): ExpiredGalleryKey => ({ ownerId, slug, expiresAt })
const keys = (count: number, start = 0): ExpiredGalleryKey[] =>
  Array.from({ length: count }, (_, index) => key(`g-${start + index}`))

const mockRepository = (stored: ExpiredGalleryKey[], remove?: (item: ExpiredGalleryKey) => Promise<boolean>) => {
  const listCalls: (ExpiredGalleryKey | undefined)[] = []
  const removed: ExpiredGalleryKey[] = []
  return {
    listCalls,
    removed,
    list: async (_now: string, after?: ExpiredGalleryKey, limit = 100) => {
      listCalls.push(after)
      const start = after ? stored.findIndex((item) => item.slug === after.slug && item.ownerId === after.ownerId) + 1 : 0
      return stored.slice(start, start + limit)
    },
    remove: async (item: ExpiredGalleryKey) => {
      removed.push(item)
      return remove ? remove(item) : true
    },
  }
}

describe('expirePipelineGalleries orchestration', () => {
  test('walks every page with a keyset cursor and reports counters', async () => {
    const repo = mockRepository(keys(150))
    const counters = await expirePipelineGalleries(repo, NOW)
    expect(counters).toEqual({ scanned: 150, deleted: 150, skipped: 0, failed: 0, truncated: false })
    expect(repo.listCalls).toHaveLength(2)
    expect(repo.listCalls[0]).toBeUndefined()
    expect(repo.listCalls[1]?.slug).toBe('g-99')
    expect(repo.removed).toHaveLength(150)
  })

  test('a remove failure advances the cursor instead of starving later work', async () => {
    const repo = mockRepository(keys(120), async (item) => {
      if (item.slug === 'g-5') throw new Error('storage hiccup')
      return true
    })
    const counters = await expirePipelineGalleries(repo, NOW)
    expect(counters).toEqual({ scanned: 120, deleted: 119, skipped: 0, failed: 1, truncated: false })
    expect(repo.removed).toHaveLength(120)
    expect(repo.listCalls[1]?.slug).toBe('g-99')
  })

  test('a false remove counts as skipped — the row already left the pipeline', async () => {
    const repo = mockRepository(keys(3), async (item) => item.slug !== 'g-1')
    const counters = await expirePipelineGalleries(repo, NOW)
    expect(counters).toEqual({ scanned: 3, deleted: 2, skipped: 1, failed: 0, truncated: false })
  })

  test('a list failure propagates — the run reports nothing rather than skipping silently', async () => {
    const repo = {
      list: async () => { throw new Error('database unavailable') },
      remove: async () => true,
    }
    try {
      await expirePipelineGalleries(repo, NOW)
      throw new Error('expected the list failure to propagate')
    } catch (error) {
      expect((error as Error).message).toBe('database unavailable')
    }
  })

  test('the walk is bounded at 100 pages even when the repo never drains', async () => {
    let produced = 0
    const repo = {
      listCalls: 0,
      list: async (_now: string, _after?: ExpiredGalleryKey, limit = 100) => {
        repo.listCalls += 1
        const page = keys(limit, produced)
        produced += limit
        return page
      },
      remove: async () => true,
    }
    const counters = await expirePipelineGalleries(repo, NOW)
    expect(repo.listCalls).toBe(101)
    expect(counters.scanned).toBe(10_000)
    expect(counters.deleted).toBe(10_000)
    expect(counters.truncated).toBe(true)
  })

  test('a rerun over a drained repo is a harmless no-op', async () => {
    const repo = mockRepository([])
    const counters = await expirePipelineGalleries(repo, NOW)
    expect(counters).toEqual({ scanned: 0, deleted: 0, skipped: 0, failed: 0, truncated: false })
    expect(repo.listCalls).toHaveLength(1)
  })
})

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

const BACKENDS = ['memory', 'd1'] as const

const image = { id: 'i-1', filename: 'i-1.jpg', src: '/images/i-1.jpg', width: 4, height: 3, alt: 'a photograph', c2pa: false, placeholder: '' }

const seedExpiredSet = async (env: GalleryEnv | undefined) => {
  for (let index = 0; index < 3; index += 1) {
    await createGalleryWithinLimit(OWNER, {
      slug: `kept-${index}`, title: `kept-${index}`, caption: '', date: '', images: [image],
    }, env)
  }
  const past = new Date(Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000).toISOString()
  await createGalleryWithinLimit(OWNER, { slug: 'old-1', title: 'old-1', caption: '', date: '', createdAt: past, images: [image] }, env)
  await createGalleryWithinLimit(OWNER, { slug: 'old-2', title: 'old-2', caption: '', date: '', createdAt: past, images: [image] }, env)
  const recent = new Date(Date.parse(NOW) - 5 * 24 * 60 * 60 * 1000).toISOString()
  await createGalleryWithinLimit(OWNER, { slug: 'fresh-pipe', title: 'fresh-pipe', caption: '', date: '', createdAt: recent, images: [image] }, env)
}

for (const backend of BACKENDS) {
  describe(`expiry repository on ${backend}`, () => {
    const openBackend = async (): Promise<{ env?: GalleryEnv; teardown: () => Promise<void> }> => {
      if (backend === 'memory') {
        resetUserStore()
        resetGalleryStore()
        await upsertUser({ dropboxAccountId: OWNER, displayName: 'Test Owner' })
        return { env: undefined, teardown: async () => {} }
      }
      const db = await sharedD1Database()
      await db.prepare('DELETE FROM galleries').run()
      await db.prepare('DELETE FROM users').run()
      await db.prepare('INSERT INTO users (dropbox_account_id, owner_slug, display_name) VALUES (?, ?, ?)')
        .bind(OWNER, 'test-owner', 'Test Owner').run()
      return { env: { DB: db }, teardown: async () => {} }
    }

    const withBackend = (fn: (env: GalleryEnv | undefined) => Promise<void>) => async () => {
      const { env, teardown } = await openBackend()
      try {
        await fn(env)
      } finally {
        await teardown()
      }
    }

    test('the real repository deletes only expired pipeline rows', withBackend(async (env) => {
      await seedExpiredSet(env)
      const counters = await expirePipelineGalleries({
        list: (at, after, limit) => listExpiredPipelineGalleries(at, env, after, limit),
        remove: (item, at) => deleteExpiredPipelineGallery(item, at, env),
      }, NOW)
      expect(counters).toEqual({ scanned: 2, deleted: 2, skipped: 0, failed: 0, truncated: false })
      expect(await getStoredGallery(OWNER, 'old-1', env)).toBeNull()
      expect(await getStoredGallery(OWNER, 'old-2', env)).toBeNull()
      expect((await getStoredGallery(OWNER, 'fresh-pipe', env))?.retention).toBe('pipeline')
      expect((await getStoredGallery(OWNER, 'kept-0', env))?.retention).toBe('retained')
      const rerun = await expirePipelineGalleries({
        list: (at, after, limit) => listExpiredPipelineGalleries(at, env, after, limit),
        remove: (item, at) => deleteExpiredPipelineGallery(item, at, env),
      }, NOW)
      expect(rerun).toEqual({ scanned: 0, deleted: 0, skipped: 0, failed: 0, truncated: false })
    }))

    test('the guarded delete refuses retained, upgraded, and not-yet-expired keys', withBackend(async (env) => {
      await seedExpiredSet(env)
      expect(await deleteExpiredPipelineGallery(key('kept-0'), NOW, env)).toBe(false)
      expect(await getStoredGallery(OWNER, 'kept-0', env)).not.toBeNull()
      const live = (await getStoredGallery(OWNER, 'fresh-pipe', env))!
      expect(await deleteExpiredPipelineGallery({ ownerId: OWNER, slug: 'fresh-pipe', expiresAt: live.expiresAt! }, NOW, env)).toBe(false)
      expect(await getStoredGallery(OWNER, 'fresh-pipe', env)).not.toBeNull()
    }))

    test('keyset pages are stable when expiry timestamps collide across owners and slugs', withBackend(async (env) => {
      const ownerA = 'dbid:AAATESTexpiry-a'
      const ownerZ = 'dbid:AAATESTexpiry-z'
      await upsertUser({ dropboxAccountId: ownerA, displayName: 'Expiry Owner A' }, env)
      await upsertUser({ dropboxAccountId: ownerZ, displayName: 'Expiry Owner Z' }, env)

      for (const ownerId of [ownerA, ownerZ]) {
        for (let index = 0; index < 3; index += 1) {
          const result = await createGalleryWithinLimit(ownerId, {
            slug: `kept-${index}`, title: `kept-${index}`, caption: '', date: '', images: [image],
          }, env)
          expect(result.ok && result.gallery.retention === 'retained').toBe(true)
        }
      }

      const boundaryCreated = new Date(Date.parse(NOW) - PIPELINE_LIFETIME_MS).toISOString()
      const earlierCreated = new Date(Date.parse(boundaryCreated) - 1).toISOString()
      for (const [ownerId, slug, createdAt] of [
        [ownerZ, 'first', earlierCreated],
        [ownerZ, 'z-last', boundaryCreated],
        [ownerA, 'b-middle', boundaryCreated],
        [ownerA, 'a-middle', boundaryCreated],
      ] as const) {
        const result = await createGalleryWithinLimit(ownerId, {
          slug, title: slug, caption: '', date: '', createdAt, images: [image],
        }, env)
        expect(result.ok && result.gallery.retention === 'pipeline').toBe(true)
      }

      const firstPage = await listExpiredPipelineGalleries(NOW, env, undefined, 2)
      expect(firstPage).toEqual([
        key('first', '2026-09-30T23:59:59.999Z', ownerZ),
        key('a-middle', NOW, ownerA),
      ])

      const secondPage = await listExpiredPipelineGalleries(NOW, env, firstPage[1], 2)
      expect(secondPage).toEqual([
        key('b-middle', NOW, ownerA),
        key('z-last', NOW, ownerZ),
      ])
      expect(await listExpiredPipelineGalleries(NOW, env, secondPage[1], 2)).toEqual([])
    }))

    test('an upgrade between scan and delete turns the removal into a skip', withBackend(async (env) => {
      for (let index = 0; index < 3; index += 1) {
        await createGalleryWithinLimit(OWNER, {
          slug: `kept-${index}`, title: `kept-${index}`, caption: '', date: '', images: [image],
        }, env)
      }
      const boundaryCreated = new Date(Date.parse(NOW) - PIPELINE_LIFETIME_MS).toISOString()
      await createGalleryWithinLimit(OWNER, { slug: 'edge', title: 'edge', caption: '', date: '', createdAt: boundaryCreated, images: [image] }, env)
      const [staleKey] = await listExpiredPipelineGalleries(NOW, env)
      expect(staleKey.slug).toBe('edge')
      expect(staleKey.expiresAt).toBe(NOW)
      const upgraded = await setUserTier(OWNER, 'pro', env, new Date(Date.parse(NOW) - 1).toISOString())
      expect(upgraded?.tier).toBe('pro')
      expect((await getStoredGallery(OWNER, 'edge', env))?.retention).toBe('retained')
      expect(await deleteExpiredPipelineGallery(staleKey, NOW, env)).toBe(false)
      expect(await getStoredGallery(OWNER, 'edge', env)).not.toBeNull()
    }))

    test('the guarded delete cannot remove a gallery recreated under the same slug', withBackend(async (env) => {
      await seedExpiredSet(env)
      const [staleKey] = await listExpiredPipelineGalleries(NOW, env)
      expect(staleKey.slug).toBe('old-1')
      expect(await deleteGallery(OWNER, 'old-1', env)).toBe(true)
      const recreated = await createGalleryWithinLimit(OWNER, {
        slug: 'old-1', title: 'old-1', caption: '', date: '', images: [image],
      }, env)
      expect(recreated.ok).toBe(true)
      expect(await deleteExpiredPipelineGallery(staleKey, NOW, env)).toBe(false)
      expect(await getStoredGallery(OWNER, 'old-1', env)).not.toBeNull()
      const rest = await listExpiredPipelineGalleries(NOW, env, staleKey)
      expect(rest).toHaveLength(1)
      expect(await deleteExpiredPipelineGallery(rest[0], NOW, env)).toBe(true)
    }))

    test('a manual delete mid-scan turns the remove into a skip', withBackend(async (env) => {
      await seedExpiredSet(env)
      const [staleKey] = await listExpiredPipelineGalleries(NOW, env)
      expect(await deleteGallery(OWNER, staleKey.slug, env)).toBe(true)
      expect(await deleteExpiredPipelineGallery(staleKey, NOW, env)).toBe(false)
    }))

    test('expiry never reaches a provider — a throwing fetch would break the run', withBackend(async (env) => {
      await seedExpiredSet(env)
      const realFetch = globalThis.fetch
      let called = 0
      globalThis.fetch = (async () => { called += 1; throw new Error('provider access attempted') }) as typeof fetch
      try {
        const counters = await expirePipelineGalleries({
          list: (at, after, limit) => listExpiredPipelineGalleries(at, env, after, limit),
          remove: (item, at) => deleteExpiredPipelineGallery(item, at, env),
        }, NOW)
        expect(counters.deleted).toBe(2)
      } finally {
        globalThis.fetch = realFetch
      }
      expect(called).toBe(0)
    }))
  })
}
