import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { handleVendoRequest } from '../vendo/server'

/** Mirrors app/server.ts's init: the same wiring the HonoX composition mounts,
 * minus honox's import.meta.glob route auto-discovery (a Vite transform this
 * plain-Hono test harness cannot run). The /api/vendo/* route below is the
 * production path: the EDGE ESM handler, not the CJS/PGlite adapter.
 * No VENDO_API_KEY: local PGlite-less composition, no Cloud enrolment. */
const app = new Hono()
app.all('/api/vendo/*', async (c) => {
  return await handleVendoRequest(c.req.raw, { VENDO_API_KEY: '' })
})

describe('HonoX → edge Vendo handler integration', () => {
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

  test('forwards every HTTP method to the Vendo handler unchanged', async () => {
    for (const method of methods) {
      const response = await app.request('/api/vendo/status', { method })
      // The edge handler answers itself: never a Hono 404 (unmatched route).
      expect(response.status).not.toBe(404)
    }
  })

  test('anonymous requests are rejected by the session gate', async () => {
    // POST /api/vendo/threads is the turn-starting route the overlay uses;
    // other methods either 403 (identity gate) or 400/404 (route validation)
    // — never a Hono routing miss, which would mean the mount is gone.
    const response = await app.request('/api/vendo/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect([401, 403]).toContain(response.status)
    const get = await app.request('/api/vendo/threads')
    expect(get.status).toBe(403)
  })

  test('invalid bearer tokens are rejected', async () => {
    const response = await app.request('/api/vendo/threads', {
      headers: { Authorization: 'Bearer not-a-real-jwt' },
    })
    expect([401, 403]).toContain(response.status)
  })

  test('the app module graph imports the ESM edge handler, not handler.cjs', () => {
    const source = readFileSync(new URL('../vendo/server.ts', import.meta.url), 'utf8')
    expect(source).toContain('export function handleVendoRequest')
    const appSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(appSource).not.toContain('handler.cjs')
    expect(appSource).not.toContain('createRequire')
    expect(appSource).toMatch(/from ['"]\.\.\/vendo\/server['"]/)
  })
})
