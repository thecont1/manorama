// Privacy canary suite for encrypted sources — the §L canary gate.
// A failure in this file is a privacy regression, not a flake: do not weaken
// an assertion to get green; fix the code that broke the boundary.
// Expected-red tests are closed by the remediation tasks that name them.
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import { createManoramaApi } from './api'
import renderer from './routes/_renderer'
import viewerPage from './routes/[owner]/[slug]'
import { resetUserStore } from './lib/user-repository'
import { createGallery, getStoredGallery, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { validateEncryptedManifest } from './lib/encrypted-manifest'
import { WebGalleryKeyStore } from './lib/key-store'
import type { GalleryImage } from './lib/imagesource'
import { scanSource } from './lib/sources'
import { PRIVACY_POLICY } from '../packages/core/privacy-policy'
import { encryptedGalleryGate } from '../packages/core/encrypted-source'

const CANARY = 'CANARYKEYabcdefghijkl' // 22 chars, MEGA-shaped
const KEYED_URL = `https://mega.nz/folder/CANARYFOLDER#${CANARY}`
const KEYLESS_URL = 'https://mega.nz/folder/CANARYFOLDER'

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const API = createManoramaApi()
const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}
/** Page app: renderer first, exactly like server.test.ts mounts it. */
const app = new Hono()
app.use(honoxContext)
app.use(renderer)
mountRoute(app, '/:owner/:slug', viewerPage)

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

const image = (over: Partial<GalleryImage> = {}): GalleryImage => ({
  id: 'mega-abcdefghij012345',
  ref: 'NODEHANDLE01',
  filename: 'photo.jpg',
  src: '',
  media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'CANARYFOLDER', nodeId: 'NODEHANDLE01' },
  contentVersion: 'a'.repeat(64),
  fidelity: 'original',
  thumbnailFidelity: 'display-derivative',
  width: 1200,
  height: 800,
  alt: 'photo',
  c2pa: true,
  placeholder: 'data:image/svg+xml,svg',
  ...over,
})

const manifest = (images: GalleryImage[] = [image()]) => ({
  provider: 'mega' as const, sourceUrl: KEYLESS_URL, title: 'Encrypted', images,
})

const cookie = async () => ({ Cookie: await sessionCookieFor(TEST_OWNER.accountId) })

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
})
beforeEach(async () => {
  resetGalleryStore()
})

const enc = async (init: RequestInit = {}): Promise<RequestInit> => ({ ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await cookie()) } })

const seed = async (over: Record<string, unknown>) => createGallery(TEST_OWNER.accountId, {
  slug: 'enc', title: 'Enc', caption: '', date: '', sourceUrl: KEYED_URL, images: [image()], ...over,
} as never)

