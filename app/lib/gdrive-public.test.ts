import { describe, expect, test } from 'bun:test'
import { extractDriveFolderId, scanDriveFolder } from './gdrive-public'

const env = { GOOGLE_DRIVE_API_KEY: 'test-key' }

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

const listing = (files: unknown[]) => ({
  files,
})

describe('extractDriveFolderId', () => {
  test('pulls the folder ID from each URL spelling', () => {
    expect(extractDriveFolderId('https://drive.google.com/drive/folders/1AbC_-dEf')?.id).toBe('1AbC_-dEf')
    expect(extractDriveFolderId('https://drive.google.com/drive/u/0/folders/1AbC_-dEf?usp=sharing')?.id).toBe('1AbC_-dEf')
    expect(extractDriveFolderId('https://drive.google.com/open?id=1AbC_-dEf')?.id).toBe('1AbC_-dEf')
  })

  test('keeps the resource key from key-bearing links', () => {
    expect(extractDriveFolderId('https://drive.google.com/drive/folders/1AbC_-dEf?resourcekey=0-AbCdeF')?.resourceKey).toBe('0-AbCdeF')
  })

  test('returns null for non-folder Drive URLs', () => {
    expect(extractDriveFolderId('https://drive.google.com/file/d/1AbC/view')).toBeNull()
    expect(extractDriveFolderId('https://docs.google.com/document/d/1AbC/edit')).toBeNull()
  })
})

describe('scanDriveFolder', () => {
  test('maps image files to gallery images keyed by file ID', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files?q=')) {
        return jsonResponse(listing([
          { id: 'file-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { width: 4000, height: 3000 } },
          { id: 'file-2', name: 'IMG_0002.HEIC', mimeType: 'image/heic', imageMediaMetadata: { width: 4032, height: 3024 } },
          { id: 'file-3', name: 'notes.txt', mimeType: 'text/plain' },
          { id: 'file-4', name: 'clip.mp4', mimeType: 'video/mp4' },
        ]))
      }
      if (url.includes('files/1FolderId?fields=name')) return jsonResponse({ name: 'Monsoon 2024' })
      return jsonResponse({}, 404)
    }
    const scan = await scanDriveFolder('https://drive.google.com/drive/folders/1FolderId', env, fetchImpl as typeof fetch)
    expect(scan.sourceUrl).toBe('https://drive.google.com/drive/folders/1FolderId')
    expect(scan.title).toBe('Monsoon 2024')
    expect(scan.images).toHaveLength(2)
    const [jpeg, heic] = scan.images
    expect(jpeg.ref).toBe('file-1')
    expect(jpeg.src).toBe('/api/drive/file?id=file-1')
    expect(jpeg.variants?.[0]?.src).toBe('/api/drive/thumbnail?id=file-1&size=w256')
    expect(jpeg.width).toBe(4000)
    expect(jpeg.c2pa).toBe(true)
    // HEIC displays through the large JPEG thumbnail rendition.
    expect(heic.src).toBe('/api/drive/thumbnail?id=file-2&size=w2048')
  })

  test('serves TIFF files through the JPEG thumbnail rendition, never the original proxy', async () => {
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files?q=')) {
        return jsonResponse(listing([
          { id: 'tiff-1', name: 'scan_01.tiff', mimeType: 'image/tiff', imageMediaMetadata: { width: 6000, height: 4000 } },
        ]))
      }
      if (url.includes('fields=name')) return jsonResponse({ name: 'Scans' })
      return jsonResponse({}, 404)
    }
    const scan = await scanDriveFolder('https://drive.google.com/drive/folders/1FolderId', env, fetchImpl as typeof fetch)
    expect(scan.images[0]!.src).toBe('/api/drive/thumbnail?id=tiff-1&size=w2048')
    expect(scan.images[0]!.src).not.toContain('/api/drive/file')
  })

  test('threads folder and file resource keys through requests and proxy URLs', async () => {
    const requests: { url: string; headers?: HeadersInit }[] = []
    const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input)
      requests.push({ url, headers: init?.headers })
      if (url.includes('files?q=')) {
        return jsonResponse(listing([
          { id: 'file-1', name: 'IMG_0001.jpg', mimeType: 'image/jpeg', resourceKey: '0-FileKey' },
        ]))
      }
      if (url.includes('fields=name')) return jsonResponse({ name: 'Keyed' })
      return jsonResponse({}, 404)
    }
    const scan = await scanDriveFolder('https://drive.google.com/drive/folders/1FolderId?resourcekey=0-FolderKey', env, fetchImpl as typeof fetch)
    expect(scan.sourceUrl).toBe('https://drive.google.com/drive/folders/1FolderId?resourcekey=0-FolderKey')
    expect(scan.images[0]!.src).toBe('/api/drive/file?id=file-1&rk=0-FileKey')
    const listRequest = requests.find((request) => request.url.includes('files?q='))!
    expect(listRequest.url).toContain('includeItemsFromAllDrives=true')
    expect((listRequest.headers as Record<string, string>)['X-Goog-Drive-Resource-Keys']).toBe('1FolderId/0-FolderKey')
    expect(requests.every((request) => request.url.includes('supportsAllDrives=true'))).toBe(true)
  })

  test('paginates through the folder listing', async () => {
    let calls = 0
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('files?q=')) {
        calls += 1
        return calls === 1
          ? jsonResponse({ files: [{ id: 'a', name: 'a.jpg', mimeType: 'image/jpeg' }], nextPageToken: 'page2' })
          : jsonResponse({ files: [{ id: 'b', name: 'b.jpg', mimeType: 'image/jpeg' }] })
      }
      if (url.includes('fields=name')) return jsonResponse({ name: 'Paged' })
      return jsonResponse({}, 404)
    }
    const scan = await scanDriveFolder('https://drive.google.com/drive/folders/1FolderId', env, fetchImpl as typeof fetch)
    expect(calls).toBe(2)
    expect(scan.images.map((image) => image.ref)).toEqual(['a', 'b'])
  })

  test('fails friendly when the folder is not link-shared', async () => {
    const fetchImpl = async () => jsonResponse({ error: { message: 'insufficient permissions' } }, 403)
    await expect(scanDriveFolder('https://drive.google.com/drive/folders/1FolderId', env, fetchImpl as typeof fetch))
      .rejects.toThrow('Anyone with the link')
  })

  test('fails friendly when the folder has no images', async () => {
    const fetchImpl = async () => jsonResponse(listing([{ id: 'x', name: 'doc.pdf', mimeType: 'application/pdf' }]))
    await expect(scanDriveFolder('https://drive.google.com/drive/folders/1FolderId', env, fetchImpl as typeof fetch))
      .rejects.toThrow('No image files')
  })

  test('rejects non-folder links', async () => {
    await expect(scanDriveFolder('https://drive.google.com/file/d/abc/view', env)).rejects.toThrow('folder link')
  })
})
