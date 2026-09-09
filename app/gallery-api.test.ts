import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let api: ReturnType<typeof createManoramaApi>
let cookie: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  api = createManoramaApi()

  // Seed a runtime gallery (no DB binding -> in-memory store) with a slug
  // distinct from the bundled italy-2018 fixture, which always resolves.
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'test-gallery',
    title: 'Test Gallery',
    caption: '',
    date: '',
    createdAt: '2026-09-04T00:00:00.000Z',
    images: [],
  })
})

const patch = (slug: string, body: object) =>
  api.request(`/api/galleries/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  }, env)

describe('slug rename contract', () => {
  test('renames via body newSlug, not body slug', async () => {
    const response = await patch('test-gallery', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('the URL slug stays the resource identity: the old slug is gone', async () => {
    const response = await patch('test-gallery', { title: 'Stale' })
    expect(response.status).toBe(404)
  })

  test('a body-level replacement slug is no longer accepted', async () => {
    const response = await patch('test-renamed', { slug: 'something-else' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Provide a gallery URL, metadata, or an image order to update' })
  })

  test('an invalid newSlug is rejected with the URL guidance', async () => {
    const response = await patch('test-renamed', { newSlug: 'Not A Valid Slug' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Use lowercase letters, numbers, and single hyphens for the gallery URL' })
  })

  test('renaming onto an existing slug reports a collision', async () => {
    // The bundled italy-2018 fixture always resolves, so it is a guaranteed
    // collision target in the local runtime store.
    const response = await patch('test-renamed', { newSlug: 'italy-2018' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That gallery URL is already in use' })
  })

  test('a no-op rename returns the unchanged gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-renamed' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string } }
    expect(payload.gallery?.slug).toBe('test-renamed')
  })

  test('metadata combines with newSlug and lands on the renamed gallery', async () => {
    const response = await patch('test-renamed', { newSlug: 'test-final', title: 'Final Title' })
    expect(response.status).toBe(200)
    const payload = await response.json() as { gallery?: { slug: string; title: string } }
    expect(payload.gallery?.slug).toBe('test-final')
    expect(payload.gallery?.title).toBe('Final Title')
    // Metadata was NOT applied to the pre-rename identity.
    expect((await patch('test-renamed', { caption: 'x' })).status).toBe(404)
  })

  test('a missing gallery reports 404 for rename attempts', async () => {
    const response = await patch('never-created', { newSlug: 'whatever' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'That gallery was not found' })
  })

  test('the Admin island sends newSlug when editing the slug', () => {
    const admin = readFileSync(`${repoRoot}/app/islands/Admin.tsx`, 'utf8')
    expect(admin).toContain('newSlug')
  })
})

describe('owner URL changes', () => {
  test('rejects an invalid URL with friendly guidance', async () => {
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'Not Valid!' }),
    }, env)
    expect(response.status).toBe(422)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toContain('lowercase letters')
  })

  test('changes the owner URL and galleries follow the account', async () => {
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'renamed-owner' }),
    }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ownerSlug: 'renamed-owner' })
    // The seeded gallery is still reachable under the new owner URL.
    const list = await api.request('/api/galleries', { headers: { Cookie: cookie } }, env)
    const payload = await list.json() as { galleries?: { slug: string }[] }
    expect(payload.galleries?.some((gallery) => gallery.slug === 'test-final')).toBe(true)
  })

  test('rejects a URL already taken by another owner', async () => {
    await seedTestUser({ dropboxAccountId: 'dbid:AAATOTHERuser', displayName: 'Taken Name' })
    const response = await api.request('/api/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ownerSlug: 'taken-name' }),
    }, env)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'That URL is already in use' })
  })
})

describe('the free-tier gallery limit', () => {
  test('a fourth gallery is politely refused', async () => {
    // test-final (from the rename suite) plus these two fills the free
    // allowance; the next create is the fourth.
    await createGallery(TEST_OWNER.dropboxAccountId, { slug: 'filler-two', title: 'Filler Two', caption: '', date: '', images: [] })
    await createGallery(TEST_OWNER.dropboxAccountId, { slug: 'filler-three', title: 'Filler Three', caption: '', date: '', images: [] })
    const response = await api.request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ url: 'https://www.dropbox.com/scl/fo/fourth' }),
    }, env)
    expect(response.status).toBe(403)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toContain('all 3')
  })
})
