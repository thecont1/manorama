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
    // The Settings pill leads to Settings; Settings owns appearance.
    expect(html).not.toContain('class="m-topbar"')
    expect(html).toContain('aria-label="Settings"')
    expect(renderSettings()).toContain('aria-label="Appearance"')
    // Doodles belong to gallery pages only: the account page must ship no
    // background layer, no has-doodle surface, and no background toggle.
    expect(html).not.toContain('data-doodle-bg')
    expect(html).not.toContain('has-doodle')
    expect(html).not.toContain('Use doodle background')
    expect(html).not.toContain('admin-background-toggle')
  })

  test('the account opens from the Settings pill and editor rails need no repeated heading', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    expect(html).not.toContain('class="m-topbar"')
    expect(html).toContain('aria-label="Settings"')
    expect(html).not.toContain('admin-edge-tab')
    expect(html).not.toContain('admin-account-drawer')
    expect(html).not.toContain('admin-menu-bars')
    expect(html).not.toContain('admin-gallery-editor-label')
    expect(html).not.toContain('Photo Editor')
    // The pipeline gallery is a compact row now — a cover and the
    // Temporary label, not a rail of items.
    expect(html).toContain('data-gallery-card="locked"')
    expect(html).toContain('Temporary galleries')
    expect(html).not.toContain('aria-label="Locked photographs"')
    expect(html).not.toContain('aria-label="Reorder Locked images"')
  })

  test('the Library leads with its heading and keeps the plan line in Settings', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    // The account workbench moved off the Library: address lives in
    // Settings › Account, the plan summary in Settings › Plan.
    expect(html).not.toContain('class="admin-overview"')
    expect(html).not.toContain('aria-label="Welcome to manorama"')
    expect(html).not.toContain('admin-owner-slug-input')
    expect(html.indexOf('admin-brand-mark')).toBeLessThan(html.indexOf('class="admin-library-heading"'))
    expect(html.indexOf('class="admin-library-heading"')).toBeLessThan(html.indexOf('class="lib-list"'))
    expect(html).not.toContain('class="admin-lib-foot"')
    expect(html).toContain('aria-labelledby="galleries-heading"')
  })

  test('the Library sub line states the plan, the hosted counts, and the upgrade path', async () => {
    const html = await renderDashboard(seedPipelineOwner)
    expect(html).toContain('You are a manorama <strong>Free User</strong> hosting')
    expect(html).toMatch(/hosting<br ?\/?><strong>3<\/strong> of 3 permanent galleries/)
    expect(html).toContain('and <strong>1</strong> temporary gallery.')
    expect(html).toContain('Upgrade to Visionary?')
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
      mediaCount: { stills: 1, videos: 0 },
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

  test('cards and the Details header count stills and videos separately', async () => {
    const video = { type: 'video' as const, id: 'v-1', filename: 'v-1.mp4', src: '/v-1.mp4', mimeType: 'video/mp4' as const, width: 4, height: 3, poster: { src: '/v-1.jpg', width: 4, height: 3 }, alt: 'a video', c2pa: false as const, placeholder: '' }
    const html = await renderDashboard(async () => {
      await createGallery(TEST_OWNER.accountId, {
        slug: 'mixed',
        title: 'Mixed',
        caption: '',
        date: '',
        images: [video, ...Array.from({ length: 24 }, (_, index) => image(`m-${index}`))],
      })
    })
    const card = cardSection(html, 'mixed')
    expect(card).toContain('24 photographs · 1 video')
    expect(card).not.toContain('25 photographs')
    const details = String(GalleryDetailsView({
      title: 'Mixed',
      caption: '',
      address: 'manorama.xyz/test-owner/mixed',
      imageCount: 25,
      mediaCount: { stills: 24, videos: 1 },
      sourceLabel: 'Dropbox',
      editable: true,
      streamOnly: false,
      platform: 'web',
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
    expect(details).toContain('24 photographs · 1 video')
    expect(details).not.toContain('25 photographs')
  })

  test('a hidden photograph stays in the owner rail, dimmed and badged', async () => {
    const html = await renderDashboard(async () => {
      await createGallery(TEST_OWNER.accountId, {
        slug: 'mixed', title: 'Mixed', caption: '', date: '',
        images: [image('vis-1'), { ...image('hid-1'), hidden: true }, image('vis-2')],
      })
    })
    const card = cardSection(html, 'mixed')
    expect(card).toContain('admin-gallery-strip-item is-hidden')
    expect(card).toContain('admin-strip-badge--hidden')
    expect(card).toContain('hidden image 2 of 3')
    expect((card.match(/is-hidden/g) ?? []).length).toBe(1)
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

describe('the lean library layout', () => {
  test('a Visionary library renders three strips then compact cards', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.accountId, 'pro')
      for (let index = 0; index < 12; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `lean-${index}`, title: `Lean ${index}`, caption: '', date: '',
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          images: [image(`lean-${index}`)],
        })
      }
    })
    expect((html.match(/admin-gallery-strip-frame/g) ?? []).length).toBe(3)
    expect((html.match(/lib-compact-card/g) ?? []).length).toBe(9)
    expect(html).toContain('More galleries')
    expect(html).not.toContain('Temporary galleries')
  })

  test('a free library renders retained strips then temporary rows', async () => {
    const html = await renderDashboard(async () => {
      for (let index = 0; index < 3; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `kept-${index}`, title: `Kept ${index}`, caption: '', date: '',
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          images: [image(`kept-${index}`)],
        })
      }
      for (let index = 0; index < 2; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `temp-${index}`, title: `Temp ${index}`, caption: '', date: '',
          createdAt: new Date(Date.now() - (index + 10) * 60_000).toISOString(),
          images: [image(`temp-${index}`)],
        })
      }
    })
    // Free: only the retained three strip; both pipelines are compact
    // cards under the Temporary label.
    expect((html.match(/admin-gallery-strip-frame/g) ?? []).length).toBe(3)
    expect((html.match(/lib-compact-card/g) ?? []).length).toBe(2)
    expect(html).toContain('Temporary galleries')
    expect(html).toContain('data-retention="pipeline"')
  })

  test('a strip rail renders every item in the gallery', async () => {
    const html = await renderDashboard(async () => {
      await setUserTier(TEST_OWNER.accountId, 'pro')
      await createGallery(TEST_OWNER.accountId, {
        slug: 'big', title: 'Big', caption: '', date: '',
        images: Array.from({ length: 20 }, (_, index) => image(`big-${index}`)),
      })
    })
    // The rail is the whole gallery — no preview window, no "+N" tile.
    expect((html.match(/data-image-id=/g) ?? []).length).toBe(20)
    expect(html).not.toContain('more in Big')
  })

  test('a pinned gallery leads its strips with the pin glyph', async () => {
    const html = await renderDashboard(async () => {
      const { setGalleryPinned } = await import('./lib/gallery-repository')
      await setUserTier(TEST_OWNER.accountId, 'pro')
      for (let index = 0; index < 12; index += 1) {
        await createGallery(TEST_OWNER.accountId, {
          slug: `sort-${index}`, title: `Sort ${index}`, caption: '', date: '',
          createdAt: new Date(Date.now() - index * 60_000).toISOString(),
          images: [image(`sort-${index}`)],
        })
      }
      await setGalleryPinned(TEST_OWNER.accountId, 'sort-11', true)
    })
    // The oldest gallery pins into the first strip position.
    expect(html.indexOf('aria-label="Pinned"')).toBeGreaterThan(-1)
    const firstCard = html.indexOf('data-gallery-card="sort-11"')
    const secondCard = html.indexOf('data-gallery-card="sort-0"')
    expect(firstCard).toBeGreaterThan(-1)
    expect(firstCard).toBeLessThan(secondCard)
    // And it still renders as a strip, not a compact row.
    const card = cardSection(html, 'sort-11')
    expect(card).toContain('admin-gallery-strip')
  })
})
