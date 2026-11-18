import { Capacitor } from '@capacitor/core'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseDeviceGalleryInput, DEVICE_GALLERY_ID_PATTERN } from '../../packages/core/device-gallery'
import { deserializeLocalCatalogue, newCatalogue, serializeLocalCatalogue, type LocalGalleryRecord } from '../../desktop/lib/catalogue'
import { addLocalGallery, loadLocalCatalogue, localGalleryManifest, removeLocalGallery, type LocalCatalogueStore, type LocalGalleryBridge } from './local-gallery'

const TOKEN_KEY = 'capacitor-storage_manorama.session-token'
const DEVICE_ID_KEY = 'capacitor-storage_manorama.device-id.v1'
const DEVICE_ID = '1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b'

const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let storage: Map<string, string>

const installLocalStorage = () => {
  storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size },
      clear: () => storage.clear(),
    },
  })
}

const memoryStore = (initial?: string): { store: LocalCatalogueStore; written: () => string | null } => {
  let contents = initial ?? null
  return {
    store: {
      load: async () => contents,
      save: async (next: string) => { contents = next },
    },
    written: () => contents,
  }
}

const GALLERY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const manifestRecord = (over: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
  id: GALLERY_ID,
  title: 'Kodak moments',
  rootPath: GALLERY_ID,
  sourceKind: 'folder',
  itemCount: 1,
  items: [{ id: 'a.jpg', name: 'a.jpg', path: 'a.jpg', width: 4000, height: 3000 }],
  addedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const imported = (over: Record<string, unknown> = {}) => ({
  galleryId: GALLERY_ID,
  title: 'Kodak moments',
  rootPath: GALLERY_ID,
  items: [
    { id: 'IMG_001.jpg', name: 'IMG_001.jpg', path: 'IMG_001.jpg', width: 4032, height: 3024 },
    { id: 'DCIM/IMG_002.heic', name: 'IMG_002.heic', path: 'DCIM/IMG_002.heic' },
  ],
  ...over,
})

const bridgeStub = (
  result: unknown,
  calls: { options?: { extensions: string[]; maxItems: number }; removed?: string } = {},
  over: Partial<LocalGalleryBridge> = {},
): LocalGalleryBridge => ({
  importFolder: async (options) => {
    calls.options = options
    return result as Awaited<ReturnType<LocalGalleryBridge['importFolder']>>
  },
  removeGallery: async (options) => { calls.removed = options.path },
  exists: async () => ({ exists: true }),
  ...over,
})

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  if (localStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
  } else {
    delete (globalThis as Record<string, unknown>).localStorage
  }
})

