import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import renderer from './routes/_renderer'
import ownerPage from './routes/[owner]'
import viewerPage from './routes/[owner]/[slug]'
import { resetUserStore, setUserTier } from './lib/user-repository'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { FREE_RETENTION_DISCLOSURE, paidGalleryLimitError, PIPELINE_LOCK_MESSAGE } from './lib/gallery-policy'
import type { GalleryImage } from './lib/imagesource'

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET, PUBLIC_HOST: 'manorama.xyz' }

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

const buildApp = () => {
  const app = new Hono()
  app.use('*', honoxContext)
  app.use('*', renderer)
  mountRoute(app, '/:owner', ownerPage)
  mountRoute(app, '/:owner/:slug', viewerPage)
  return app
}

const image = (id: string): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3,
  alt: 'a photograph', c2pa: false, placeholder: '',
})

const renderDashboard = async (seed: () => Promise<void>) => {
  resetUserStore()
  resetGalleryStore()
  const user = await seedTestUser()
  await seed()
  const cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  const response = await buildApp().request(`/${user.ownerSlug}`, { headers: { Cookie: cookie } }, env)
  expect(response.status).toBe(200)
  return response.text()
}

const cardSection = (html: string, slug: string) => {
  const start = html.indexOf(`data-gallery-card="${slug}"`)
  expect(start).toBeGreaterThan(-1)
  const rest = html.slice(start)
  const next = rest.indexOf('data-gallery-card="', 1)
  return next === -1 ? rest : rest.slice(0, next)
}

const seedPipelineOwner = async () => {
  for (let index = 0; index < 3; index += 1) {
    await createGallery(TEST_OWNER.dropboxAccountId, {
      slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '', images: [image(`k-${index}`)],
    })
  }
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'locked',
    title: 'Locked',
    caption: '',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/album',
    images: [image('img-locked')],
  })
}

describe('the dashboard renders retention state', () => {
  test('a pipeline card locks every edit surface and explains the deadline', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    expect(html).toContain('data-retention="pipeline"')
    expect(html).toContain('data-retention="retained"')
    expect(html).toContain(FREE_RETENTION_DISCLOSURE)
    expect(html).toContain('3 retained galleries · 0 editable slots available')

    const card = cardSection(html, 'locked')
    expect(card.match(/aria-disabled="true"/g)?.length).toBe(5)
    expect(card.match(/aria-describedby="retention-locked"/g)?.length).toBe(4)
    expect(card).toMatch(/<figure[^>]*draggable="false"/)
    expect(card).toContain(`id="retention-locked"`)
    expect(card).toContain('Temporary ·')
    expect(card).toContain('days left')
    expect(card).toContain('Expires')
    expect(card).toContain(PIPELINE_LOCK_MESSAGE)
    expect(card).toContain('mailto:mahesh@thecontrarian.in')
    expect(card).toContain('Upgrade')

    expect(card).toContain('aria-label="Open Locked in a new tab"')
    expect(card).toContain('aria-label="Copy Locked link"')
    expect(card).toContain('aria-label="Delete Locked"')
    expect(card).toContain('aria-label="Open the Locked source')
    expect(card).toContain('aria-label="Refresh Locked from its source link"')
  })

  test('retained cards stay fully editable and deletable', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    const card = cardSection(html, 'kept-0')
    expect(card).not.toContain('aria-disabled')
    expect(card).toMatch(/<figure[^>]*draggable="true"/)
    expect(card).toContain('aria-label="Delete Kept 0"')
    expect(card).toContain('aria-label="Edit gallery title')
  })

  test('a pro dashboard reports paid availability, and the cap message when full', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.dropboxAccountId, 'pro')
      for (let index = 0; index < 3; index += 1) {
        await createGallery(TEST_OWNER.dropboxAccountId, {
          slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '', images: [image(`k-${index}`)],
        })
      }
    })
    expect(html).toContain('3 retained galleries · 96 available')
    expect(html).toContain('Paid accounts retain up to 99 galleries.')
    expect(html).not.toContain(FREE_RETENTION_DISCLOSURE)
  })

  test('a live pipeline gallery stays publicly viewable until its deadline', async () => {
    await renderDashboard(seedPipelineOwner)
    const response = await buildApp().request('/test-owner/locked', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Locked')
  })

  test('a pro owner at 99 sees the persistent limit copy', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.dropboxAccountId, 'pro')
      for (let index = 0; index < 99; index += 1) {
        await createGallery(TEST_OWNER.dropboxAccountId, {
          slug: `full-${index}`, title: `Full ${index}`, caption: '', date: '', images: [image(`f-${index}`)],
        })
      }
    })
    expect(html).toContain('99 retained galleries · 0 available')
    expect(html).toContain(paidGalleryLimitError().message)
  })
})
