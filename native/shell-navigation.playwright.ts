import { expect, test, type Page } from '@playwright/test'
import { showChrome } from '../playwright-helpers'

/** P2 navigation seam: the reducer drives the real GalleryList surfaces in
 *  the browser fixture — viewer back lands on the library, a Global View
 *  same-gallery jump remounts the Viewer exactly once, and the reorder
 *  editor returns to the library. */

const nativeUrl = process.env.NATIVE_GALLERY_URL
if (!nativeUrl) throw new Error('NATIVE_GALLERY_URL is required for the shell-navigation spec')

const apiPattern = '**/api/gallery/**'
const svg = (label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}`
const photo = (index: number) => ({
  id: `nav-${index}`,
  filename: `nav-${index}.svg`,
  src: svg(`photograph ${index + 1}`),
  width: 640,
  height: 900,
  alt: `Nav photograph ${index + 1}`,
  c2pa: false,
  placeholder: svg(`ph ${index + 1}`),
})
const payload = JSON.stringify({
  manifest: { slug: 'nav-fixture', title: 'Nav fixture', caption: 'Shell navigation seam.', date: '2026-10-28', images: Array.from({ length: 30 }, (_, i) => photo(i)) },
  settings: { title: 'Nav fixture', caption: 'Shell navigation seam.', date: '2026-10-28', curtainKicker: 'A single album', curtainPrompt: 'Tap, click, or press Enter to enter', defaultMode: 'strip', defaultShowArrows: false, defaultShowCaptions: true, imageCaptions: {}, imageAlts: {} },
})

const openApp = async (page: Page, galleryRequests?: string[]) => {
  await page.route(apiPattern, (route) => {
    galleryRequests?.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'application/json', body: payload })
  })
  await page.route('**/manorama.xyz*', (route) => route.fulfill({ status: 200, body: 'ok' }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=nav-fixture`, { waitUntil: 'domcontentloaded' })
  const curtain = page.locator('[data-curtain]')
  await expect(curtain).toBeVisible({ timeout: 20000 })
  await curtain.click()
  await expect(curtain).toBeHidden()
}

test('viewer back returns to the library and unmounts the stage', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openApp(page)
  await expect(page.locator('.viewer-stage')).toBeVisible()

  // The in-viewer back affordance is the top bar's Library pill.
  await showChrome(page)
  await page.locator('[data-chrome-library]').click()

  await expect(page.locator('.viewer-stage')).toHaveCount(0)
  // The library surface is back — the signed-out landing renders.
  await expect(page.locator('.native-landing, .native-account, .landing-page').first()).toBeVisible()
})

test('a Global View same-gallery jump remounts the Viewer exactly once', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.addInitScript(() => localStorage.setItem('CapacitorStorage.manorama.global-view', 'on'))
  await openApp(page)

  const stage = page.locator('.viewer-stage')
  await page.evaluate(() => { (document.querySelector('.viewer-stage') as HTMLElement & { __id?: string }).__id = 'first-mount' })
  await page.locator('.stage-seq').click()
  const grid = page.locator('[data-global-view]')
  await expect(grid).toBeVisible({ timeout: 15000 })
  await page.locator('[data-grid-frame]').nth(10).click()
  await expect(grid).toHaveCount(0)
  // Same gallery: one remount — the identity marker must be gone but the
  // stage is still there.
  await expect(stage).toBeVisible()
  expect(await page.evaluate(() => (document.querySelector('.viewer-stage') as HTMLElement & { __id?: string }).__id)).toBeUndefined()
  await expect(page.locator('.viewer-stage')).toHaveCount(1)
})

test('the reorder editor opens and closes back onto the library', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // SecureStorage's web fallback reads prefixed localStorage keys — the same
  // shape the unit suite seeds — so the shell boots signed-in with an owner
  // slug and the gallery card exposes its reorder button.
  await page.addInitScript(() => {
    localStorage.setItem('capacitor-storage_manorama.session-token', 'session-token-1')
    localStorage.setItem('capacitor-storage_manorama.owner-slug', 'fixture')
  })
  await page.route(apiPattern, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: payload }))
  await page.route('**/manorama.xyz*', (route) => route.fulfill({ status: 200, body: 'ok' }))
  await page.route('**/api/galleries', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ galleries: [{ slug: 'nav-fixture', title: 'Nav fixture', caption: '', date: '2026-10-28', imageCount: 30, images: [photo(0)] }] }) }))
  await page.route('**/api/device-galleries', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.goto(`${nativeUrl}/`, { waitUntil: 'domcontentloaded' })
  // The card menu holds the reorder action — a signed-in fixture makes it
  // reachable, so this test exercises the editor instead of skipping.
  await page.locator('.lib-card-menu').first().click()
  await page.getByRole('menuitem', { name: 'Reorder photographs' }).click()
  const editor = page.locator('[data-gallery-editor]')
  await expect(editor).toBeVisible()
  await editor.locator('[aria-label="Close the editor"]').click()
  await expect(editor).toHaveCount(0)
  await expect(page.locator('.native-gallery-list')).toBeVisible()
})