describe('the on-device local catalogue', () => {
  test('an absent or corrupt store yields a fresh catalogue keyed to this device', async () => {
    storage.set(DEVICE_ID_KEY, DEVICE_ID)
    const fresh = await loadLocalCatalogue(memoryStore().store)
    expect(fresh.deviceId).toBe(DEVICE_ID)
    expect(fresh.galleries).toHaveLength(0)
    const corrupt = await loadLocalCatalogue(memoryStore('{not json').store)
    expect(corrupt.deviceId).toBe(DEVICE_ID)
    expect(corrupt.galleries).toHaveLength(0)
  })

  test('a cancelled pick writes nothing and reports cancelled', async () => {
    const held = memoryStore()
    const result = await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub({ cancelled: true }),
    })
    expect(result.kind).toBe('cancelled')
    expect(held.written()).toBeNull()
  })

  test('a folder with no showable photographs is refused before it persists', async () => {
    const held = memoryStore()
    const result = await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported({ items: [] })),
    })
    expect(result.kind).toBe('empty')
    expect(held.written()).toBeNull()
  })

  test('the pick is handed the shared format list and the gallery cap', async () => {
    const calls: { options?: { extensions: string[]; maxItems: number } } = {}
    await addLocalGallery('https://api.test', {
      store: memoryStore().store,
      bridge: bridgeStub(imported(), calls),
    })
    expect(calls.options?.maxItems).toBeGreaterThan(0)
    expect(calls.options?.extensions).toContain('.jpg')
    expect(calls.options?.extensions).toContain('.heic')
  })

  test('an added record persists through the shared catalogue codec', async () => {
    storage.set(DEVICE_ID_KEY, DEVICE_ID)
    const held = memoryStore()
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher: async () => new Response('{"galleries":[]}'),
    })
    const parsed = deserializeLocalCatalogue(held.written())
    expect(parsed).not.toBeNull()
    expect(parsed!.deviceId).toBe(DEVICE_ID)
    expect(parsed!.galleries).toHaveLength(1)
    const record = parsed!.galleries[0]
    expect(record.title).toBe('Kodak moments')
    expect(record.sourceKind).toBe('folder')
    expect(record.items).toHaveLength(2)
    expect(record.items[0].width).toBe(4032)
  })

  test('the sync payload carries no path or filename — only the mirror fields', async () => {
    storage.set(TOKEN_KEY, 'session-token')
    storage.set(DEVICE_ID_KEY, DEVICE_ID)
    const requests: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response('{"galleries":[]}', { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await addLocalGallery('https://api.test', {
      store: memoryStore().store,
      bridge: bridgeStub(imported({ truncated: 5 })),
      fetcher,
    })
    const put = requests.find((request) => request.init?.method === 'PUT')
    expect(put).toBeDefined()
    expect(put!.url).toBe('https://api.test/api/device-galleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const body = JSON.parse(String(put!.init!.body))
    expect(parseDeviceGalleryInput(body)).not.toBeNull()
    expect(body).toEqual({
      title: 'Kodak moments',
      sourceKind: 'folder',
      itemCount: 5,
      deviceId: DEVICE_ID,
      hidden: false,
    })
    expect(JSON.stringify(body)).not.toContain('/var/mobile')
    expect(JSON.stringify(body)).not.toContain('IMG_001')
  })

  test('a signed-out add still keeps the gallery on the device', async () => {
    const held = memoryStore()
    const result = await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher: async () => { throw new Error('must not be called') },
    })
    expect(result.kind).toBe('added')
    expect(deserializeLocalCatalogue(held.written())!.galleries).toHaveLength(1)
  })

  test('removing deletes the copied folder, the record, and the mirror row', async () => {
    storage.set(TOKEN_KEY, 'session-token')
    storage.set(DEVICE_ID_KEY, DEVICE_ID)
    const held = memoryStore()
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher: async () => new Response('{"galleries":[]}'),
    })
    const record = deserializeLocalCatalogue(held.written())!.galleries[0]
    const calls: { removed?: string } = {}
    const deletes: string[] = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') deletes.push(String(url))
      return new Response('{}')
    }) as typeof fetch
    await removeLocalGallery('https://api.test', record, {
      store: held.store,
      bridge: bridgeStub({}, calls),
      fetcher,
    })
    expect(calls.removed).toBe(record.rootPath)
    expect(deserializeLocalCatalogue(held.written())!.galleries).toHaveLength(0)
    expect(deletes).toEqual([`https://api.test/api/device-galleries/${record.id}`])
  })

  test('a folder already gone skips native removal but still drops the record', async () => {
    const held = memoryStore()
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher: async () => new Response('{"galleries":[]}'),
    })
    const record = deserializeLocalCatalogue(held.written())!.galleries[0]
    const calls: { removed?: string } = {}
    await removeLocalGallery('https://api.test', record, {
      store: held.store,
      bridge: bridgeStub({}, calls, { exists: async () => ({ exists: false }) }),
      fetcher: async () => new Response('{}'),
    })
    expect(calls.removed).toBeUndefined()
    expect(deserializeLocalCatalogue(held.written())!.galleries).toHaveLength(0)
  })

  test('a removal failure keeps the record so the remove can be retried', async () => {
    const held = memoryStore()
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher: async () => new Response('{"galleries":[]}'),
    })
    const record = deserializeLocalCatalogue(held.written())!.galleries[0]
    await expect(
      removeLocalGallery('https://api.test', record, {
        store: held.store,
        bridge: bridgeStub({}, {}, { removeGallery: async () => { throw new Error('busy') } }),
        fetcher: async () => new Response('{}'),
      }),
    ).rejects.toThrow('busy')
    expect(deserializeLocalCatalogue(held.written())!.galleries).toHaveLength(1)
  })

  test('a corrupt catalogue stops the removal before the folder is touched', async () => {
    // An empty stand-in written over a corrupt file would silently drop
    // every other gallery's record — the strict read must fail loudly and
    // leave both the native copy and the file exactly as they were.
    const held = memoryStore('{not json')
    const calls: { removed?: string; probed?: string } = {}
    await expect(
      removeLocalGallery('https://api.test', manifestRecord(), {
        store: held.store,
        bridge: {
          importFolder: async () => ({}),
          removeGallery: async (options) => { calls.removed = options.path },
          exists: async (options) => { calls.probed = options.path; return { exists: true } },
        },
        fetcher: async () => new Response('{}'),
      }),
    ).rejects.toThrow('could not be parsed')
    expect(calls.probed).toBeUndefined()
    expect(calls.removed).toBeUndefined()
    expect(held.written()).toBe('{not json')
  })

  test('a catalogue read failure (not "missing") propagates without deleting', async () => {
    const calls: { removed?: string } = {}
    await expect(
      removeLocalGallery('https://api.test', manifestRecord(), {
        store: {
          load: async () => { throw new Error('permission denied') },
          save: async () => {},
        },
        bridge: bridgeStub({}, calls),
        fetcher: async () => new Response('{}'),
      }),
    ).rejects.toThrow('permission denied')
    expect(calls.removed).toBeUndefined()
  })

  test('a confirmed-missing catalogue does not block folder removal', async () => {
    storage.set(DEVICE_ID_KEY, DEVICE_ID)
    const held = memoryStore()
    const calls: { removed?: string } = {}
    await removeLocalGallery('https://api.test', manifestRecord(), {
      store: held.store,
      bridge: bridgeStub({}, calls),
      fetcher: async () => new Response('{}'),
    })
    expect(calls.removed).toBe(manifestRecord().rootPath)
    const written = deserializeLocalCatalogue(held.written())
    expect(written).not.toBeNull()
    expect(written!.deviceId).toBe(DEVICE_ID)
    expect(written!.galleries).toHaveLength(0)
  })

  test('removing one record preserves every other record in the catalogue', async () => {
    const held = memoryStore()
    const fetcher = async () => new Response('{"galleries":[]}')
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported()),
      fetcher,
    })
    await addLocalGallery('https://api.test', {
      store: held.store,
      bridge: bridgeStub(imported({ galleryId: 'bbbbcccc-dddd-4eee-8fff-ffffffffffff', title: 'Field card', rootPath: 'bbbbcccc-dddd-4eee-8fff-ffffffffffff' })),
      fetcher,
    })
    const catalogue = deserializeLocalCatalogue(held.written())!
    expect(catalogue.galleries).toHaveLength(2)
    await removeLocalGallery('https://api.test', catalogue.galleries[0], {
      store: held.store,
      bridge: bridgeStub({}, {}),
      fetcher,
    })
    const remaining = deserializeLocalCatalogue(held.written())!.galleries
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('bbbbcccc-dddd-4eee-8fff-ffffffffffff')
  })
})