describe('server never sees a v2 key', () => {
  test('visitor page HTML for a v2 gallery carries no key', async () => {
    await seed({ manifestVersion: 2 })
    const body = await (await app.request('/test-owner/enc', {}, env)).text()
    expect(body).not.toContain(CANARY)
    // The SSR shell may only reach for the placeholder; every real src waits
    // for the client resolver.
    expect(body).not.toContain('/api/mega/')
    expect(body).toContain('frame-ph')
  })

  test('owner page HTML for a retired v2 gallery carries no key', async () => {
    await seed({ manifestVersion: 2, keyRetiredAt: '2026-11-01T00:00:00.000Z', sourceUrl: KEYLESS_URL })
    const body = await (await app.request('/test-owner/enc', await enc(), env)).text()
    expect(body).not.toContain(CANARY)
  })

  test('owner page HTML for an unmigrated legacy gallery does carry the key (named exception)', async () => {
    await seed({
      sourceUrl: KEYED_URL,
      images: [image({ media: undefined, src: `/api/mega/file?node=NODEHANDLE01&k=${CANARY}` })],
    })
    const body = await (await app.request('/test-owner/enc', await enc(), env)).text()
    expect(body).toContain(CANARY)
  })

  test('public manifest endpoint strips the fragment and legacy delivery capabilities', async () => {
    await seed({
      sourceUrl: KEYED_URL,
      images: [
        image({
          media: undefined,
          src: `/api/mega/file?node=NODEHANDLE01&k=${CANARY}`,
          variants: [{ src: `/api/mega/preview?h=FAHANDLE01&k=${CANARY}`, format: 'jpeg', width: 400 }],
        }),
        {
          type: 'video', id: 'mega-video000000000', ref: 'NODEHANDLE02', filename: 'clip.mp4',
          src: `/api/mega/file?node=NODEHANDLE02&k=${CANARY}`, mimeType: 'video/mp4' as const,
          width: 1920, height: 1080, alt: 'clip', c2pa: false as const, placeholder: 'data:image/svg+xml,svg',
          poster: { src: `/api/mega/preview?h=FAHANDLE02&k=${CANARY}`, width: 400, height: 225 },
          variants: [{ src: `/api/mega/preview?h=FAHANDLE02&k=${CANARY}`, format: 'jpeg', width: 400 }],
          sources: [{ src: `/api/mega/file?node=NODEHANDLE02&k=${CANARY}`, mimeType: 'video/mp4' }],
          captions: [{ src: `/api/mega/file?node=CC&k=${CANARY}`, srclang: 'en', label: 'English' }],
        },
      ] as never,
    })
    const payload = await (await API.request('/api/gallery/test-owner/enc', {}, env)).json() as { manifest: { sourceUrl: string; images: unknown[] } }
    expect(payload.manifest.sourceUrl).toBe(KEYLESS_URL)
    const serialized = JSON.stringify(payload.manifest.images)
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain('k=')
    // Identity and the keyless media reference survive; only the keyed
    // delivery URLs are stripped.
    expect(payload.manifest.images[0]).toMatchObject({ id: 'mega-abcdefghij012345', ref: 'NODEHANDLE01' })

    // Control: the named owner exception still returns keyed props to the
    // owner's session until the key retires.
    const ownerPayload = await (await API.request('/api/gallery/test-owner/enc', await enc(), env)).json() as { manifest: { images: unknown[] } }
    expect(JSON.stringify(ownerPayload.manifest.images)).toContain(CANARY)
  })

  test('OG route short-circuits before any media fetch', async () => {
    await seed({ sourceUrl: KEYED_URL })
    const real = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => { called = true; throw new Error('no') }) as typeof fetch
    try {
      const response = await API.request('/api/og/test-owner/enc?i=NODEHANDLE01', {}, env)
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toContain('/og-image.png')
      expect(called).toBe(false)
    } finally { globalThis.fetch = real }
  })

  test('retired media endpoints answer 410 and the scan endpoint demands a client scan', async () => {
    expect((await API.request(`/api/mega/file?folder=F&node=N&k=${CANARY}`, {}, env)).status).toBe(410)
    const scan = await API.request('/api/galleries/scan', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ url: KEYED_URL }),
    }, env)
    expect(scan.status).toBe(422)
    expect(await scan.text()).not.toContain(CANARY)
  })
})

