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
import { WebSettings } from './components/WebSettings'
import { GalleryDetailsView } from './components/GalleryDetailsView'

const renderSettings = (overrides: Partial<Parameters<typeof WebSettings>[0]> = {}) => String(WebSettings({
  ownerName: 'Test Owner',
  ownerSlug: 'test-owner',
  ownerSlugDraft: 'test-owner',
  onOwnerSlugDraft: () => {},
  onSaveOwnerSlug: () => {},
  ownerSlugBusy: false,
  identities: [],
  onUnlinkIdentity: () => {},
  tier: 'free',
  retainedCount: 3,
  retainedLimit: 3,
  upgradeHref: '/upgrade',
  theme: 'dark',
  onTheme: () => {},
  deleteConfirm: '',
  onDeleteConfirmChange: () => {},
  deleteBusy: false,
  onDeleteAccount: () => {},
  onBack: () => {},
  ...overrides,
}))

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
  const cookie = await sessionCookieFor(TEST_OWNER.accountId)
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
    await createGallery(TEST_OWNER.accountId, {
      slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '', images: [image(`k-${index}`)],
    })
  }
  await createGallery(TEST_OWNER.accountId, {
    slug: 'locked',
    title: 'Locked',
    caption: '',
    date: '',
    sourceUrl: 'https://www.dropbox.com/scl/fo/album',
    images: [image('img-locked')],
  })
}

