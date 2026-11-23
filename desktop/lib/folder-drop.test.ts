import { describe, expect, test } from 'bun:test'
import {
  DROP_FOLDER_LIMIT,
  buildLocalRecord,
  candidateCountText,
  coverForCandidate,
  dedupeDroppedPaths,
  defaultSelection,
  existingRootMap,
  findExistingRecord,
  isSelectable,
  normalizeRootPath,
  parentFolderName,
  recordForCandidate,
  scanDroppedFolders,
  selectAllSelection,
  toggleSelection,
  type DroppedFolderCandidate,
} from './folder-drop'
import { deviceGalleryRequest, newCatalogue, type LocalGalleryRecord } from './catalogue'
import { scanLocalDirectory, type LocalScanEntry, type ReadDir } from './local-scan'

const file = (name: string, width?: number, height?: number): LocalScanEntry => ({
  name,
  isDirectory: false,
  isFile: true,
  ...(width ? { width, height: height ?? width } : {}),
})
const dir = (name: string): LocalScanEntry => ({ name, isDirectory: true, isFile: false })

/** A virtual filesystem: map of absolute dir → entries; unknown dirs throw
 *  like a real unreadable folder would. */
const fakeReadDir = (tree: Record<string, LocalScanEntry[]>, calls?: string[]): ReadDir =>
  async (path: string) => {
    calls?.push(path)
    const entries = tree[path]
    if (!entries) throw new Error(`ENOENT: ${path}`)
    return entries
  }

const record = (over: Partial<LocalGalleryRecord>): LocalGalleryRecord => ({
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Existing',
  rootPath: '/photos/existing',
  sourceKind: 'folder',
  itemCount: 2,
  items: [
    { id: 'a.jpg', name: 'a.jpg', path: '/photos/existing/a.jpg', width: 4000, height: 3000 },
    { id: 'b.jpg', name: 'b.jpg', path: '/photos/existing/b.jpg' },
  ],
  addedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('normalizeRootPath / dedupeDroppedPaths', () => {
  test('strips trailing separators and keeps the filesystem root', () => {
    expect(normalizeRootPath('/photos/trip/')).toBe('/photos/trip')
    expect(normalizeRootPath('/photos/trip///')).toBe('/photos/trip')
    expect(normalizeRootPath('/')).toBe('/')
    expect(normalizeRootPath('relative/dir/')).toBe('relative/dir')
  })

  test('de-dupes identical paths after normalization, first-seen order', () => {
    expect(dedupeDroppedPaths(['/a', '/b/', '/a', '/b', '/c/'])).toEqual(['/a', '/b', '/c'])
    expect(dedupeDroppedPaths([])).toEqual([])
  })
})

describe('existingRootMap / findExistingRecord', () => {
  test('matches a dropped path against a stored rootPath ignoring a trailing slash', () => {
    const records = [record({ rootPath: '/photos/existing' })]
    expect(findExistingRecord(records, '/photos/existing/')?.id).toBe(records[0].id)
    expect(findExistingRecord(records, '/photos/other')).toBeNull()
    expect(existingRootMap(records).get('/photos/existing')?.title).toBe('Existing')
  })
})

describe('scanDroppedFolders', () => {
  const tree: Record<string, LocalScanEntry[]> = {
    '/drop/one': [file('a.jpg', 100, 80), file('b.png'), file('notes.txt'), dir('sub')],
    '/drop/one/sub': [file('c.webp', 50, 50)],
    '/drop/two': [dir('DCIM')],
    '/drop/two/DCIM': [file('IMG_1.HEIC', 4032, 3024)],
    '/drop/empty': [file('readme.txt')],
    // '/drop/broken' absent → readDir throws
  }

  test('scans each folder with picker semantics and classifies rows', async () => {
    const candidates = await scanDroppedFolders(['/drop/one', '/drop/two', '/drop/empty', '/drop/broken'], {
      readDir: fakeReadDir(tree),
    })
    expect(candidates.map((c) => c.state)).toEqual(['new', 'new', 'empty', 'unreadable'])
    const one = candidates[0]
    expect(one.title).toBe('one')
    expect(one.itemCount).toBe(3) // a.jpg, b.png, sub/c.webp — notes.txt ignored
    expect(one.items.map((i) => i.id)).toEqual(['a.jpg', 'b.png', 'sub/c.webp'])
    expect(one.items[0].path).toBe('/drop/one/a.jpg')
    const two = candidates[1]
    expect(two.sourceKind).toBe('folder')
    expect(two.items[0].path).toBe('/drop/two/DCIM/IMG_1.HEIC')
    expect(candidates[2].title).toBe('empty')
    expect(candidates[3].title).toBe('broken')
  })

  test('de-dupes input paths before scanning', async () => {
    const calls: string[] = []
    const candidates = await scanDroppedFolders(['/drop/one', '/drop/one/', '/drop/one'], {
      readDir: fakeReadDir(tree, calls),
    })
    expect(candidates).toHaveLength(1)
    expect(calls.filter((c) => c === '/drop/one')).toHaveLength(1)
  })

  test('marks a path already in the catalogue as duplicate without scanning it', async () => {
    const calls: string[] = []
    const existing = record({ rootPath: '/drop/one' })
    const candidates = await scanDroppedFolders(['/drop/one'], {
      readDir: fakeReadDir(tree, calls),
      existing: existingRootMap([existing]),
    })
    expect(candidates[0].state).toBe('duplicate')
    expect(candidates[0].existing?.id).toBe(existing.id)
    expect(candidates[0].itemCount).toBe(existing.itemCount)
    expect(calls).toHaveLength(0) // no filesystem touch for a duplicate
  })

  test('reports progressively through onCandidate in dropped order', async () => {
    const seen: string[] = []
    const candidates = await scanDroppedFolders(['/drop/two', '/drop/one'], {
      readDir: fakeReadDir(tree),
      onCandidate: (c) => seen.push(c.path),
    })
    expect(candidates.map((c) => c.path)).toEqual(['/drop/two', '/drop/one'])
    expect(seen.sort()).toEqual(['/drop/one', '/drop/two'])
  })

  test('caps the scan at DROP_FOLDER_LIMIT and keeps dropped order', async () => {
    const many = Array.from({ length: DROP_FOLDER_LIMIT + 10 }, (_, i) => `/drop/m${i}`)
    const wide: Record<string, LocalScanEntry[]> = {}
    for (const p of many) wide[p] = [file('x.jpg')]
    const candidates = await scanDroppedFolders(many, { readDir: fakeReadDir(wide) })
    expect(candidates).toHaveLength(DROP_FOLDER_LIMIT)
    expect(candidates[0].path).toBe('/drop/m0')
    expect(candidates.at(-1)?.path).toBe(`/drop/m${DROP_FOLDER_LIMIT - 1}`)
  })

  test('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0
    let peak = 0
    const dirs = Array.from({ length: 9 }, (_, i) => `/d${i}`)
    const readDir: ReadDir = async (path) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return [file(`${path.split('/').pop()}.jpg`)]
    }
    const candidates = await scanDroppedFolders(dirs, { readDir, concurrency: 3 })
    expect(candidates).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(3)
  })

  test('keeps the uncapped total when the gallery cap truncates', async () => {
    // MAX_GALLERY_ITEMS is 1000 — build 1001 files at the root.
    const entries = Array.from({ length: 1001 }, (_, i) => file(`f${String(i).padStart(4, '0')}.jpg`))
    const candidates = await scanDroppedFolders(['/huge'], { readDir: fakeReadDir({ '/huge': entries }) })
    expect(candidates[0].state).toBe('new')
    expect(candidates[0].items).toHaveLength(1000)
    expect(candidates[0].truncated).toBe(1001)
    expect(candidates[0].itemCount).toBe(1001)
    expect(candidateCountText(candidates[0])).toContain('of')
  })
})