describe('create / refresh / migrate persist only keyless records', () => {
  test('manifest create stores no key in D1', async () => {
    const response = await API.request('/api/galleries', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: manifest() }),
    }, env)
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(CANARY)
    const stored = await getStoredGallery(TEST_OWNER.accountId, 'encrypted')
    expect(JSON.stringify(stored)).not.toContain(CANARY)
  })

  test('a key posted in `url` is refused, not silently scanned', async () => {
    const response = await API.request('/api/galleries', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ url: KEYED_URL }),
    }, env)
    expect(response.status).toBe(422)
  })

  test('refresh with a manifest promotes version and rewrites keyless', async () => {
    await seed({})
    const response = await API.request('/api/galleries/enc/refresh', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: manifest() }),
    }, env)
    expect(response.status).toBe(200)
    const stored = await getStoredGallery(TEST_OWNER.accountId, 'enc')
    expect(stored?.manifestVersion).toBe(2)
    expect(JSON.stringify(stored?.images)).not.toContain(CANARY)
  })

  test('refresh against another album identity is rejected', async () => {
    await seed({})
    const other = { ...manifest([image({ media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'OTHERFOLDER', nodeId: 'NODEHANDLE01' } })]), sourceUrl: 'https://mega.nz/folder/OTHERFOLDER' }
    const response = await API.request('/api/galleries/enc/refresh', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: other }),
    }, env)
    expect(response.status).toBe(400)
  })

  test('migrate keeps the key until a second device, then retires it', async () => {
    await seed({})
    const post = async (deviceId: string) => API.request('/api/galleries/enc/migrate', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: manifest(), deviceId }),
    }, env)
    expect(((await (await post('device-aaaaaaaa')).json()) as { keyRetired: boolean }).keyRetired).toBe(false)
    expect((await getStoredGallery(TEST_OWNER.accountId, 'enc'))?.sourceUrl).toBe(KEYED_URL)
    const second = await (await post('device-bbbbbbbb')).json() as { keyRetired: boolean }
    expect(second.keyRetired).toBe(true)
    const stored = await getStoredGallery(TEST_OWNER.accountId, 'enc')
    expect(stored?.sourceUrl).toBe(KEYLESS_URL)
    expect(stored?.keyRetiredAt).toBeTruthy()
  })

  test('the owner alone receives the legacy capability until retirement', () => {
    const gate = (viewerOwner: boolean, keyRetiredAt: string | null) => encryptedGalleryGate({
      sourceUrl: KEYED_URL, viewerOwner, keyRetiredAt, manifestVersion: 2, legacyServerDecrypt: false,
    })
    // Documented trade: the owner gets `legacySourceUrl` for the migration call,
    // so the key rides the owner's island props (and the hydration payload)
    // until the key is retired. Visitors never receive it.
    expect(gate(true, null).legacySourceUrl).toBe(KEYED_URL)
    expect(gate(false, null).legacySourceUrl).toBeUndefined()
    expect(gate(true, '2026-11-01T00:00:00.000Z').legacySourceUrl).toBeUndefined()
  })

  test('a truncated manifest passed to migrate is refused before the key retires', async () => {
    await seed({ images: [image(), image({ id: 'mega-second0000000', ref: 'NODEHANDLE02', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'CANARYFOLDER', nodeId: 'NODEHANDLE02' } })] })
    const short = { ...manifest([image()]), truncated: 40 }
    const response = await API.request('/api/galleries/enc/migrate', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: short, deviceId: 'device-aaaaaaaa' }),
    }, env)
    expect(response.status).toBe(422)
    expect((await response.json() as { code?: string }).code).toBe('PARTIAL_SCAN')
    const stored = await getStoredGallery(TEST_OWNER.accountId, 'enc')
    expect(stored?.images).toHaveLength(2)
    expect(stored?.keyRetiredAt).toBeNull()
  })

  test('the same device twice does not retire the key', async () => {
    await seed({})
    const post = async () => API.request('/api/galleries/enc/migrate', {
      method: 'POST', ...(await enc({ headers: { 'Content-Type': 'application/json' } })),
      body: JSON.stringify({ manifest: manifest(), deviceId: 'device-aaaaaaaa' }),
    }, env)
    await post()
    const again = await (await post()).json() as { keyRetired: boolean }
    expect(again.keyRetired).toBe(false)
  })
})

describe('manifest validator is a real boundary', () => {
  const rejects = (over: Record<string, unknown>, label: string) => {
    test(`rejects ${label}`, () => {
      expect(() => validateEncryptedManifest({ ...manifest(), ...over })).toThrow()
    })
  }
  rejects({ sourceUrl: KEYED_URL }, 'a keyed sourceUrl')
  rejects({ sourceUrl: `https://mega.nz/folder/CANARYFOLDER?key=${CANARY}` }, 'a key in the query string')
  rejects({ sourceUrl: `https://mega.nz/folder/CANARYFOLDER#` }, 'a trailing empty fragment')
  rejects({ provider: 'ente' }, 'a provider that does not match the URL')
  rejects({ extra: 1 }, 'an unknown top-level field')
  rejects({ images: [] }, 'zero images')
  rejects({ truncated: 0 }, 'a truncation count below the item count')

  test('rejects a key smuggled into the item id or ref', () => {
    expect(() => validateEncryptedManifest({ ...manifest(), images: [image({ id: `mega-${CANARY}` })] })).toThrow()
  })

  test('rejects a media ref pointing at a different node than its ref', () => {
    expect(() => validateEncryptedManifest({
      ...manifest(),
      images: [image({ media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'CANARYFOLDER', nodeId: 'OTHER' } })],
    })).toThrow()
  })

  test('rejects dimensions outside the aspect clamp', () => {
    for (const [w, h] of [[0, 3], [1, 10000], [100001, 3], [4.5, 3]]) {
      expect(() => validateEncryptedManifest({ ...manifest(), images: [image({ width: w, height: h })] })).toThrow()
    }
  })

  test('rejects a bad content-version marker', () => {
    expect(() => validateEncryptedManifest({ ...manifest(), images: [image({ contentVersion: 'abc' })] })).toThrow()
  })
})

