import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { encryptedGalleryDescription, ogImageType } from './lib/og-metadata'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

beforeEach(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
})

describe('encrypted gallery OG metadata', () => {
  test('derives MIME from the actual asset', () => {
    expect(ogImageType('/og-image.png')).toBe('image/png')
    expect(ogImageType('/api/og/a/b?i=x')).toBe('image/jpeg')
    expect(ogImageType('https://manorama.xyz/card.webp')).toBe('image/webp')
  })

  test('description always carries count and provider, and date only when set', () => {
    expect(encryptedGalleryDescription({ count: 3, provider: 'MEGA', date: '' })).toBe('3 photographs · MEGA')
    expect(encryptedGalleryDescription({ count: 1, provider: 'Ente', date: '2026-11-03' })).toBe('1 photograph · 2026-11-03 · Ente')
  })

  test('stale OG URLs for encrypted galleries redirect before any media fetch', async () => {
    await createGallery(TEST_OWNER.accountId, {
      slug: 'encrypted', title: 'Encrypted', caption: '', date: '', sourceUrl: 'https://mega.nz/folder/abc#secret', manifestVersion: 1,
      images: [{ id: 'mega-a', filename: 'a.jpg', src: '/api/mega/file?node=a&k=secret', width: 4, height: 3, alt: '', c2pa: true, placeholder: '' }],
    })
    const realFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = (async () => { fetched = true; throw new Error('media fetch forbidden') }) as typeof fetch
    try {
      const response = await createManoramaApi().request('/api/og/test-owner/encrypted?i=a', {}, env)
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toContain('/og-image.png')
      expect(fetched).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
