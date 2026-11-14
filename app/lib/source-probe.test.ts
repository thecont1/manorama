import { describe, expect, test } from 'bun:test'
import { probeDropboxFolder } from './dropbox-public'
import { probeDriveFolder } from './gdrive-public'
import { probeICloudAlbum } from './icloud-shared'
import { probeSource } from './source-probe'
import type { FreshnessItem } from './source-freshness'

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

const item = (filename: string, overrides: Partial<FreshnessItem> = {}): FreshnessItem => ({ filename, ...overrides })

const FOLDER = 'https://www.dropbox.com/scl/fo/1AbCdEf/root?rlkey=0AbCdeF&dl=0'
const DBX = { DROPBOX_APP_KEY: 'k', DROPBOX_APP_SECRET: 's' }
const DRIVE = { GOOGLE_DRIVE_API_KEY: 'key' }

const dbxEntry = (name: string, rev: string) => ({ '.tag': 'file', name, id: `id:${name}`, rev })
const manifest = (entries: [string, string][]) =>
  entries.map(([filename, contentVersion]) => item(filename, { contentVersion }))

const dropboxListing = (entries: unknown[], next?: { cursor: string; has_more: boolean }) =>
  json({ entries, cursor: next?.cursor ?? 'cursor-end', has_more: next?.has_more ?? false })

/** Routes the three Dropbox RPC calls a probe can make; anything else is a
 *  test bug — a probe must never fetch media or per-item data. */
const dropboxFetch = (pages: unknown[][][], fail?: RegExp) => {
  const calls: string[] = []
  let listPage = 0
  const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    calls.push(url)
    if (fail?.test(url)) throw new Error('provider down')
    if (url.includes('list_folder/continue')) return json({ entries: pages[0][++listPage] ?? [], cursor: `c${listPage}`, has_more: listPage < pages[0].length - 1 })
    if (url.includes('list_folder')) return json({ entries: pages[0][0] ?? [], cursor: 'c0', has_more: pages[0].length > 1 })
    return json({}, 404)
  }
  return { calls, fetchImpl: fetchImpl as typeof fetch }
}

