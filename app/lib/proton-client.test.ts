import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { capacitorHttpFetch, extractProtonLink } from './proton-client'

describe('extractProtonLink', () => {
  test('splits a public link into path token and fragment password', () => {
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh#secretpassword'))
      .toEqual({ token: 'AbCdEf12_Gh', password: 'secretpassword' })
  })

  test('accepts a trailing slash and a query; the fragment stays the secret', () => {
    const link = extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh/?x=1#pw')
    expect(link).toEqual({ token: 'AbCdEf12_Gh', password: 'pw' })
  })

  test('refuses keyless, non-share, wrong-host, and non-https input', () => {
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh')).toBeNull()
    expect(extractProtonLink('https://drive.proton.me/urls/AbCdEf12_Gh#')).toBeNull()
    expect(extractProtonLink('https://drive.proton.me/u/0/folders/xyz#pw')).toBeNull()
    expect(extractProtonLink('https://example.com/urls/AbCdEf12_Gh#pw')).toBeNull()
    expect(extractProtonLink('http://drive.proton.me/urls/AbCdEf12_Gh#pw')).toBeNull()
    expect(extractProtonLink('not a link')).toBeNull()
  })
})

// CapacitorHttp is the transport inside the native shell: it talks to
// drive-api.proton.me from the native network stack, which Proton's
// drive.proton.me-only CORS policy cannot refuse. These stubs stand in
// for the plugin without touching the bridge.
describe('capacitorHttpFetch', () => {
  test('forwards method, headers and body, always requesting an arraybuffer', async () => {
    let seen: Record<string, unknown> = {}
    const fetchImpl = capacitorHttpFetch(async (options) => {
      seen = options
      return { status: 200, headers: { 'content-type': 'application/json' }, data: btoa('{"ok":true}') }
    })
    const response = await fetchImpl('https://drive-api.proton.me/core/v4/urls', {
      method: 'POST',
      headers: { 'x-pm-appversion': 'external-drive-manorama@1.0.0-stable' },
      body: '{"token":"abc"}',
    })
    expect(seen.method).toBe('POST')
    expect(seen.headers).toEqual({ 'x-pm-appversion': 'external-drive-manorama@1.0.0-stable' })
    expect(seen.data).toBe('{"token":"abc"}')
    expect(seen.responseType).toBe('arraybuffer')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('carries the upstream status and headers through untouched', async () => {
    const fetchImpl = capacitorHttpFetch(async () => ({
      status: 401,
      headers: { 'x-pm-error': 'denied' },
      data: '',
    }))
    const response = await fetchImpl('https://drive-api.proton.me/core/v4/urls')
    expect(response.status).toBe(401)
    expect(response.headers.get('x-pm-error')).toBe('denied')
  })

  test('an already-aborted signal rejects before the request is issued', async () => {
    let called = false
    const fetchImpl = capacitorHttpFetch(async () => {
      called = true
      return { status: 200, headers: {}, data: '' }
    })
    const controller = new AbortController()
    controller.abort('gone')
    await expect(fetchImpl('https://drive-api.proton.me/x', { signal: controller.signal })).rejects.toBe('gone')
    expect(called).toBe(false)
  })

  test('a mid-flight abort stops the wait even though native may still finish', async () => {
    const fetchImpl = capacitorHttpFetch(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = fetchImpl('https://drive-api.proton.me/x', { signal: controller.signal })
    controller.abort(new DOMException('Aborted', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

// The SDK and crypto stack must stay behind dynamic imports so they never
// enter the Worker graph (the architecture test scans this, but the pinned
// surface lives here too: a static SDK import would pull megabytes of crypto
// into every test process that touches this module).
describe('proton-client module surface', () => {
  const source = readFileSync(new URL('./proton-client.ts', import.meta.url).pathname, 'utf8')

  test('the drive-sdk is only ever a dynamic import or a type import', () => {
    // A static runtime import (`import { x } from '@protontech/…'`) would
    // bind the crypto graph at module load; `import type` is erased.
    const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)[^;\n]*['"]@protontech/gm)]
    expect(runtimeImports).toEqual([])
    expect(source).toContain("import('@protontech/drive-sdk')")
    expect(source).toContain("import('@protontech/crypto/srp')")
    expect(source).toContain("from '@protontech/drive-sdk'")
  })

  test('stamps the honest third-party appversion identity', () => {
    expect(source).toContain('x-pm-appversion')
    expect(source).toMatch(/external-drive-manorama@/)
  })

  test('the transport is chosen per runtime — native rides CapacitorHttp, a bare browser is refused honestly', () => {
    // drive-api.proton.me answers CORS for drive.proton.me alone, so a
    // plain browser fetch can never succeed — the selector must fail it
    // fast, and Capacitor/core itself must stay a dynamic import.
    expect(source).toContain("import('@capacitor/core')")
    expect(source).toContain('Capacitor.isNativePlatform()')
    expect(source).toContain("typeof window === 'undefined'")
    expect(source).toContain('does not let websites call its API')
    const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)[^;\n]*['"]@capacitor/gm)]
    expect(runtimeImports).toEqual([])
  })
})
