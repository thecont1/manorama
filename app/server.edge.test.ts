import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Vendo is disabled platform-wide for now: the /api/vendo/* route is not
// mounted, server.ts does not import vendo/server, and the admin page
// mounts no client. These source-level assertions keep the disable honest
// — revert this file together with the route wiring to re-enable.
describe('Vendo disabled', () => {
  const appSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const ownerPage = readFileSync(new URL('./routes/[owner].tsx', import.meta.url), 'utf8')

  test('the app mounts no /api/vendo route and imports no vendo handler', () => {
    expect(appSource).not.toContain('/api/vendo')
    expect(appSource).not.toContain('vendo/server')
  })

  test('the admin page ships no vendo mount point or client bundle', () => {
    expect(ownerPage).not.toContain('vendo-root')
    expect(ownerPage).not.toContain('vendo-client')
  })
})