describe('the dashboard renders retention state', () => {
  test('the owner grid keeps its theme control and never paints a doodle field', async () => {
    const html = await renderDashboard(async () => {})
    // The top bar gear leads to Settings; Settings owns appearance.
    expect(html).toContain('class="m-topbar"')
    expect(html).toContain('aria-label="Settings"')
    expect(renderSettings()).toContain('aria-label="Appearance"')
    // Doodles belong to gallery pages only: the account page must ship no
    // background layer, no has-doodle surface, and no background toggle.
    expect(html).not.toContain('data-doodle-bg')
    expect(html).not.toContain('has-doodle')
    expect(html).not.toContain('Use doodle background')
    expect(html).not.toContain('admin-background-toggle')
  })

  test('the account opens from the top bar gear and editor rails need no repeated heading', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    expect(html).toContain('class="m-topbar"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('admin-edge-tab')
    expect(html).not.toContain('admin-account-drawer')
    expect(html).not.toContain('admin-menu-bars')
    expect(html).not.toContain('admin-gallery-editor-label')
    expect(html).not.toContain('Photo Editor')
    expect(html).toContain('aria-label="Locked photographs"')
    expect(html).not.toContain('aria-label="Reorder Locked images"')
  })

  test('the Library leads with its heading and keeps the plan line in Settings', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    // The account workbench moved off the Library: address lives in
    // Settings › Account, the plan summary in Settings › Plan.
    expect(html).not.toContain('class="admin-overview"')
    expect(html).not.toContain('aria-label="Welcome to manorama"')
    expect(html).not.toContain('admin-owner-slug-input')
    expect(html.indexOf('class="m-topbar"')).toBeLessThan(html.indexOf('class="admin-library-heading"'))
    expect(html.indexOf('class="admin-library-heading"')).toBeLessThan(html.indexOf('class="lib-list"'))
    expect(html).not.toContain('class="admin-lib-foot"')
    expect(html).toContain('aria-labelledby="galleries-heading"')
  })

  test('a pipeline card folds the lock into its metadata line and Details carries the upgrade path', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    expect(html).toContain('data-retention="pipeline"')
    expect(html).toContain('data-retention="retained"')
    const settings = renderSettings()
    expect(settings).toContain(FREE_RETENTION_DISCLOSURE)
    expect(settings).toContain('Editable galleries')
    expect(settings).toContain('3 of 3')

    const card = cardSection(html, 'locked')
    // The card states the lock in its sub line; nothing on it is editable.
    expect(card).not.toContain('aria-disabled')
    expect(card).not.toContain('editable-value')
    expect(card).not.toContain('admin-gallery-retention')
    expect(card).not.toContain('retention-locked')
    expect(card).not.toMatch(/<figure[^>]*draggable/)
    expect(card).toContain('draggable="false"')
    expect(card).toContain('Temporary gallery')
    expect(card).toContain('expires')
    expect(card).toContain('aria-label="Locked actions"')

    // The upgrade path moved off the card into Details (D5).
    expect(card).not.toContain('Upgrade')
    const details = String(GalleryDetailsView({
      title: 'Locked',
      caption: '',
      address: 'manorama.xyz/test-owner/locked',
      imageCount: 1,
      sourceLabel: 'Dropbox',
      temporary: true,
      expiresAt: '2026-11-15T00:00:00.000Z',
      editable: false,
      streamOnly: false,
      platform: 'web',
      upgradeHref: 'mailto:mahesh@thecontrarian.in?subject=Manorama%20upgrade',
      onBack: () => {},
      onOpen: () => {},
      onShare: () => {},
      onEditName: () => {},
      onEditCaption: () => {},
      onEditAddress: () => {},
      onReorder: () => {},
      onRefresh: () => {},
      onStreamOnlyChange: () => {},
      onPurge: () => {},
      onRemove: () => {},
    }))
    expect(details).toContain('Temporary gallery')
    expect(details).toContain(PIPELINE_LOCK_MESSAGE)
    expect(details).toContain('mailto:mahesh@thecontrarian.in')
    expect(details).toContain('Upgrade')
  })

  test('retained cards expose the rail links and the action menu', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    const card = cardSection(html, 'kept-0')
    expect(card).not.toContain('aria-disabled')
    expect(card).not.toContain('editable-value')
    expect(card).not.toMatch(/<figure[^>]*draggable/)
    expect(card).toContain('draggable="false"')
    expect(card).toContain('aria-label="Kept 0 actions"')
    expect(card).toContain('aria-haspopup="dialog"')
    expect(card).toContain('class="lib-card-title"')
    expect(card).toContain('href="/test-owner/kept-0"')
  })

  test('a pro dashboard reports paid availability, and the cap message when full', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.accountId, 'pro')
      for (let index = 0; index < 3; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '', images: [image(`k-${index}`)],
        })
      }
    })
    const settings = renderSettings({ tier: 'pro', retainedLimit: 99 })
    expect(settings).toContain('3 of 99')
    expect(settings).toContain('Paid accounts retain up to 99 galleries.')
    expect(settings).not.toContain(FREE_RETENTION_DISCLOSURE)
  })

  test('a live pipeline gallery stays publicly viewable until its deadline', async () => {
    await renderDashboard(seedPipelineOwner)
    const response = await buildApp().request('/test-owner/locked', {}, env)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Locked')
  })

  test('a pro owner at 99 sees the persistent limit copy', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.accountId, 'pro')
      for (let index = 0; index < 99; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `full-${index}`, title: `Full ${index}`, caption: '', date: '', images: [image(`f-${index}`)],
        })
      }
    })
    const settings = renderSettings({ tier: 'pro', retainedCount: 99, retainedLimit: 99 })
    expect(settings).toContain('99 of 99')
    expect(settings).toContain(paidGalleryLimitError().message)
  })

  test('Settings carries the self-serve delete-account controls', async () => {
    const html = await renderDashboard(async () => {})
    expect(html).toContain('aria-label="Settings"')
    const settings = renderSettings({ deleteConfirm: 'test-owner' })
    expect(settings).toContain('m-settings-delete')
    expect(settings).toContain('Type your URL name (test-owner) to confirm')
    expect(settings).toContain('Nothing in your Dropbox, Google Drive, iCloud or MEGA is touched')
    expect(settings).toContain('Delete my account')
  })
})
