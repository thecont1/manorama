import { describe, expect, test } from 'bun:test'
import {
  createDropboxUploadProvider,
  dropboxListSharedLinksRequest,
  dropboxSharedLinkRequest,
  dropboxUploadRequest,
} from './dropbox'
import { DROPBOX_MAX_SINGLE_UPLOAD_BYTES } from './oauth'
import type { UploadAlbum } from './types'

const captureFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { calls, fetcher }
}

describe('dropboxUploadRequest', () => {
  test('posts the untouched bytes with the upload-arg header', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const request = dropboxUploadRequest('token-value', '/manorama/Album/photo.jpg', bytes)
    expect(request.url).toBe('https://content.dropboxapi.com/2/files/upload')
    const headers = request.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-value')
    expect(headers['Content-Type']).toBe('application/octet-stream')
    // The body IS the byte array — same reference, nothing wrapped or re-encoded.
    expect(request.init.body).toBe(bytes)
    const arg = JSON.parse(headers['Dropbox-API-Arg']!)
    expect(arg.path).toBe('/manorama/Album/photo.jpg')
    expect(arg.mode).toBe('add')
    // Documented conflict policy: autorename, never overwrite.
    expect(arg.autorename).toBe(true)
  })
})

describe('dropboxSharedLinkRequest', () => {
  test('asks for a public viewer link on the folder', () => {
    const request = dropboxSharedLinkRequest('token-value', '/manorama/Album')
    expect(request.url).toBe('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings')
    const body = JSON.parse(request.init.body as string)
    expect(body.path).toBe('/manorama/Album')
    expect(body.settings.requested_visibility['.tag']).toBe('public')
    expect(body.settings.access['.tag']).toBe('viewer')
  })

  test('the fallback lists the existing links for the folder only', () => {
    const request = dropboxListSharedLinksRequest('token-value', '/manorama/Album')
    expect(request.url).toBe('https://api.dropboxapi.com/2/sharing/list_shared_links')
    const body = JSON.parse(request.init.body as string)
    expect(body.path).toBe('/manorama/Album')
    expect(body.direct_only).toBe(true)
  })
})

describe('uploadAlbum', () => {
  const album: UploadAlbum = {
    name: 'Trip',
    files: [
      { name: 'one.jpg', path: '/local/root/one.jpg' },
      { name: 'two.jpg', path: '/local/root/sub/two.jpg' },
    ],
  }

  test('uploads each file under /manorama/<album> and returns the folder link', async () => {
    const { calls, fetcher } = captureFetch((url) => {
      if (url.includes('files/upload')) return new Response('{}', { status: 200 })
      if (url.includes('create_shared_link_with_settings')) {
        return new Response(JSON.stringify({ url: 'https://www.dropbox.com/sh/abc/Trip' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const reads: string[] = []
    const provider = createDropboxUploadProvider({ fetcher, getToken: async () => 'access-token' })
    const progress: string[] = []
    const result = await provider.uploadAlbum(
      album,
      async (path) => {
        reads.push(path)
        return new Uint8Array([9, 9])
      },
      (p) => progress.push(`${p.index}/${p.total} ${p.fileName} ${p.bytesSent}/${p.bytesTotal}`),
    )
    expect(result.shareUrl).toBe('https://www.dropbox.com/sh/abc/Trip')
    // Local paths were used ONLY for reading — never sent anywhere.
    expect(reads).toEqual(['/local/root/one.jpg', '/local/root/sub/two.jpg'])
    const uploads = calls.filter((call) => call.url.includes('files/upload'))
    expect(uploads).toHaveLength(2)
    expect(JSON.parse((uploads[0]!.init!.headers as Record<string, string>)['Dropbox-API-Arg']!).path).toBe('/manorama/Trip/one.jpg')
    expect(JSON.parse((uploads[1]!.init!.headers as Record<string, string>)['Dropbox-API-Arg']!).path).toBe('/manorama/Trip/two.jpg')
    // No path segment anywhere in the wire material.
    for (const call of calls) {
      expect(JSON.stringify(call.init?.headers ?? {})).not.toContain('/local')
      expect(call.init?.body ?? '').not.toContain?.('/local')
    }
    expect(progress).toEqual([
      '1/2 one.jpg 0/2', '1/2 one.jpg 2/2',
      '2/2 two.jpg 0/2', '2/2 two.jpg 2/2',
    ])
  })

  test('reuses the existing folder link on shared_link_already_exists', async () => {
    const { calls, fetcher } = captureFetch((url) => {
      if (url.includes('files/upload')) return new Response('{}', { status: 200 })
      if (url.includes('create_shared_link_with_settings')) {
        return new Response(JSON.stringify({ error: { '.tag': 'shared_link_already_exists' } }), { status: 409 })
      }
      if (url.includes('list_shared_links')) {
        return new Response(JSON.stringify({ links: [{ url: 'https://www.dropbox.com/sh/existing/Trip' }] }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const provider = createDropboxUploadProvider({ fetcher, getToken: async () => 'access-token' })
    const result = await provider.uploadAlbum(album, async () => new Uint8Array([1]))
    expect(result.shareUrl).toBe('https://www.dropbox.com/sh/existing/Trip')
    expect(calls.some((call) => call.url.includes('list_shared_links'))).toBe(true)
  })

  test('hard-caps files over the single-upload limit with a named-file error', async () => {
    const { calls, fetcher } = captureFetch(() => new Response('{}', { status: 200 }))
    const provider = createDropboxUploadProvider({ fetcher, getToken: async () => 'access-token' })
    const big = { name: 'huge.jpg', path: '/local/huge.jpg' }
    await expect(
      provider.uploadAlbum(
        { name: 'Trip', files: [big] },
        async () => new Uint8Array(DROPBOX_MAX_SINGLE_UPLOAD_BYTES + 1),
      ),
    ).rejects.toThrow('huge.jpg')
    // Nothing was uploaded — the error lands before the first request.
    expect(calls).toHaveLength(0)
  })

  test('an upload failure aborts without any delete call', async () => {
    const { calls, fetcher } = captureFetch((url) =>
      url.includes('files/upload')
        ? new Response(JSON.stringify({ error_summary: 'insufficient_space/' }), { status: 507 })
        : new Response('{}', { status: 200 }),
    )
    const provider = createDropboxUploadProvider({ fetcher, getToken: async () => 'access-token' })
    await expect(provider.uploadAlbum(album, async () => new Uint8Array([1]))).rejects.toThrow('Dropbox')
    // Exactly the uploads were attempted — no cleanup/delete calls exist.
    expect(calls.every((call) => call.url.includes('files/upload'))).toBe(true)
  })
})
