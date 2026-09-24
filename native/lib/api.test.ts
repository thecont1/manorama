import { afterEach, describe, expect, test } from 'bun:test'
import { fetchGallery, NativeGalleryHttpError } from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('native gallery HTTP errors', () => {
  test('preserves the response status for non-OK gallery responses', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Gallery has gone' }), {
      status: 410,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

    const opening = fetchGallery('https://manorama.xyz', 'photographer', 'quiet-light')

    await expect(opening).rejects.toBeInstanceOf(NativeGalleryHttpError)
    await expect(opening).rejects.toMatchObject({ status: 410, message: 'Gallery has gone' })
  })
})
