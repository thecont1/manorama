import { afterEach, describe, expect, test } from 'bun:test'
import { bundledGallery, getGallery } from '../app/lib/gallery-repository'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('getGallery', () => {
  test('keeps the bundled Italy gallery available when Airtable has no record yet', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ records: [] }), { status: 200 })) as typeof fetch

    const gallery = await getGallery(bundledGallery.slug, {
      AIRTABLE_PAT: 'test-token',
      AIRTABLE_BASE_ID: 'test-base',
    })

    expect(gallery?.slug).toBe(bundledGallery.slug)
    expect(gallery?.images).toHaveLength(bundledGallery.images.length)
  })
})
