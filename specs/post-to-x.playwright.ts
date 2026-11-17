import { expect, test, type Page } from '@playwright/test'
import { PIXEL } from './desktop-admin-fixture'

/**
 * "Post to X" in the native Library.
 *
 * The card's ··· menu gains a second way out beside Share link, and that
 * opens the familiar photograph picker: the same matrix, the same pink on
 * what is in hand. This spec drives the real island against a fixture API,
 * so the wiring — the menu row, the sheet, the count, the ceiling — is
 * proved in the shell rather than only in a unit test.
 */

const base = process.env.NATIVE_GALLERY_URL ?? 'http://localhost:5174'
const owner = 'fixture'
const slug = 'post-to-x-fixture'
const title = 'Autumn in Mysore'

const photographs = [
  { id: 'photo-1', filename: 'first.jpg', width: 1600, height: 1200, alt: 'First photograph' },
  { id: 'photo-2', filename: 'second.jpg', width: 1200, height: 1600, alt: 'Second photograph' },
  { id: 'photo-3', filename: 'third.jpg', width: 1600, height: 1067, alt: 'Third photograph' },
]

const manifest = {
  slug,
  title,
  images: photographs.map((photo) => ({
    ...photo,
    src: PIXEL,
    variants: [{ src: PIXEL, format: 'jpeg' }],
  })),
}

const installFixture = async (page: Page) => {
  await page.addInitScript(() => {
    // The secure store hands back what it was given, so the slug is written
    // plain — it becomes the owner half of the gallery's address.
    localStorage.setItem('capacitor-storage_manorama.session-token', 'post-to-x-fixture-token')
    localStorage.setItem('capacitor-storage_manorama.owner-slug', 'fixture')
  })
  await page.route('**/api/**', (route) => {
    const url = route.request().url()
    if (url.includes('/api/galleries')) {
      return route.fulfill({
        json: {
          galleries: [{
            slug,
            title,
            caption: '',
            date: '',
            imageCount: photographs.length,
            retention: 'retained',
            expiresAt: null,
            sourceUrl: null,
            createdAt: null,
            pinnedAt: null,
            images: manifest.images,
          }],
        },
      })
    }
    if (url.includes(`/api/gallery/${owner}/${slug}`)) {
      return route.fulfill({ json: { manifest, settings: { title } } })
    }
    return route.fulfill({ json: { galleries: [], devices: [], identities: [], suppressions: [], show: false } })
  })
}

test('the Library card posts photographs to X through the picker', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const page = await context.newPage()
  try {
    await installFixture(page)
    await page.goto(base, { waitUntil: 'domcontentloaded' })

    const card = page.locator('.lib-card').first()
    await expect(card.locator('.lib-card-title')).toHaveText(title, { timeout: 20_000 })

    // The two ways a gallery leaves the app sit together: Share link hands
    // over an address, Post to X hands over photographs and a caption.
    await card.locator('.lib-card-menu').click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items.indexOf('Post to X')).toBe(items.indexOf('Share link') + 1)
    await menu.getByRole('menuitem', { name: 'Post to X', exact: true }).click()

    // The picker is the familiar one: a matrix of the gallery's photographs.
    const picker = page.locator('[data-post-to-x]')
    await expect(picker).toBeVisible({ timeout: 20_000 })
    await expect(picker).toHaveAttribute('aria-label', `Post to X — ${title}`)
    const cells = picker.locator('.native-global-cell')
    await expect(cells).toHaveCount(photographs.length)
    await expect(picker.locator('.native-global-picker-meta')).toHaveText('0 of 20 photographs')

    // Nothing is in hand, so there is nothing to post.
    const submit = picker.getByRole('button', { name: 'Post to X', exact: true })
    await expect(submit).toBeDisabled()

    // A tap takes a photograph in; the count follows the hand, not the tap
    // order, and the photograph in hand is marked in shocking pink.
    await cells.nth(2).click()
    await cells.nth(0).click()
    await expect(picker.locator('.native-global-picker-meta')).toHaveText('2 of 20 photographs')
    await expect(cells.nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(cells.nth(2)).toHaveAttribute('aria-pressed', 'true')
    await expect(cells.nth(1)).toHaveAttribute('aria-pressed', 'false')
    await expect(cells.nth(0)).toHaveCSS('outline-color', 'rgb(252, 15, 192)')
    expect(await cells.nth(1).evaluate((node) => getComputedStyle(node).outlineColor)).not.toBe('rgb(252, 15, 192)')
    await expect(submit).toBeEnabled()

    // A caption is optional, and typed beside the photographs.
    await picker.getByLabel('Caption').fill('Three frames from an October morning.')
    await expect(picker.getByLabel('Caption')).toHaveValue('Three frames from an October morning.')
    await expect(picker.locator('.native-postto-note')).toContainText('X takes up to 20 photographs in one post.')

    // Putting a photograph back releases it.
    await cells.nth(0).click()
    await expect(picker.locator('.native-global-picker-meta')).toHaveText('1 of 20 photographs')
    await expect(cells.nth(0)).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await context.close().catch(() => {})
  }
})