describe('selection', () => {
  const mk = (state: DroppedFolderCandidate['state'], path = `/${state}`): DroppedFolderCandidate => ({
    path,
    title: path,
    sourceKind: 'folder',
    items: state === 'new' ? [{ id: 'x.jpg', name: 'x.jpg', path: `${path}/x.jpg` }] : [],
    itemCount: state === 'new' ? 1 : 0,
    state,
  })

  test('only new rows are selectable and all start selected', () => {
    const candidates = [mk('new', '/a'), mk('duplicate', '/b'), mk('empty', '/c'), mk('unreadable', '/d'), mk('new', '/e')]
    expect(candidates.map(isSelectable)).toEqual([true, false, false, false, true])
    expect([...defaultSelection(candidates)].sort()).toEqual(['/a', '/e'])
  })

  test('toggles a selectable row and refuses a disabled one', () => {
    const a = mk('new', '/a')
    const b = mk('duplicate', '/b')
    let sel = defaultSelection([a, b])
    sel = toggleSelection(sel, a)
    expect(sel.has('/a')).toBe(false)
    sel = toggleSelection(sel, b) // no-op
    expect(sel.size).toBe(0)
    sel = toggleSelection(sel, a)
    expect(sel.has('/a')).toBe(true)
  })

  test('select all / none covers only selectable rows', () => {
    const candidates = [mk('new', '/a'), mk('empty', '/c'), mk('new', '/e')]
    expect([...selectAllSelection(candidates, true)].sort()).toEqual(['/a', '/e'])
    expect(selectAllSelection(candidates, false).size).toBe(0)
  })
})

