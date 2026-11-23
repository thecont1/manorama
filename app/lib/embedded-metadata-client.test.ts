import { afterEach, describe, expect, test } from 'bun:test'
import { fetchRangeReader } from './embedded-metadata-client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill)

describe('fetchRangeReader', () => {
  test('206 returns the range body as-is and sends the Range header', async () => {
    const seen: { url: string; range: string | null }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), range: new Headers(init?.headers).get('range') })
      return new Response(bytes(10, 0x62), { status: 206 })
    }) as typeof fetch
    const read = fetchRangeReader('https://example.test/photo.jpg')
    const out = await read(100, 10)
    expect(out.length).toBe(10)
    expect(out[0]).toBe(0x62)
    expect(seen[0]?.range).toBe('bytes=100-109')
  })

  test('a 200 (Range ignored) skips to start and cancels after the window', async () => {
    const file = bytes(1000)
    for (let i = 0; i < file.length; i++) file[i] = i % 256
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= file.length) { controller.close(); return }
        const chunk = file.subarray(pulled, pulled + 100)
        pulled += chunk.length
        controller.enqueue(chunk)
      },
      cancel() { cancelled = true },
    })
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch
    const read = fetchRangeReader('https://example.test/photo.jpg')
    const out = await read(500, 50)
    expect(out.length).toBe(50)
    // Bytes 500..549 of the file.
    expect(out[0]).toBe(500 % 256)
    expect(out[49]).toBe(549 % 256)
    // Stream cancelled once the window was filled — not the whole file.
    // (The stream's internal queue may pull one chunk ahead of the reader.)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(file.length)
  })

  test('non-ok responses throw', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch
    const read = fetchRangeReader('https://example.test/missing.jpg')
    await expect(read(0, 10)).rejects.toThrow('404')
  })
})
