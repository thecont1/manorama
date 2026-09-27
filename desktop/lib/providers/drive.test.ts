import { describe, expect, test } from 'bun:test'
import {
  createDriveUploadProvider,
  driveCreateFolderRequest,
  driveFindFolderRequest,
  driveFolderLink,
  drivePermissionRequest,
  driveResumableInitRequest,
  driveSessionUploadRequest,
} from './drive'
import type { UploadAlbum } from './types'

const captureFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { calls, fetcher }
}

describe('drive request shapes', () => {
  test('find-folder queries only folders by name inside drive.file scope', () => {
    const request = driveFindFolderRequest('token', 'manorama')
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(url.searchParams.get('q')).toContain("name = 'manorama'")
    expect(url.searchParams.get('q')).toContain('mimeType')
    expect(url.searchParams.get('q')).toContain('trashed = false')
    expect((request.init.headers as Record<string, string>).Authorization).toBe('Bearer token')
  })

  test('apostrophes in folder names are escaped for the query', () => {
    const request = driveFindFolderRequest('token', "Niamh's")
    const url = new URL(request.url)
    expect(url.searchParams.get('q')).toContain("name = 'Niamh\\'s'")
  })

  test('create-folder posts the mimeFolder metadata', () => {
    const request = driveCreateFolderRequest('token', 'Trip', 'parent-id')
    expect(request.url).toBe('https://www.googleapis.com/drive/v3/files')
    const body = JSON.parse(request.init.body as string)
    expect(body.name).toBe('Trip')
    expect(body.mimeType).toBe('application/vnd.google-apps.folder')
    expect(body.parents).toEqual(['parent-id'])
  })

  test('resumable init carries only name+parents metadata', () => {
    const request = driveResumableInitRequest('token', { name: 'photo.jpg', parents: ['album-id'] })
    expect(request.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')
    expect(request.init.method).toBe('POST')
    const body = JSON.parse(request.init.body as string)
    expect(Object.keys(body).sort()).toEqual(['name', 'parents'])
  })

  test('session PUT sends the untouched bytes', () => {
    const bytes = new Uint8Array([7, 7, 7])
    const request = driveSessionUploadRequest('https://session.example.com/abc', bytes)
    expect(request.url).toBe('https://session.example.com/abc')
    expect(request.init.method).toBe('PUT')
    expect((request.init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream')
    expect(request.init.body).toBe(bytes)
  })

  test('permission request makes the folder anyone-with-link reader', () => {
    const request = drivePermissionRequest('token', 'folder-id')
    expect(request.url).toBe('https://www.googleapis.com/drive/v3/files/folder-id/permissions')
    expect(JSON.parse(request.init.body as string)).toEqual({ role: 'reader', type: 'anyone' })
    expect(driveFolderLink('folder-id')).toBe('https://drive.google.com/drive/folders/folder-id')
  })
})

describe('uploadAlbum', () => {
  const album: UploadAlbum = {
    name: 'Trip',
    files: [{ name: 'one.jpg', path: '/local/root/one.jpg' }],
  }

  test('creates manorama/<album>, resumable-uploads, then publishes the folder link', async () => {
    let sessionN = 0
    let createN = 0
    const calls: { url: string; init?: RequestInit }[] = []
    const counting = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('uploadType=resumable')) {
        sessionN += 1
        return new Response('{}', { status: 200, headers: { Location: `https://upload.example.com/session/${sessionN}` } })
      }
      if (url.startsWith('https://upload.example.com/session/')) return new Response(JSON.stringify({ id: 'file-id' }), { status: 200 })
      if (url.includes('/permissions')) return new Response('{}', { status: 200 })
      if (url.includes('q=')) return new Response(JSON.stringify({ files: [] }), { status: 200 })
      if (url.endsWith('drive/v3/files')) {
        createN += 1
        return new Response(JSON.stringify({ id: `folder-${createN}` }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const provider = createDriveUploadProvider({ fetcher: counting, getToken: async () => 'access-token' })
    const result = await provider.uploadAlbum(album, async () => new Uint8Array([5, 5, 5]))

    // One lookup for the shared root — the album folder is always created
    // fresh — then one resumable init + PUT and one permission grant.
    const kinds = calls.map((call) =>
      call.url.includes('q=') ? 'find'
      : call.url.includes('uploadType=resumable') ? 'init'
      : call.url.startsWith('https://upload.example.com/session/') ? 'put'
      : call.url.includes('/permissions') ? 'perm'
      : 'create',
    )
    expect(kinds).toEqual(['find', 'create', 'create', 'init', 'put', 'perm'])
    const albumCreate = calls.filter((c) => c.url.endsWith('drive/v3/files'))[1]!
    const albumBody = JSON.parse(albumCreate.init!.body as string)
    expect(albumBody.name).toBe('Trip')
    expect(albumBody.parents).toEqual(['folder-1'])
    expect(result.shareUrl).toBe('https://drive.google.com/drive/folders/folder-2')
  })

  test('reuses an existing manorama folder instead of duplicating it', async () => {
    let finds = 0
    const { calls, fetcher } = captureFetch((url) => {
      if (url.includes('q=')) {
        finds += 1
        // manorama exists; the album folder does not.
        return new Response(JSON.stringify({ files: finds === 1 ? [{ id: 'manorama-id' }] : [] }), { status: 200 })
      }
      if (url.endsWith('drive/v3/files')) return new Response(JSON.stringify({ id: 'album-id' }), { status: 200 })
      if (url.includes('uploadType=resumable')) return new Response('{}', { status: 200, headers: { Location: 'https://upload.example.com/s' } })
      if (url.startsWith('https://upload.example.com/')) return new Response('{}', { status: 200 })
      return new Response('{}', { status: 200 })
    })
    const provider = createDriveUploadProvider({ fetcher, getToken: async () => 'access-token' })
    const result = await provider.uploadAlbum(album, async () => new Uint8Array([1]))
    expect(result.shareUrl).toBe('https://drive.google.com/drive/folders/album-id')
    // Only ONE create happened (the album folder under the existing root).
    expect(calls.filter((c) => c.url.endsWith('drive/v3/files') && c.init?.method === 'POST')).toHaveLength(1)
  })

  test('an init failure aborts before the file PUT', async () => {
    const { calls, fetcher } = captureFetch((url) => {
      if (url.includes('q=')) return new Response(JSON.stringify({ files: [{ id: 'f' }] }), { status: 200 })
      if (url.includes('uploadType=resumable')) return new Response('{}', { status: 403 })
      return new Response('{}', { status: 200 })
    })
    const provider = createDriveUploadProvider({ fetcher, getToken: async () => 'access-token' })
    await expect(provider.uploadAlbum(album, async () => new Uint8Array([1]))).rejects.toThrow()
    expect(calls.some((call) => call.url.startsWith('https://upload.example.com/'))).toBe(false)
  })
})