describe('probeDropboxFolder', () => {
  test('matching (filename, rev) pairs answer unchanged and ask for no media_info', async () => {
    const { calls, fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1'), dbxEntry('b.jpg', '2')] ]])
    const outcome = await probeDropboxFolder(FOLDER, manifest([['a.jpg', '1'], ['b.jpg', '2']]), DBX, fetchImpl)
    expect(outcome.status).toBe('unchanged')
    const body = JSON.stringify(calls)
    expect(body).not.toContain('include_media_info')
    expect(body).not.toContain('get_thumbnail')
  })

  test('a new file answers changed', async () => {
    const { fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1'), dbxEntry('b.jpg', '2'), dbxEntry('c.jpg', '3')] ]])
    const outcome = await probeDropboxFolder(FOLDER, manifest([['a.jpg', '1'], ['b.jpg', '2']]), DBX, fetchImpl)
    expect(outcome.status).toBe('changed')
  })

  test('a moved rev answers changed', async () => {
    const { fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1'), dbxEntry('b.jpg', '9')] ]])
    const outcome = await probeDropboxFolder(FOLDER, manifest([['a.jpg', '1'], ['b.jpg', '2']]), DBX, fetchImpl)
    expect(outcome.status).toBe('changed')
  })

  test('a manifest without revs answers unknown — never unchanged', async () => {
    const { fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1'), dbxEntry('b.jpg', '2')] ]])
    const outcome = await probeDropboxFolder(FOLDER, [item('a.jpg'), item('b.jpg')], DBX, fetchImpl)
    expect(outcome.status).toBe('unknown')
  })

  test('a provider failure mid-listing answers unknown, not unchanged', async () => {
    const { fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1')] ]], /list_folder/)
    const outcome = await probeDropboxFolder(FOLDER, manifest([['a.jpg', '1']]), DBX, fetchImpl)
    expect(outcome.status).toBe('unknown')
  })

  test('an early outgrown page proves changed without finishing the listing', async () => {
    const { calls, fetchImpl } = dropboxFetch([[ [dbxEntry('a.jpg', '1'), dbxEntry('b.jpg', '2'), dbxEntry('c.jpg', '3')], [dbxEntry('d.jpg', '4')] ]])
    const outcome = await probeDropboxFolder(FOLDER, manifest([['a.jpg', '1'], ['b.jpg', '2']]), DBX, fetchImpl)
    expect(outcome.status).toBe('changed')
    expect(calls.filter((url) => url.includes('list_folder/continue'))).toHaveLength(0)
  })
})

describe('probeDriveFolder', () => {
  const DRIVE_URL = 'https://drive.google.com/drive/folders/1AbCdEf'
  const driveFiles = (files: unknown[]) => json({ files })
  const driveFile = (id: string, extras: Record<string, unknown> = {}) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', ...extras })
  const stored = (entries: [string, string][]) => entries.map(([ref, contentVersion]) => item('x', { ref, contentVersion }))

  test('matching (id, md5Checksum) pairs answer unchanged', async () => {
    const fetchImpl = (async () => driveFiles([
      driveFile('f1', { md5Checksum: 'm1' }), driveFile('f2', { md5Checksum: 'm2' }),
    ])) as typeof fetch
    const outcome = await probeDriveFolder(DRIVE_URL, stored([['f1', 'm1'], ['f2', 'm2']]), DRIVE, fetchImpl)
    expect(outcome.status).toBe('unchanged')
  })

  test('a new Drive file answers changed', async () => {
    const fetchImpl = (async () => driveFiles([
      driveFile('f1', { md5Checksum: 'm1' }), driveFile('f2', { md5Checksum: 'm2' }), driveFile('f3', { md5Checksum: 'm3' }),
    ])) as typeof fetch
    const outcome = await probeDriveFolder(DRIVE_URL, stored([['f1', 'm1'], ['f2', 'm2']]), DRIVE, fetchImpl)
    expect(outcome.status).toBe('changed')
  })

  test('a moved checksum answers changed; non-media files are ignored', async () => {
    const fetchImpl = (async () => driveFiles([
      driveFile('f1', { md5Checksum: 'm1' }), driveFile('f2', { md5Checksum: 'zzz' }),
      { id: 'doc1', name: 'notes.txt', mimeType: 'text/plain' },
    ])) as typeof fetch
    const outcome = await probeDriveFolder(DRIVE_URL, stored([['f1', 'm1'], ['f2', 'm2']]), DRIVE, fetchImpl)
    expect(outcome.status).toBe('changed')
  })

  test('a fetch failure answers unknown', async () => {
    const fetchImpl = (async () => { throw new Error('drive down') }) as typeof fetch
    const outcome = await probeDriveFolder(DRIVE_URL, stored([['f1', 'm1']]), DRIVE, fetchImpl)
    expect(outcome.status).toBe('unknown')
  })
})

describe('probeICloudAlbum (legacy sharedstreams)', () => {
  const ALBUM = 'https://www.icloud.com/sharedalbum/#B0TESTTOKEN'
  const streamPhoto = (guid: string, checksums: string[], caption = '') => ({
    photoGuid: guid,
    caption,
    derivatives: Object.fromEntries(checksums.map((checksum, index) => [`d${index}`, { checksum, width: `${4000 - index}`, height: `${3000 - index}` }])),
  })
  const webstream = (photos: unknown[]) =>
    (async () => json({ streamName: 'Album', photos })) as typeof fetch
  const stored = (entries: [string, string][]) => entries.map(([ref, contentVersion]) => item('x', { ref, contentVersion }))

  test('matching (guid, derivative-set) tokens answer unchanged', async () => {
    const photo = streamPhoto('guid-1', ['aa', 'bb'], 'Sunset')
    const version = 'Sunset|aa,bb'
    const outcome = await probeICloudAlbum(ALBUM, stored([['guid-1', version]]), webstream([photo]))
    expect(outcome.status).toBe('unchanged')
  })

  test('an added photo answers changed', async () => {
    const outcome = await probeICloudAlbum(
      ALBUM,
      stored([['guid-1', 'Sunset|aa,bb']]),
      webstream([streamPhoto('guid-1', ['aa', 'bb'], 'Sunset'), streamPhoto('guid-2', ['cc', 'dd'])]),
    )
    expect(outcome.status).toBe('changed')
  })

  test('a derivative or caption move answers changed', async () => {
    const outcome = await probeICloudAlbum(
      ALBUM,
      stored([['guid-1', 'Sunset|aa,bb']]),
      webstream([streamPhoto('guid-1', ['aa', 'zz'], 'Sunset')]),
    )
    expect(outcome.status).toBe('changed')
    const captioned = await probeICloudAlbum(
      ALBUM,
      stored([['guid-1', 'Sunset|aa,bb']]),
      webstream([streamPhoto('guid-1', ['aa', 'bb'], 'Dusk')]),
    )
    expect(captioned.status).toBe('changed')
  })

  test('a webstream failure answers unknown', async () => {
    const fetchImpl = (async () => { throw new Error('apple down') }) as typeof fetch
    const outcome = await probeICloudAlbum(ALBUM, stored([['guid-1', 'v']]), fetchImpl)
    expect(outcome.status).toBe('unknown')
  })
})

describe('probeSource dispatch', () => {
  const base = { images: [] as FreshnessItem[] }

  test('encrypted sources answer device — the server never sees the key', async () => {
    expect((await probeSource({ ...base, sourceUrl: 'https://mega.nz/folder/abc#key' }, {})).status).toBe('device')
    expect((await probeSource({ ...base, sourceUrl: 'https://drive.proton.me/urls/abc#pass' }, {})).status).toBe('device')
    expect((await probeSource({ ...base, sourceUrl: 'https://albums.ente.io/?t=abc#key' }, {})).status).toBe('device')
  })

  test('a source-less or unrecognized gallery answers skipped', async () => {
    expect((await probeSource({ ...base, sourceUrl: null }, {})).status).toBe('skipped')
    expect((await probeSource({ ...base, sourceUrl: 'https://example.com/photos' }, {})).status).toBe('skipped')
  })
})