describe('web key store is id-scoped so slug reuse cannot inherit a key', () => {
  const memory = (): Storage => {
    const map = new Map<string, string>()
    return {
      get length() { return map.size },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => map.clear(),
    } as Storage
  }

  test('a key stored under an old id is invisible to the new gallery', async () => {
    const store = new WebGalleryKeyStore(memory())
    await store.put('a'.repeat(32), KEYED_URL)
    expect(await store.get('a'.repeat(32))).toBe(KEYED_URL)
    expect(await store.get('b'.repeat(32))).toBeNull()
  })

  test('a keyless URL is refused', async () => {
    const store = new WebGalleryKeyStore(memory())
    await expect(store.put('a'.repeat(32), KEYLESS_URL)).rejects.toThrow()
  })
})

describe('F2/F3 regressions: dev seed and shipped policy wording', () => {
  test('the dev-seed MEGA slot can no longer be scanned server-side', async () => {
    // vite.config.ts seeds MANORAMA_DEV_SOURCE_MEGA through scanSource(), which
    // now always throws for MEGA — the gallery is skipped with a console warning.
    await expect(scanSource(KEYED_URL, {})).rejects.toThrow(/scanned on your device/)
  })

  test('the dev seed scans encrypted sources through the client module, never the server path', () => {
    // Source-level guard: the retired dispatch must not creep back. The
    // behavioral half is the keyed-open Playwright spec.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url).pathname, 'utf8')
    // Encrypted seeds dispatch to the client scanner; the server scanSource
    // only ever sees unencrypted links.
    expect(viteConfig).toContain('ssrLoadModule(\'/app/lib/mega-client.ts\')')
    expect(viteConfig).toContain('scanMegaSource')
    expect(viteConfig).toMatch(/isEncryptedSourceUrl\(url\)\s*\?\s*await clientScan\(url\)\s*:\s*await sources!?\.scanSource/)
    // The seed writes scanned manifests directly — it never posts a keyed
    // url to the retired server scan endpoint.
    expect(viteConfig).not.toContain('/api/galleries/scan')
    // Client-scanned seeds must be stamped v2 or the legacy render gate
    // would route keyless refs through the retired decryptor.
    expect(viteConfig).toContain('manifestVersion: isEncryptedSourceUrl(url) ? 2 : 1')
  })

  test('the shipped policy model describes the fragment, the static card, and the exception', () => {
    const text = JSON.stringify(PRIVACY_POLICY)
    expect(text).toContain('fragment')
    expect(text).toContain('static social preview image')
    expect(text).toContain('second device')
    // The retired preview cache must no longer be described as current.
    expect(text).not.toContain('in-memory cache')
  })

  test('the shipped model and docs/privacy-policy.md cannot drift apart', () => {
    const normalize = (text: string) => text
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '—')
      .replace(/\s+/g, ' ').trim()
    const renderInline = (part: { kind: string; text?: string; label?: string; href?: string }) =>
      part.kind === 'strong' ? `**${part.text}**`
        : part.kind === 'code' ? `\`${part.text}\``
        : part.kind === 'link' ? `[${part.label}](${part.href})`
        : part.text ?? ''
    const modelParagraphs = [
      normalize(PRIVACY_POLICY.lede),
      ...PRIVACY_POLICY.sections.flatMap((section) => [
        ...(section.paragraphs ?? []).map((p) => p.parts),
        ...(section.cards ?? []).map((card) => card.paragraph.parts),
      ].map((parts) => normalize(parts.map(renderInline).join('')))),
    ]

    const docsPath = new URL('../docs/privacy-policy.md', import.meta.url).pathname
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const docsParagraphs = readFileSync(docsPath, 'utf8')
      .split(/\n\s*\n/)
      .map((block) => normalize(block))
      .filter((block) => block && !block.startsWith('#') && !block.startsWith('Last updated'))

    const missing = modelParagraphs.filter((p) => !docsParagraphs.includes(p))
    const extra = docsParagraphs.filter((p) => !modelParagraphs.includes(p))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })
})

