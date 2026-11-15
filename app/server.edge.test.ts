import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('the gallery expiry scheduler', () => {
  const appSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')

  test('the default export gains a scheduled handler without losing the app', () => {
    expect(appSource).toContain('Object.assign(app')
    expect(appSource).toContain('scheduled')
  })

  test('the handler is wired to the expiry orchestration and repository', () => {
    expect(appSource).toContain('expirePipelineGalleries')
    expect(appSource).toContain('listExpiredPipelineGalleries')
    expect(appSource).toContain('deleteExpiredPipelineGallery')
  })

  test('wrangler registers a daily cron trigger', () => {
    expect(wrangler).toContain('[triggers]')
    expect(wrangler).toContain('crons')
  })

  test('the sign-in host gate is mounted before the routes', () => {
    expect(appSource).toContain('signinHostGate')
    expect(appSource.indexOf('signinHostGate')).toBeLessThan(appSource.indexOf('createManoramaApi()'))
  })

  test('wrangler routes the sign-in subdomain and declares its host var', () => {
    expect(wrangler).toContain('signin.manorama.xyz')
    expect(wrangler).toContain('SIGNIN_HOST')
  })
})