describe('the local manifest', () => {
  const ROOT_URI = 'file:///var/mobile/Containers/Data/Application/APP/Library/Application%20Support/LocalGalleries'

  const record = (over: Partial<LocalGalleryRecord> = {}): LocalGalleryRecord => ({
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    title: 'Kodak moments',
    rootPath: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sourceKind: 'folder',
    itemCount: 3,
    items: [
      { id: 'a.jpg', name: 'a.jpg', path: 'a.jpg', width: 4000, height: 3000 },
      { id: 'b.jpg', name: 'b.jpg', path: 'b.jpg' },
      { id: 'c.jpg', name: 'c.jpg', path: 'c.jpg' },
    ],
    addedAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-01T00:00:00.000Z',
    ...over,
  })

  test('items project to viewer media through the file scheme, dims intact', () => {
    const manifest = localGalleryManifest(record(), ROOT_URI)
    expect(manifest.slug).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(manifest.title).toBe('Kodak moments')
    expect(manifest.images).toHaveLength(3)
    expect(manifest.images[0].src).toBe(Capacitor.convertFileSrc(`${ROOT_URI}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/a.jpg`))
    expect(manifest.images[0].width).toBe(4000)
    expect(manifest.images[0].height).toBe(3000)
    // Undimensioned items get the guessed box the viewer heals on decode.
    expect(manifest.images[1].width).toBe(1200)
    expect(manifest.images[1].height).toBe(800)
  })

  test('relative paths resolve under the supplied root, so a moved container still serves', () => {
    const moved = 'file:///var/mobile/Containers/Data/Application/NEW/Library/Application%20Support/LocalGalleries/'
    const manifest = localGalleryManifest(record(), moved)
    expect(manifest.images[0].src).toBe(
      Capacitor.convertFileSrc('file:///var/mobile/Containers/Data/Application/NEW/Library/Application%20Support/LocalGalleries/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/a.jpg'))
  })

  test('hidden items stay out of the manifest', () => {
    const manifest = localGalleryManifest(record({ hidden: ['b.jpg'] }), ROOT_URI)
    expect(manifest.images.map((image) => image.id)).toEqual(['a.jpg', 'c.jpg'])
  })

  test('new records mint UUIDs the wire schema accepts', async () => {
    const fresh = await loadLocalCatalogue(memoryStore().store)
    expect(DEVICE_GALLERY_ID_PATTERN.test(fresh.deviceId)).toBe(true)
  })
})
