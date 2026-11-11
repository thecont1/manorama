import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { capacitorHttpFetch, extractProtonLink, openProtonSession } from './proton-client'

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

// A session-level fixture: the SDK stays mocked so materialize and the scan
// are exercised without crypto or network. The stub answers a share whose
// `with-thumb` node carries a Type1 thumbnail and whose `no-thumb` node
// carries none — the split that decided whether a rail cell filled.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const THUMB_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 5, 6])

const sessionNode = (uid: string, thumbnails: { uid: string; type: number }[]) => ({
  uid,
  type: 'file',
  mediaType: 'image/jpeg',
  name: { ok: true, value: `${uid}.jpg` },
  modificationTime: new Date('2026-01-01T00:00:00.000Z'),
  activeRevision: {
    uid: `rev-${uid}`,
    claimedSize: JPEG_BYTES.byteLength,
    claimedAdditionalMetadata: { Media: { Width: 4000, Height: 3000 } },
    thumbnails,
  },
})
const sessionNodes = new Map([
  ['with-thumb', sessionNode('with-thumb', [{ uid: 'thumb-1', type: 1 }])],
  ['no-thumb', sessionNode('no-thumb', [])],
])
const protonSessionStub = {
  getRootNode: async () => ({ uid: 'root', type: 'folder', name: { ok: true, value: 'album' } }),
  iterateFolderChildrenNodeUids: async function* () { yield* sessionNodes.keys() },
  iterateNodes: async function* (uids: string[]) { for (const uid of uids) yield sessionNodes.get(uid) },
  getNode: async (uid: string) => sessionNodes.get(uid),
  iterateThumbnails: async function* (uids: string[], type: number) {
    for (const uid of uids) {
      if (uid === 'with-thumb' && type === 1) yield { nodeUid: uid, ok: true, thumbnail: THUMB_BYTES }
      else yield { nodeUid: uid, ok: false, error: 'This item has no image preview' }
    }
  },
  getFileDownloader: async () => ({
    getSeekableStream: () => ({ read: async () => ({ value: JPEG_BYTES }) }),
    downloadToStream: (stream: WritableStream<Uint8Array>) => ({
      completion: async () => {
        const writer = stream.getWriter()
        await writer.write(JPEG_BYTES)
        await writer.close()
      },
    }),
  }),
}

mock.module('@protontech/drive-sdk', () => ({
  ProtonDriveClient: class {
    experimental = {
      getURLAccessInfo: async () => ({ isLegacy: false, isCustomPasswordProtected: false }),
      authURLAccess: async () => protonSessionStub,
    }
  },
  OpenPGPCryptoWithCryptoProxy: class {},
  MemoryCache: class {},
  NodeType: { File: 'file', Folder: 'folder' },
  ThumbnailType: { Type1: 1, Type2: 2 },
}))
mock.module('@protontech/crypto/proxy/endpoint/api.ts', () => ({ Api: class { static init() {} } }))
mock.module('@protontech/crypto', () => ({ CryptoProxy: { setEndpoint() {} } }))
mock.module('@protontech/crypto/srp', () => ({
  getSrp: async () => ({}),
  computeKeyPassword: async () => '',
  generateKeySalt: () => 'x',
}))

// mock.module is process-global — restore the real SDK bindings when the
// suite ends so a sibling file never sees these stubs.
afterAll(() => {
  mock.restore()
})

describe('a Proton session over a stubbed SDK', () => {
  const openSession = () =>
    openProtonSession('https://drive.proton.me/urls/AbCdEf12_Gh#secretpassword', (() => Promise.resolve(new Response())) as typeof fetch)

  test('only a node that carries thumbnails advertises a rail variant', async () => {
    const session = await openSession()
    const { images } = await session.scan
    const withThumb = images.find((image) => image.filename === 'with-thumb.jpg')!
    const noThumb = images.find((image) => image.filename === 'no-thumb.jpg')!
    expect(withThumb.variants).toHaveLength(1)
    expect(noThumb.variants).toBeUndefined()
  })

  test('the listing pass stays idle until scan is first awaited', async () => {
    // A viewer-only open materializes off the authed session alone — the
    // folder walk and dims probes must not fire until a manifest submitter
    // awaits `scan` (a parked probe batch must never starve viewer media).
    // The spy goes up before the open so a walk fired during session-open
    // would be caught too.
    let listed = false
    const original = protonSessionStub.getRootNode
    protonSessionStub.getRootNode = async () => { listed = true; return original() }
    try {
      const session = await openSession()
      await session.materialize('with-thumb', true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(listed).toBe(false)
      await session.scan
      expect(listed).toBe(true)
    } finally {
      protonSessionStub.getRootNode = original
    }
  })

  test('a generated thumbnail materializes as the preview', async () => {
    const session = await openSession()
    const preview = await session.materialize('with-thumb', true)
    expect([...preview.bytes]).toEqual([...THUMB_BYTES])
    expect(preview.mimeType).toBe('image/jpeg')
  })

  test('a preview acquire on a thumbnail-less node falls back to the original', async () => {
    const session = await openSession()
    // Manifests written before variants became conditional still point the
    // rail here — the cell must fill with the original, not stay blank.
    const preview = await session.materialize('no-thumb', true)
    expect([...preview.bytes]).toEqual([...JPEG_BYTES])
    expect(preview.mimeType).toBe('image/jpeg')
  })
})
