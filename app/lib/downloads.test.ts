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

const HISTORY = {
  generated: '2026-11-14',
  repo: 'https://github.com/thecont1/manorama',
  releases: [
    {
      version: '0.3.0',
      tag: 'v0.3.0',
      date: '2026-11-12',
      commits: 154,
      highlights: [
        { sha: 'abc1234', subject: 'feat(viewer): add the curtain', url: 'https://github.com/thecont1/manorama/commit/abc1234' },
      ],
    },
    { version: '0.2.5', tag: 'v0.2.5', date: '2026-11-06', commits: 426, highlights: [] },
  ],
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
    list: async ({ prefix = '', delimiter }: { prefix?: string; delimiter?: string } = {}) => {
      const keys = Object.keys(objects).filter((key) => key.startsWith(prefix))
      if (delimiter) {
        const prefixes = new Set<string>()
        const direct: unknown[] = []
        for (const key of keys) {
          const rest = key.slice(prefix.length)
          const cut = rest.indexOf(delimiter)
          if (cut === -1) direct.push(objects[key])
          else prefixes.add(`${prefix}${rest.slice(0, cut + 1)}`)
        }
        return { objects: direct, delimitedPrefixes: [...prefixes], truncated: false }
      }
      return {
        objects: keys.map((key) => ({ ...objects[key], uploaded: new Date('2026-11-14T00:00:00Z') })),
        truncated: false,
      }
    },
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

  test('index page keeps the full release history, newest first', async () => {
    const env = envWith({
      'latest.json': objects['latest.json'],
      'history.json': fakeObject('history.json', JSON.stringify(HISTORY), 'application/json'),
      'v0.3.0/manorama_0.3.0_aarch64.dmg': objects['v0.3.0/manorama_0.3.0_aarch64.dmg'],
      'v0.3.0/manorama_0.3.0_x64-setup.exe': fakeObject('v0.3.0/manorama_0.3.0_x64-setup.exe', 'exe', 'application/octet-stream'),
      'v0.2.5/manorama_0.2.5_aarch64.dmg': fakeObject('v0.2.5/manorama_0.2.5_aarch64.dmg', 'old-dmg', 'application/x-apple-diskimage'),
    })
    const body = await (await handleDownloads(req('/'), env)).text()
    expect(body).toContain('Release history')
    expect(body.indexOf('v0.3.0')).toBeLessThan(body.indexOf('v0.2.5'))
    expect(body).toContain('/v0.2.5/manorama_0.2.5_aarch64.dmg')
    expect(body).toContain('latest')
  })

  test('history notes render commits and highlight links', async () => {
    const env = envWith({
      'latest.json': objects['latest.json'],
      'history.json': fakeObject('history.json', JSON.stringify(HISTORY), 'application/json'),
      'v0.3.0/manorama_0.3.0_aarch64.dmg': objects['v0.3.0/manorama_0.3.0_aarch64.dmg'],
    })
    const body = await (await handleDownloads(req('/'), env)).text()
    expect(body).toContain('154 commits')
    expect(body).toContain('feat(viewer): add the curtain')
    expect(body).toContain('https://github.com/thecont1/manorama/commit/abc1234')
  })

  test('a version page lists that release\'s assets and notes', async () => {
    const env = envWith({
      'latest.json': objects['latest.json'],
      'history.json': fakeObject('history.json', JSON.stringify(HISTORY), 'application/json'),
      'v0.3.0/manorama_0.3.0_aarch64.dmg': objects['v0.3.0/manorama_0.3.0_aarch64.dmg'],
      'v0.2.5/manorama_0.2.5_aarch64.dmg': fakeObject('v0.2.5/manorama_0.2.5_aarch64.dmg', 'old-dmg', 'application/x-apple-diskimage'),
    })
    const res = await handleDownloads(req('/v0.2.5'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('manorama_0.2.5_aarch64.dmg')
    expect(body).toContain('426 commits')
    expect(body).not.toContain('manorama_0.3.0_aarch64.dmg')
    expect((await handleDownloads(req('/v9.9.9'), env)).status).toBe(404)
  })

  test('the page carries the homepage chrome', async () => {
    const body = await (await handleDownloads(req('/'), env)).text()
    expect(body).toContain('https://manorama.xyz/manorama-merged-logo.png')
    expect(body).toContain('https://manorama.xyz/privacy')
    expect(body).toContain('data-theme-toggle')
    expect(body).toContain('manorama:theme')
    expect(body).toContain('Start free')
  })

  test('page assets serve short-cached and manifests stay public', async () => {
    const env = envWith({
      'assets/fonts/Manrope-variable.ttf': fakeObject('assets/fonts/Manrope-variable.ttf', 'font', 'font/ttf'),
      'history.json': fakeObject('history.json', JSON.stringify(HISTORY), 'application/json'),
    })
    const font = await handleDownloads(req('/assets/fonts/Manrope-variable.ttf'), env)
    expect(font.status).toBe(200)
    expect(font.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await font.text()).toBe('font')
    const history = await handleDownloads(req('/history.json'), env)
    expect(history.status).toBe(200)
    expect(history.headers.get('cache-control')).toBe('public, max-age=300')
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

  test('a mobile-only manifest renders without desktop assets', async () => {
    // The Android pipeline can publish mobile.android before any desktop
    // release exists — latest.json then has no version/assets at all.
    const mobileOnly = {
      mobile: { android: { version: '1.0', url: 'https://downloads.manorama.xyz/v1.0/manorama_1.0_android.apk' } },
    }
    const mobileEnv = envWith({
      'latest.json': fakeObject('latest.json', JSON.stringify(mobileOnly), 'application/json'),
    })
    const res = await handleDownloads(req('/'), mobileEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('vundefined')
    expect(body).toContain('>Download for Android</a>')
    expect(body).toContain('Android · v1.0')
    expect(body).toContain('iPhone &amp; iPad — coming soon')
    expect((await handleDownloads(req('/mac'), mobileEnv)).status).toBe(404)
    const android = await handleDownloads(req('/android'), mobileEnv)
    expect(android.status).toBe(302)
    expect(android.headers.get('location')).toBe('https://downloads.manorama.xyz/v1.0/manorama_1.0_android.apk')
  })

  test('the header links Home instead of repeating the downloads menu', async () => {
    const res = await handleDownloads(req('/'), envWith({}))
    const body = await res.text()
    expect(body).toContain('href="https://manorama.xyz/?home=1">Home</a>')
    // Home leads the nav, ahead of the homepage section anchors.
    expect(body.indexOf('>Home</a>')).toBeLessThan(body.indexOf('manorama.xyz/?home=1#unify'))
    expect(body).not.toContain('home-downloads-trigger')
    expect(body).not.toContain('Get the app')
  })

  test('the theme toggle shares its choice through a .manorama.xyz cookie', async () => {
    const res = await handleDownloads(req('/'), envWith({}))
    const body = await res.text()
    expect(body).toContain('manorama-theme=(light|dark)')
    expect(body).toContain('domain=.manorama.xyz')
    // Icon parity with the homepage: dark shows the sun, light the moon.
    expect(body).toContain('html.light .home-theme-moon{display:block}')
    expect(body).toContain('html.light .home-theme-sun{display:none}')
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
