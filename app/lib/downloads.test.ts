import { describe, expect, test } from 'bun:test'
import { handleDownloads, isDownloadHost, type DownloadsEnv } from './downloads'

const MANIFEST = {
  version: '0.3.0',
  released: '2026-11-12',
  assets: {
    mac: 'v0.3.0/manorama_0.3.0_aarch64.dmg',
    windows: 'v0.3.0/manorama_0.3.0_x64-setup.exe',
    linux: 'v0.3.0/manorama_0.3.0_amd64.AppImage',
    all: ['v0.3.0/manorama_0.3.0_aarch64.dmg'],
  },
}

const fakeObject = (key: string, body: string, contentType = 'application/octet-stream') => ({
  key,
  size: body.length,
  httpEtag: '"etag"',
  body: new Response(body).body!,
  httpMetadata: { contentType },
  writeHttpMetadata(headers: Headers) {
    if (contentType) headers.set('content-type', contentType)
  },
  async json() {
    return JSON.parse(body)
  },
})

const fakeBucket = (objects: Record<string, ReturnType<typeof fakeObject>>) =>
  ({
    get: async (key: string) => objects[key] ?? null,
  }) as unknown as R2Bucket

const envWith = (objects: Record<string, ReturnType<typeof fakeObject>>): DownloadsEnv => ({
  DOWNLOADS: fakeBucket(objects),
})

const req = (path: string, method = 'GET') =>
  new Request(`https://downloads.manorama.xyz${path}`, { method })

describe('isDownloadHost', () => {
  test('matches only the downloads hostname', () => {
    expect(isDownloadHost('downloads.manorama.xyz')).toBe(true)
    expect(isDownloadHost('manorama.xyz')).toBe(false)
    expect(isDownloadHost('downloads.manorama.xyz.evil.com')).toBe(false)
  })
})

describe('handleDownloads', () => {
  const objects = {
    'latest.json': fakeObject('latest.json', JSON.stringify(MANIFEST), 'application/json'),
    'v0.3.0/manorama_0.3.0_aarch64.dmg': fakeObject(
      'v0.3.0/manorama_0.3.0_aarch64.dmg',
      'dmg-bytes',
      'application/x-apple-diskimage',
    ),
  }
  const env = envWith(objects)

  test('503 without the bucket binding', async () => {
    const res = await handleDownloads(req('/mac'), {})
    expect(res.status).toBe(503)
  })

  test('405 on non-GET/HEAD', async () => {
    const res = await handleDownloads(req('/mac', 'POST'), env)
    expect(res.status).toBe(405)
  })

  test('index page lists the current release', async () => {
    const res = await handleDownloads(req('/'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('0.3.0')
    expect(body).toContain('/v0.3.0/manorama_0.3.0_aarch64.dmg')
  })

  test('platform shortcuts redirect to the latest asset', async () => {
    for (const [platform, key] of [
      ['mac', 'v0.3.0/manorama_0.3.0_aarch64.dmg'],
      ['windows', 'v0.3.0/manorama_0.3.0_x64-setup.exe'],
      ['linux', 'v0.3.0/manorama_0.3.0_amd64.AppImage'],
    ] as const) {
      const res = await handleDownloads(req(`/${platform}`), envWith({
        'latest.json': objects['latest.json'],
      }))
      // windows/linux keys are absent from `objects`, but the redirect only
      // needs the manifest — the target 404s on follow, which is fine here.
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`https://downloads.manorama.xyz/${key}`)
    }
  })

  test('serves versioned objects with immutable caching', async () => {
    const res = await handleDownloads(req('/v0.3.0/manorama_0.3.0_aarch64.dmg'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-apple-diskimage')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe('dmg-bytes')
  })

  test('latest.json is short-cached', async () => {
    const res = await handleDownloads(req('/latest.json'), env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await res.json()).toMatchObject({ version: '0.3.0' })
  })

  test('HEAD returns headers without a body', async () => {
    const res = await handleDownloads(req('/v0.3.0/manorama_0.3.0_aarch64.dmg', 'HEAD'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  test('404s unknown objects and non-versioned keys', async () => {
    expect((await handleDownloads(req('/v9.9.9/missing.dmg'), env)).status).toBe(404)
    expect((await handleDownloads(req('/latest'), env)).status).toBe(404)
    expect((await handleDownloads(req('/../../etc/passwd'), env)).status).toBe(404)
  })
})
