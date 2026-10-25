import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../api'
import { createGallery, resetGalleryStore } from '../lib/gallery-repository'
import { resetUserStore } from '../lib/user-repository'
import { seedTestUser } from '../lib/test-fixtures'

/**
 * `/api/og/:owner/:slug` is public, composes at full source resolution, and
 * is documented as caching for a day (og-card.ts, TECH-SPEC § og). The `?i=`
 * parameter is the cache-busting knob — but the route never reads it, so any
 * caller can append an arbitrary value and mint a fresh cache entry for
 * identical work: one provider fetch plus a full-resolution decode and
 * re-encode per hit.
 *
 * These tests hold the two properties a fix must keep: the output does not
 * depend on `i` (a stale social card must never break), and the response is
 * still shared-cacheable.
 */

const FIRST_KEY = 'IMG_0001.jpg'
const JPEG = Uint8Array.from(atob(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
), (character) => character.charCodeAt(0))

let api: ReturnType<typeof createManoramaApi>
let path: string
let photoFetches = 0

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  const owner = await seedTestUser()
  await createGallery(owner.accountId, {
    slug: 'synthetic-gallery',
    title: 'Synthetic',
    caption: '',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/synthetic?rlkey=SYNTH',
    createdAt: new Date().toISOString(),
    images: [{
      id: 'synthetic-1',
      filename: FIRST_KEY,
      src: '/api/drive/thumbnail?id=SYNTHFILE&size=w256',
      width: 4,
      height: 3,
      alt: 'Synthetic',
      c2pa: true,
      placeholder: '',
      variants: [],
    }],
  })
  path = `/api/og/${owner.ownerSlug}/synthetic-gallery`
  api = createManoramaApi()
})

const withFetch = async (run: () => Promise<void>) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (!url.includes('og-logo-pill.png')) photoFetches += 1
    return new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('og card cache key', () => {
  test('the card is shared-cacheable', async () => {
    await withFetch(async () => {
      const response = await api.request(`${path}?i=${FIRST_KEY}`, {}, {})
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toMatch(/s-maxage=\d+/)
    })
  })

  test('an unrecognised i is normalised to the canonical card', async () => {
    let recognised = new Uint8Array()
    let normalised = new Uint8Array()
    await withFetch(async () => {
      recognised = new Uint8Array(await (await api.request(`${path}?i=${FIRST_KEY}`, {}, {})).arrayBuffer())
      const redirect = await api.request(`${path}?i=zzz-unvalidated-nonce`, { redirect: 'manual' } as RequestInit, {})
      expect(redirect.status).toBe(302)
      const location = new URL(redirect.headers.get('Location')!)
      expect(location.searchParams.get('i')).toBe(FIRST_KEY)
      normalised = new Uint8Array(await (await api.request(`${location.pathname}${location.search}`, {}, {})).arrayBuffer())
    })
    expect(normalised.byteLength).toBe(recognised.byteLength)
    expect(Buffer.from(normalised).equals(Buffer.from(recognised))).toBe(true)
  })

  test('a missing i still renders a card', async () => {
    await withFetch(async () => {
      const response = await api.request(path, {}, {})
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    })
  })

  test('an unknown gallery still lands on the static fallback', async () => {
    await withFetch(async () => {
      const response = await api.request('/api/og/nobody/no-gallery?i=x', { redirect: 'manual' } as RequestInit, {})
      expect([200, 302]).toContain(response.status)
    })
  })

  test('the compositor is reached exactly once per request, not per i', async () => {
    photoFetches = 0
    await withFetch(async () => {
      await api.request(`${path}?i=${FIRST_KEY}`, {}, {})
      await api.request(`${path}?i=${FIRST_KEY}`, {}, {})
    })
    // Two requests, two compositions today. With no edge cache in front of the
    // Worker this is the cost an attacker multiplies by varying `i`.
    expect(photoFetches).toBe(2)
  })
})
