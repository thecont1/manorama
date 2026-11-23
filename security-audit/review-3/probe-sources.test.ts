/**
 * Provider-URL canonicalisation probes.
 *
 * Every server-side provider fetch is driven by a URL an owner pasted, so the
 * question is which URLs can steer the Worker at all, and what host it ends up
 * talking to. Each scanner takes an injected fetch, so these are deterministic
 * and offline: no provider is contacted.
 */
import { describe, expect, test } from 'bun:test'
import { scanDriveFolder } from '../../app/lib/gdrive-public'
import { fetchGPhotosImage, scanGPhotosAlbum } from '../../app/lib/gphotos-shared'
import { scanDropboxFolder } from '../../app/lib/dropbox-public'

const DROPBOX_ENV = { DROPBOX_APP_KEY: 'synthetic-key', DROPBOX_APP_SECRET: 'synthetic-secret' }

type Call = { url: string; init?: RequestInit }

const recorder = (respond: (url: string) => Response) => {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return respond(url)
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** One Dropbox folder listing with a single JPEG, enough for a scan. */
const dropboxResponder = (url: string): Response => {
  if (url.includes('files/list_folder')) {
    return Response.json({ entries: [{ '.tag': 'file', name: 'a.jpg', id: 'id:abc', rev: 'r1', media_info: { metadata: { dimensions: { width: 1200, height: 800 } } } }], cursor: 'c', has_more: false })
  }
  if (url.includes('sharing/get_shared_link_metadata')) return Response.json({ name: 'Album' })
  return new Response('nope', { status: 500 })
}

describe('Dropbox source URL', () => {
  const scan = async (input: string) => {
    const { calls, impl } = recorder(dropboxResponder)
    const result = await scanDropboxFolder(input, DROPBOX_ENV, impl)
    return { result, calls }
  }

  test('a share link reaches only the Dropbox API hosts', async () => {
    const { calls } = await scan('https://www.dropbox.com/scl/fo/abc123?rlkey=secret&dl=0')
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(new URL(call.url).hostname).toBe('api.dropboxapi.com')
    // The rlkey travels as JSON to Dropbox, never as a host or path segment.
    expect(String(calls[0]?.init?.body)).toContain('"url":"https://www.dropbox.com/scl/fo/abc123?rlkey=secret&dl=0"')
  })

  test('a lookalike host is refused before any fetch', async () => {
    for (const input of [
      'https://dropbox.com.evil.example/scl/fo/abc123',
      'https://www.dropbox.com@evil.example/scl/fo/abc123',
      'https://evil.example/scl/fo/abc123',
    ]) {
      const { calls, impl } = recorder(dropboxResponder)
      await expect(scanDropboxFolder(input, DROPBOX_ENV, impl)).rejects.toThrow('Use a public Dropbox folder link')
      expect(calls).toHaveLength(0)
    }
  })

  test('a Dropbox file link (not a folder share) is refused', async () => {
    const { calls, impl } = recorder(dropboxResponder)
    await expect(scanDropboxFolder('https://www.dropbox.com/s/abc123/a.jpg?dl=0', DROPBOX_ENV, impl)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('the scheme is not part of the host decision — an http share link still scans', async () => {
    const { calls } = await scan('http://www.dropbox.com/scl/fo/abc123?rlkey=k')
    expect(calls.length).toBeGreaterThan(0)
    // Dropbox itself is handed the http URL; nothing of ours is downgraded.
    expect(String(calls[0]?.init?.body)).toContain('http://www.dropbox.com/scl/fo/abc123?rlkey=k')
  })
})

describe('Google Drive source URL', () => {
  test('only drive.google.com is accepted, and the API is the only host fetched', async () => {
    const { calls, impl } = recorder(() => Response.json({ files: [] }))
    // No files → the scan throws "No image files were found", but the fetch
    // already proves which host answered.
    await expect(scanDriveFolder('https://drive.google.com/drive/folders/FOLDER_ID', { GOOGLE_DRIVE_API_KEY: 'k' }, impl)).rejects.toThrow()
    expect(calls.every((call) => new URL(call.url).hostname === 'www.googleapis.com')).toBe(true)
  })

  test('a lookalike Drive host never reaches fetch', async () => {
    const { calls, impl } = recorder(() => Response.json({ files: [] }))
    await expect(scanDriveFolder('https://drive.google.com.evil.example/drive/folders/F', { GOOGLE_DRIVE_API_KEY: 'k' }, impl))
      .rejects.toThrow('Use a public Google Drive folder link')
    expect(calls).toHaveLength(0)
  })
})

describe('Google Photos rendition proxy (`?u=`)', () => {
  const fetchFor = (u: string, r = 'w256') => {
    const { calls, impl } = recorder(() => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    return { calls, run: () => fetchGPhotosImage(u, r, impl) }
  }

  test('an lh3 URL is fetched with its query, hash and rendition replaced', async () => {
    const { calls, run } = fetchFor('https://lh3.googleusercontent.com/p/ABC=w1000-h1000?authuser=1#frag')
    await run()
    expect(calls[0]?.url).toBe('https://lh3.googleusercontent.com/p/ABC=w256')
  })

  test('a lookalike or userinfo host is refused', async () => {
    for (const u of [
      'https://lh3.googleusercontent.com.evil.example/p/ABC',
      'https://lh3.googleusercontent.com@evil.example/p/ABC',
      'http://lh3.googleusercontent.com/p/ABC',
      'https://evil.example/p/ABC',
    ]) {
      const { calls, run } = fetchFor(u)
      await expect(run()).rejects.toThrow('That Google Photos image reference is invalid')
      expect(calls).toHaveLength(0)
    }
  })

  test('a rendition outside the allowlist is refused', async () => {
    const { calls, run } = fetchFor('https://lh3.googleusercontent.com/p/ABC', 'w256&x=1')
    await expect(run()).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe('Google Photos album scan', () => {
  test('a non-share page is refused without a fetch', async () => {
    const { calls, impl } = recorder(() => new Response('', { status: 200 }))
    await expect(scanGPhotosAlbum('https://photos.google.com/u/0/', impl)).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
