import { describe, expect, test } from 'bun:test'
import { clearHeicUrlCache, enqueueHeicObjectUrl, heicObjectUrl, isHeicFilename } from './heic'

const globals = globalThis as Record<string, unknown>

describe('isHeicFilename', () => {
  test('matches the .heic/.heif suffix only', () => {
    expect(isHeicFilename('IMG_9728.heic')).toBe(true)
    expect(isHeicFilename('PHOTO.HEIF')).toBe(true)
    expect(isHeicFilename('IMG_3449.jpeg')).toBe(false)
    expect(isHeicFilename('notes.heic.txt')).toBe(false)
    expect(isHeicFilename(undefined)).toBe(false)
    expect(isHeicFilename(null)).toBe(false)
  })
})

describe('heicObjectUrl', () => {
  const withGlobals = async (fn: () => Promise<void>) => {
    const prev = { fetch: globals.fetch, create: URL.createObjectURL }
    try { await fn() } finally {
      globals.fetch = prev.fetch
      URL.createObjectURL = prev.create
      clearHeicUrlCache()
    }
  }

  test('returns null when the fetch fails so the caller can fall back', async () => {
    await withGlobals(async () => {
      globals.fetch = (() => Promise.resolve(new Response('no', { status: 503 }))) as unknown as typeof fetch
      expect(await heicObjectUrl('/api/mega/file?x')).toBeNull()
    })
  })

  test('an empty src never reaches fetch — it would return the page as the "image"', async () => {
    await withGlobals(async () => {
      let fetches = 0
      globals.fetch = (() => { fetches += 1; return Promise.resolve(new Response('<html/>')) }) as unknown as typeof fetch
      expect(await heicObjectUrl('')).toBeNull()
      expect(fetches).toBe(0)
    })
  })

  test('a decoded URL is served from cache — a second surface pays nothing', async () => {
    await withGlobals(async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      let fetches = 0
      globals.fetch = (() => { fetches += 1; return Promise.resolve(new Response(jpeg)) }) as unknown as typeof fetch
      URL.createObjectURL = (() => 'blob:cached') as typeof URL.createObjectURL
      expect(await heicObjectUrl('/api/mega/file?warm')).toBe('blob:cached')
      expect(await heicObjectUrl('/api/mega/file?warm')).toBe('blob:cached')
      expect(fetches).toBe(1)
    })
  })

  test('hands non-HEIC bytes straight back as a blob — the name lied', async () => {
    await withGlobals(async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
      globals.fetch = (() => Promise.resolve(new Response(jpeg))) as unknown as typeof fetch
      const minted: Blob[] = []
      URL.createObjectURL = ((blob: Blob) => { minted.push(blob); return 'blob:mock-1' }) as typeof URL.createObjectURL
      expect(await heicObjectUrl('/api/mega/file?x')).toBe('blob:mock-1')
      expect(new Uint8Array(await minted[0]!.arrayBuffer())).toEqual(jpeg)
    })
  })
})

describe('enqueueHeicObjectUrl', () => {
  test('decodes serially — a rail of HEICs never runs in parallel', async () => {
    const prev = { fetch: globals.fetch, create: URL.createObjectURL }
    try {
      let running = 0
      let peak = 0
      const order: number[] = []
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      globals.fetch = (async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running -= 1
        return new Response(jpeg)
      }) as unknown as typeof fetch
      URL.createObjectURL = (() => 'blob:mock') as typeof URL.createObjectURL
      await Promise.all([0, 1, 2].map((n) => enqueueHeicObjectUrl(`/f${n}`).then((url) => { order.push(n); return url })))
      expect(peak).toBe(1)
      expect(order).toEqual([0, 1, 2])
    } finally {
      // Both stubs must go home — a leaked createObjectURL hands 'blob:mock'
      // to whatever mounts next (happy-dom workers die resolving it). The
      // decode cache goes too: a blob minted under the stub is poison for
      // every later caller of the same source.
      globals.fetch = prev.fetch
      URL.createObjectURL = prev.create
      clearHeicUrlCache()
    }
  })
})
