import { expect, test, type Page } from '@playwright/test'
import { showChrome } from '../../playwright-helpers'
import { mkdirSync } from 'node:fs'

/** Parity capture: drives the real native bundle (NATIVE_GALLERY_URL serving
 *  native/dist) through the 13 redesign screens, seeded like the account
 *  fixture. Every screen reloads first so overlay state never leaks between
 *  shots. Output: docs/redesign-parity/native/<viewport>/<screen>.png */

const BASE = process.env.NATIVE_GALLERY_URL ?? 'http://localhost:5299'

const svg = (label: string, w = 640, h = 900) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}`

const photo = (i: number) => ({
  id: `p${i}`, filename: `p${i}.svg`, src: svg(`photograph ${i + 1}`), width: 640, height: 900,
  alt: `Photograph ${i + 1}`, c2pa: false, placeholder: svg(`ph ${i + 1}`, 64, 90),
})

const galleryPayload = JSON.stringify({
  manifest: { slug: 'kashmir', title: 'Kashmir', caption: 'A winter album', date: '2026-10-28', images: Array.from({ length: 8 }, (_, i) => photo(i)) },
  settings: { title: 'Kashmir', caption: 'A winter album', date: '2026-10-28', curtainKicker: '', curtainPrompt: '', defaultMode: 'strip', defaultShowArrows: false, defaultShowCaptions: false, imageCaptions: {}, imageAlts: {} },
})

const summary = (slug: string, title: string, caption: string, imgs: number[]) => ({
  slug, title, caption, date: '', imageCount: imgs.length, sourceUrl: null,
  createdAt: null, retention: 'retained', expiresAt: null, images: imgs.map(photo),
})

const galleriesPayload = JSON.stringify({
  galleries: [summary('kashmir', 'Kashmir', 'A winter album', [0, 1]), summary('italy', 'Italy', '', [2, 3])],
})

const mockApi = async (page: Page) => {
  // Registered first so the specifics below win (Playwright matches in reverse).
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, body: '{}' }))
  await page.route('**/api/gallery/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: galleryPayload }))
  await page.route('**/api/galleries*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: galleriesPayload }))
  await page.route('**/api/device-galleries*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"galleries":[]}' }))
  await page.route('**/api/ads/visibility*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"show":true,"day":"2026-10-28"}' }))
  await page.route('**/api/account*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"quiet-owner"}' }))
  // Registered last so it wins over the account catch-all above.
  await page.route('**/api/account/identities*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"identities":[{"provider":"apple"},{"provider":"dropbox"}]}' }))
}

const seed = () => {
  localStorage.setItem('capacitor-storage_manorama.session-token', 'session-token-1')
  localStorage.setItem('capacitor-storage_manorama.owner-slug', 'quiet-owner')
}

const library = async (page: Page) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.lib-card').first()).toBeVisible({ timeout: 20000 })
}

const VIEWPORTS = [
  { w: 390, h: 844 },
  { w: 375, h: 812 },
]

for (const vp of VIEWPORTS) {
  const out = `docs/redesign-parity/native/${vp.w}x${vp.h}`
  mkdirSync(out, { recursive: true })
  const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}.png` })

  test.describe(`parity captures ${vp.w}x${vp.h}`, () => {
    test('signed-in screens', async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h })
      await mockApi(page)

      // welcome — unseeded first load
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.native-welcome')).toBeVisible({ timeout: 20000 })
      await shot(page, 'welcome')

      // library — seed, reload
      await page.evaluate(seed)
      await library(page)
      await shot(page, 'library')

      // add sheet
      await page.getByRole('button', { name: 'Add', exact: true }).first().click()
      await expect(page.locator('.m-sheet')).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, 'add')

      // details
      await library(page)
      await page.locator('[aria-label="Kashmir actions"]').click()
      await page.getByRole('menuitem', { name: 'Gallery details' }).click()
      await expect(page.locator('[data-screen="details"]')).toBeVisible()
      await shot(page, 'details')

      // reorder
      await library(page)
      await page.locator('[aria-label="Kashmir actions"]').click()
      await page.getByRole('menuitem', { name: 'Reorder photographs' }).click()
      await expect(page.locator('[data-gallery-editor]')).toBeVisible()
      await shot(page, 'reorder')

      // settings
      await library(page)
      await page.locator('[aria-label="Settings"]').click()
      await expect(page.locator('[data-screen="settings"]')).toBeVisible()
      await shot(page, 'settings')

      // visionary — a sheet over settings
      await page.getByRole('button', { name: 'Go Visionary' }).click()
      await expect(page.locator('.m-sheet')).toBeVisible()
      // let the sheet enter animation finish before capturing
      await page.waitForTimeout(400)
      await shot(page, 'visionary')

      // privacy — back through settings
      await page.locator('.m-sheet [aria-label="Close"]').click()
      await page.getByRole('button', { name: 'Privacy Policy' }).click()
      await expect(page.locator('.privacy-view')).toBeVisible()
      await shot(page, 'privacy')
    })

    test('viewer screens', async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h })
      await mockApi(page)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await page.evaluate(seed)
      await library(page)

      // curtain
      await page.locator('.lib-card-title').first().click()
      const curtain = page.locator('[data-curtain]')
      await expect(curtain).toBeVisible({ timeout: 20000 })
      await shot(page, 'viewer-curtain')

      // stage
      await curtain.click()
      await expect(curtain).toBeHidden()
      await expect(page.locator('.viewer-stage')).toBeVisible()
      await shot(page, 'viewer')

      // chrome
      await showChrome(page)
      await shot(page, 'viewer-chrome')

      // display sheet
      await page.locator('[data-chrome-bottom] button', { hasText: 'Display' }).click()
      await expect(page.locator('.m-sheet, [role="dialog"]').first()).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, 'display')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)

      // info sheet
      await page.locator('[data-chrome-bottom] button', { hasText: 'Info' }).click()
      await expect(page.locator('.m-sheet, [role="dialog"]').first()).toBeVisible()
      await page.waitForTimeout(400)
      await shot(page, 'info')
    })
  })
}