describe('F4: the native deep link trusts the fragment over the gallery it names', () => {
  afterEach(() => { mock.restore() })
  const store = () => ({
    cache: async () => ({ status: 'complete' as const, images: 1 }),
    inspect: async () => ({ status: 'missing' as const, images: 0 }),
    open: async () => undefined, invalidate: async () => {},
    listGalleries: async () => [], readThumbnail: async () => undefined,
    gridGallery: async () => undefined, listGridGalleries: async () => [],
    purgeGallery: async () => {}, purgeAll: async () => {},
  })

  test('an #source for a different album is rejected before open or adoption', async () => {
    const opened: string[] = []
    mock.module(new URL('./lib/encrypted-client.ts', import.meta.url).pathname, () => ({
      openEncryptedSource: async (url: string) => {
        opened.push(url)
        return { provider: 'mega', sourceUrl: 'https://mega.nz/folder/OTHERALBUM', title: 'Other', images: [], materialize: async () => { throw new Error('x') }, dispose: () => {} }
      },
    }))
    const { openGalleryNetworkFirst } = await import('../native/lib/offline-gallery')
    const { EncryptedSourceMismatchError } = await import('../native/lib/encrypted-gallery')
    const published = {
      slug: 'enc', title: 'Enc', caption: '', date: '', sourceUrl: 'https://mega.nz/folder/REALALBUM',
      images: [image({ media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'REALALBUM', nodeId: 'NODEHANDLE01' } })],
    }
    // The fragment names OTHERALBUM while the published manifest belongs to
    // REALALBUM — the mismatch must reject before the key is opened or adopted.
    await expect(openGalleryNetworkFirst({
      selection: { owner: 'o', slug: 'enc', galleryId: 'a'.repeat(32), sourceUrl: `https://mega.nz/folder/OTHERALBUM#${CANARY}` },
      fetchOnline: async () => ({ manifest: published as never, settings: {} as never }),
      store: store() as never,
    })).rejects.toBeInstanceOf(EncryptedSourceMismatchError)
    expect(opened).toEqual([])
  })

  test('a matching #source still opens and adopts the key', async () => {
    const opened: string[] = []
    mock.module(new URL('./lib/encrypted-client.ts', import.meta.url).pathname, () => ({
      openEncryptedSource: async (url: string) => {
        opened.push(url)
        return { provider: 'mega', sourceUrl: 'https://mega.nz/folder/REALALBUM', title: 'Real', images: [], materialize: async () => { throw new Error('x') }, dispose: () => {} }
      },
    }))
    const { openGalleryNetworkFirst } = await import('../native/lib/offline-gallery')
    const published = {
      slug: 'enc', title: 'Enc', caption: '', date: '', sourceUrl: 'https://mega.nz/folder/REALALBUM',
      images: [image({ media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'REALALBUM', nodeId: 'NODEHANDLE01' } })],
    }
    const result = await openGalleryNetworkFirst({
      selection: { owner: 'o', slug: 'enc', galleryId: 'a'.repeat(32), sourceUrl: `https://mega.nz/folder/REALALBUM#${CANARY}` },
      fetchOnline: async () => ({ manifest: published as never, settings: {} as never }),
      store: store() as never,
    })
    expect(opened).toEqual([`https://mega.nz/folder/REALALBUM#${CANARY}`])
    result.dispose?.()
  })
})
