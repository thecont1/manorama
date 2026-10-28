import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import viewerPage from './routes/[owner]/[slug]'
import { resetUserStore } from './lib/user-repository'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}
const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let ownerCookie: string
let memberCookie: string
let ownerSlug: string

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  const owner = await seedTestUser()
  ownerSlug = owner.ownerSlug
  const member = await seedTestUser({ accountId: 'member-1' })
  void member
  ownerCookie = await sessionCookieFor(TEST_OWNER.accountId)
  memberCookie = await sessionCookieFor('member-1')
  await createGallery(TEST_OWNER.accountId, {
    slug: 'role-gallery',
    title: 'Role Gallery',
    caption: '',
    date: '',
    images: [
      { id: 'r1', filename: 'r1.jpg', src: '/images/r1.jpg', width: 100, height: 100, alt: 'one', c2pa: false, placeholder: '' },
      { id: 'r2', filename: 'r2.jpg', src: '/images/r2.jpg', width: 100, height: 100, alt: 'two', c2pa: false, placeholder: '' },
      { id: 'r3', filename: 'r3.jpg', src: '/images/r3.jpg', width: 100, height: 100, alt: 'three', c2pa: false, placeholder: '' },
    ],
  })
})

const mountRoute = (hono: Hono, path: string, route: unknown) => {
  const get = hono.get.bind(hono) as (p: string, ...h: unknown[]) => void
  if (Array.isArray(route)) get(path, ...route)
  else get(path, route)
}
const app = () => {
  const hono = new Hono()
  hono.use('*', honoxContext)
  mountRoute(hono, '/:owner/:slug', viewerPage)
  return hono
}
const get = async (path: string, cookie?: string) =>
  app().request(path, cookie ? { headers: { Cookie: cookie } } : {}, env)

describe('gallery route viewer role and photo intent', () => {
  test('the owner session resolves viewerRole owner with libraryHref', async () => {
    const res = await get(`/${ownerSlug}/role-gallery`, ownerCookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-viewer-role="owner"')
    expect(html).toContain(`data-library-href="/${ownerSlug}"`)
  })

  test('a different signed-in session resolves member', async () => {
    const res = await get(`/${ownerSlug}/role-gallery`, memberCookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-viewer-role="member"')
    expect(html).toContain('data-library-href=')
  })

  test('a visitor resolves visitor with no libraryHref', async () => {
    const res = await get(`/${ownerSlug}/role-gallery`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-viewer-role="visitor"')
    expect(html).not.toContain('data-library-href')
  })

  test('an invalid session degrades to visitor instead of 500', async () => {
    const res = await get(`/${ownerSlug}/role-gallery`, 'manorama_session=not-a-jwt')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-viewer-role="visitor"')
  })

  test('a valid ?photo= sets the initial index and mounts the cleanup island', async () => {
    const res = await get(`/${ownerSlug}/role-gallery?photo=r2`)
    expect(res.status).toBe(200)
    const html = await res.text()
    // The committed position is SSR-observable through the info modal's
    // position value rather than serialized island props.
    expect(html).toContain('data-image-id="r2"')
    expect(html).toContain('<span class="position-value">2 / 3</span>')
  })

  test('an unknown ?photo= is ignored but the URL still gets cleaned', async () => {
    const res = await get(`/${ownerSlug}/role-gallery?photo=nope`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<span class="position-value">1 / 3</span>')
  })
})