describe('buildLocalRecord / recordForCandidate', () => {
  test('produces the same record shape addFolder persisted', async () => {
    const scan = await scanLocalDirectory('/drop/one', fakeReadDir({
      '/drop/one': [file('a.jpg', 1920, 1080), dir('sub')],
      '/drop/one/sub': [file('b.png')],
    }))
    const built = buildLocalRecord('/drop/one/', scan, '2026-02-02T00:00:00.000Z')
    expect(built.rootPath).toBe('/drop/one') // normalized
    expect(built.title).toBe('one')
    expect(built.sourceKind).toBe('folder')
    expect(built.itemCount).toBe(2)
    expect(built.items).toHaveLength(2)
    expect(built.addedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(built.lastSeenAt).toBe(built.addedAt)
    expect(built.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('marks a card volume as sourceKind card with mountPoint', async () => {
    const scan = await scanLocalDirectory('/Volumes/CARD/DCIM', fakeReadDir({
      '/Volumes/CARD/DCIM': [file('IMG_1.HEIC')],
    }))
    const built = buildLocalRecord('/Volumes/CARD/DCIM', scan, '2026-02-02T00:00:00.000Z')
    expect(built.sourceKind).toBe('card')
    expect(built.mountPoint).toBe('/Volumes/CARD')
  })

  test('rebuilds a record from a scanned candidate without rescanning', async () => {
    const calls: string[] = []
    const [candidate] = await scanDroppedFolders(['/drop/one'], {
      readDir: fakeReadDir({ '/drop/one': [file('a.jpg')] }, calls),
    })
    const built = recordForCandidate(candidate, '2026-03-03T00:00:00.000Z')
    expect(built.rootPath).toBe('/drop/one')
    expect(built.items).toHaveLength(1)
    expect(built.itemCount).toBe(1)
    expect(calls).toHaveLength(1) // the candidate scan only — no second pass
  })

  test('a drop-built record syncs with no path material on the wire', async () => {
    const [candidate] = await scanDroppedFolders(['/private/dropped'], {
      readDir: fakeReadDir({
        '/private/dropped': [file('secret-name.jpg', 100, 80), file('other.png')],
      }),
    })
    const built = recordForCandidate(candidate, '2026-03-03T00:00:00.000Z')
    const catalogue = { ...newCatalogue('fd4152db-7d7f-462d-80d6-033e82e60049', 'This Mac'), galleries: [built] }
    const request = deviceGalleryRequest('https://manorama.xyz/', built, catalogue)
    expect(request.body).toEqual({
      title: 'dropped',
      sourceKind: 'folder',
      itemCount: 2,
      deviceId: 'fd4152db-7d7f-462d-80d6-033e82e60049',
      hidden: false,
    })
    const wire = JSON.stringify(request.body)
    expect(wire).not.toContain('/private/dropped')
    expect(wire).not.toContain('secret-name.jpg')
    expect(wire).not.toContain('other.png')
  })
})

describe('row presentation helpers', () => {
  test('coverForCandidate previews the cover the card will wear', async () => {
    const existing = record({
      rootPath: '/drop/existing',
      hidden: ['b.jpg'], // first item concealed → cover is a.jpg? hidden b → visible[0] is a.jpg
    })
    const [dup] = await scanDroppedFolders(['/drop/existing'], {
      readDir: fakeReadDir({}),
      existing: existingRootMap([existing]),
    })
    expect(coverForCandidate(dup)?.id).toBe('a.jpg')

    const [fresh] = await scanDroppedFolders(['/drop/fresh'], {
      readDir: fakeReadDir({ '/drop/fresh': [file('first.jpg'), file('second.jpg')] }),
    })
    expect(coverForCandidate(fresh)?.id).toBe('first.jpg')
  })

  test('candidateCountText formats singular, plural and truncated counts', async () => {
    const one = (await scanDroppedFolders(['/p'], { readDir: fakeReadDir({ '/p': [file('a.jpg')] }) }))[0]
    expect(candidateCountText(one)).toBe('1 photograph')
    const many = (await scanDroppedFolders(['/p'], { readDir: fakeReadDir({ '/p': [file('a.jpg'), file('b.jpg'), file('c.jpg')] }) }))[0]
    expect(candidateCountText(many)).toBe('3 photographs')
    const dup = (await scanDroppedFolders(['/p'], {
      readDir: fakeReadDir({}),
      existing: existingRootMap([record({ rootPath: '/p', itemCount: 7 })]),
    }))[0]
    expect(candidateCountText(dup)).toBe('7 photographs')
  })

  test('parentFolderName names the containing folder like Finder does', () => {
    expect(parentFolderName('/Users/home/Pictures/Trip')).toBe('Pictures')
    expect(parentFolderName('/Volumes/CARD/DCIM/100CANON')).toBe('DCIM')
    expect(parentFolderName('/Trip')).toBeUndefined()
    expect(parentFolderName('/')).toBeUndefined()
  })
})
