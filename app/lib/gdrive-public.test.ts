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
    expect(extractDriveFolderId('https://drive.google.com/drive/folders/1AbC_-dEf')).toBe('1AbC_-dEf')
    expect(extractDriveFolderId('https://drive.google.com/drive/u/0/folders/1AbC_-dEf?usp=sharing')).toBe('1AbC_-dEf')
    expect(extractDriveFolderId('https://drive.google.com/open?id=1AbC_-dEf')).toBe('1AbC_-dEf')
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
