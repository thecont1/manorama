import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { getPlatformProxy } from 'wrangler'
import { fileURLToPath } from 'node:url'
import type { D1Database } from '@cloudflare/workers-types'
import { applyDevMigrations, DEV_MIGRATIONS_TABLE, injectDevD1 } from './dev-d1'

const globals = globalThis as {
  __manoramaDevD1?: unknown
  __manoramaDevD1Ready?: Promise<unknown>
}

afterEach(() => {
  delete globals.__manoramaDevD1
  delete globals.__manoramaDevD1Ready
})

describe('injectDevD1', () => {
  const app = () => {
    const hono = new Hono()
    hono.use('*', injectDevD1)
    hono.get('/', (c) => c.json({ db: (c.env as { DB?: unknown }).DB ?? null }))
    return hono
  }

  test('parks the dev binding into c.env when the request has none', async () => {
    const db = { __dev: true }
    globals.__manoramaDevD1 = db
    globals.__manoramaDevD1Ready = Promise.resolve()
    const res = await app().request('/', {}, {})
    expect(await res.json()).toEqual({ db: { __dev: true } })
  })

  test('waits on the readiness promise before injecting', async () => {
    const db = { __dev: true }
    let ready = false
    globals.__manoramaDevD1Ready = new Promise<void>((resolve) => {
      setTimeout(() => {
        globals.__manoramaDevD1 = db
        ready = true
        resolve()
      }, 5)
    })
    const res = await app().request('/', {}, {})
    expect(ready).toBe(true)
    expect(await res.json()).toEqual({ db: { __dev: true } })
  })

  test('never overrides a real binding', async () => {
    globals.__manoramaDevD1 = { __dev: true }
    const res = await app().request('/', {}, { DB: { real: true } })
    expect(await res.json()).toEqual({ db: { real: true } })
  })

  test('is a no-op when the globals are absent', async () => {
    const res = await app().request('/', {}, { SOME_VAR: 'x' })
    expect(await res.json()).toEqual({ db: null })
  })

  test('fails the request when the boot failed instead of limping without D1', async () => {
    globals.__manoramaDevD1Ready = Promise.reject(new Error('no workerd'))
    // A rejected readiness promise means the proxy or a migration failed —
    // requests must not reach handlers on memory stores that pretend the
    // identity layer works.
    const res = await app().request('/', {}, {})
    expect(res.status).toBe(500)
  })
})

describe('applyDevMigrations', () => {
  test('applies each file once, in order, and tracks them', async () => {
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(new URL('../../wrangler.toml', import.meta.url)),
      persist: false,
    })
    try {
      const db = proxy.env.DB
      const files = [
        { name: '0002_second.sql', sql: 'CREATE TABLE second (id INTEGER PRIMARY KEY); INSERT INTO second VALUES (2);' },
        { name: '0001_first.sql', sql: '-- a comment\nCREATE TABLE first (id INTEGER PRIMARY KEY);\n\nINSERT INTO first VALUES (1);' },
      ]
      expect(await applyDevMigrations(db, files)).toEqual(['0001_first.sql', '0002_second.sql'])
      expect(await db.prepare('SELECT id FROM first').first()).toEqual({ id: 1 })
      expect(await db.prepare('SELECT id FROM second').first()).toEqual({ id: 2 })
      const tracked = (await db.prepare(`SELECT name FROM ${DEV_MIGRATIONS_TABLE} ORDER BY name`).all<{ name: string }>()).results
      expect(tracked).toEqual([{ name: '0001_first.sql' }, { name: '0002_second.sql' }])
      expect(await applyDevMigrations(db, files)).toEqual([])
    } finally {
      await proxy.dispose()
    }
  }, 20_000)
})
