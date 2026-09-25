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

const openFixture = async (page: Page, images = Array.from({ length: 12 }, (_, i) => image(i))) => {
  await page.route(apiPattern, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(manifest(images)),
  }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=global-fixture`)
}

// The cache fill runs in the background and writes vault metadata last; the
// island retries while a gallery is open, so the grid's arrival is the signal.
const enableGlobalView = async (page: Page) => {
  await page.getByRole('button', { name: /Global view/ }).click()
  // A fresh context is always opted out, so the explainer and its enable
  // button arrive after the async preference read — wait for them.
  await page.getByRole('button', { name: 'Turn on global view' }).click()
}

test.beforeEach(() => {
  test.skip(!nativeUrl, 'NATIVE_GALLERY_URL is required for the native global-view spec')
})

test('indexes the open gallery offline and lands the stage on the tapped frame', async ({ page }) => {
  await openFixture(page)
  await enableGlobalView(page)

  // Twelve frames from the vault, no network involvement after the open.
  await expect(page.locator('[data-grid-frame]')).toHaveCount(12, { timeout: 15000 })
  await page.route('**', (route) =>
    route.request().url().startsWith('http') ? route.abort() : route.continue())
  await expect(page.locator('[data-grid-frame] img')).toHaveCount(12, { timeout: 10000 })

  await page.locator('[data-grid-frame]').nth(7).click()
  await expect(page.locator('.stage-seq-tally')).toContainText('8 of 12', { timeout: 5000 })
})

test('stays off by default and remembers the choice', async ({ page }) => {
  await openFixture(page)
  await page.getByRole('button', { name: /Global view/ }).click()

  await expect(page.locator('.native-global-explainer')).toBeVisible()
  await expect(page.locator('[data-grid-frame]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Turn on global view' }).click()
  await expect(page.locator('[data-grid-frame]')).toHaveCount(12, { timeout: 15000 })
  await page.getByRole('button', { name: 'Close global view' }).click()

  // The opt-in survives a fresh open of the surface.
  await page.getByRole('button', { name: /Global view/ }).click()
  await expect(page.locator('[data-grid-frame]')).toHaveCount(12, { timeout: 15000 })
})
