/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'
import type { GalleryImage } from '../app/lib/imagesource'

const nativeUrl = process.env.NATIVE_GALLERY_URL
const apiPattern = '**/api/gallery/**'
const svg = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}`

const image = (index: number): GalleryImage => ({
  id: `gv-${index}`,
  filename: `gv-${index}.svg`,
  src: svg(`photograph ${index + 1}`),
  width: 640,
  height: 900,
  alt: `Photograph ${index + 1}`,
  c2pa: false,
  placeholder: svg(`placeholder ${index + 1}`),
})

const manifest = (images: GalleryImage[]) => ({
  manifest: {
    slug: 'global-fixture',
    title: 'Global fixture',
    caption: 'A deterministic global-view acceptance gallery.',
    date: '2026-09-24',
    images,
  },
  settings: {
    title: 'Global fixture',
    caption: 'A deterministic global-view acceptance gallery.',
    date: '2026-09-24',
    curtainKicker: 'A single album',
    curtainPrompt: 'Tap, click, or press Enter to enter',
    defaultMode: 'strip',
    defaultShowCaptions: false,
    defaultShowArrows: false,
    imageCaptions: {},
    imageAlts: {},
  },
})

const openFixture = async (
  page: Page,
  images = Array.from({ length: 12 }, (_, i) => image(i)),
  globalView = true,
) => {
  await page.addInitScript((enabled) => {
    if (enabled) localStorage.setItem('CapacitorStorage.manorama.global-view', 'on')
    else localStorage.removeItem('CapacitorStorage.manorama.global-view')
  }, globalView)
  await page.route(apiPattern, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(manifest(images)),
  }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=global-fixture`)
  await page.getByRole('button', { name: 'Enter gallery' }).click()
}

// The cache fill runs in the background and writes vault metadata last; the
// island retries while a gallery is open, so the grid's arrival is the signal.
const enableGlobalView = async (page: Page) => {
  await page.getByRole('button', { name: /open photo picker/i }).click()
}

test.beforeEach(() => {
  test.skip(!nativeUrl, 'NATIVE_GALLERY_URL is required for the native global-view spec')
})

test('shows the open gallery offline and lands the stage on the tapped frame', async ({ page }) => {
  await openFixture(page)
  await enableGlobalView(page)

  // Twelve frames from the vault, no network involvement after the open.
  await expect(page.locator('[data-grid-frame]')).toHaveCount(12, { timeout: 15000 })
  await page.route('**', (route) =>
    route.request().url().startsWith('http') ? route.abort() : route.continue())
  const picker = page.locator('[data-global-scroll]')
  await picker.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.locator('[data-grid-frame] img')).toHaveCount(12, { timeout: 10000 })

  await page.locator('[data-grid-frame]').nth(7).click()
  await expect(page.locator('.stage-seq-tally')).toContainText('8 of 12', { timeout: 5000 })
})

test('lands the stage on a tapped frame that cannot dock at the left edge', async ({ page }) => {
  await openFixture(page)
  await enableGlobalView(page)

  // A later frame remains directly selectable after the vertical contact sheet
  // has materialized and scrolled beyond its first screenful.
  await page.locator('[data-global-scroll]').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.locator('[data-grid-frame]').nth(10).click()
  await expect(page.locator('.stage-seq-tally')).toContainText('11 of 12', { timeout: 5000 })
})

test('lands the stage on the last of two rapid frame taps', async ({ page }) => {
  await openFixture(page)
  await enableGlobalView(page)

  await expect(page.locator('[data-grid-frame]')).toHaveCount(12, { timeout: 15000 })

  // Two selections fire before the first remount can settle: the latest
  // request is the only one allowed to commit.
  await page.evaluate(() => {
    const cells = document.querySelectorAll<HTMLElement>('[data-grid-frame]')
    cells[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    cells[10]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.stage-seq-tally')).toContainText('11 of 12', { timeout: 5000 })
})

test('stays in the local selector until enabled from admin', async ({ page }) => {
  await openFixture(page, undefined, false)
  await page.getByRole('button', { name: /open .*picker/i }).click()

  await expect(page.locator('[data-global-view]')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Global fixture photographs' })).toBeVisible()
})
