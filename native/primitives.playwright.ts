import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/** P1 redesign primitives, exercised on the specimen page the native fixture
 *  server mounts at /specimen.html. Dark and light owner themes, phone and
 *  desktop widths. The page itself is dev-only — nothing here ships. */

const nativeUrl = process.env.NATIVE_GALLERY_URL
if (!nativeUrl) throw new Error('NATIVE_GALLERY_URL is required for the primitives spec')
const specimen = `${nativeUrl}/specimen.html`

const openSpecimen = async (page: Page, theme: 'dark' | 'light') => {
  await page.goto(`${specimen}?theme=${theme}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.m-owner')).toBeVisible()
}

for (const viewport of [
  { name: 'phone-375x812', width: 375, height: 812 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test('specimen renders all primitives, axe-clean', async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await openSpecimen(page, theme)
        await expect(page.locator('.m-topbar-logo')).toBeVisible()
        await expect(page.locator('.m-btn--primary').first()).toBeVisible()
        await expect(page.locator('[role="radiogroup"]')).toBeVisible()
        await expect(page.locator('[role="meter"]').first()).toBeVisible()
        await expect(page.locator('[role="switch"]')).toBeVisible()
        const results = await new AxeBuilder({ page }).include('.m-owner').analyze()
        expect(results.violations).toEqual([])
      })
    })
  }
}

test('every actionable target is at least 44x44', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openSpecimen(page, 'dark')
  const controls = page.locator('.m-owner button, .m-owner a, .m-owner [role="switch"], .m-owner [role="radio"]')
  const count = await controls.count()
  expect(count).toBeGreaterThan(5)
  for (let i = 0; i < count; i += 1) {
    const box = await controls.nth(i).boundingBox()
    if (!box) continue
    expect(box.width, `control ${i} width`).toBeGreaterThanOrEqual(44)
    expect(box.height, `control ${i} height`).toBeGreaterThanOrEqual(44)
  }
})

test('sheet: focus lands on the heading, Tab cycles within, Escape closes top first, focus returns', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openSpecimen(page, 'dark')
  const opener = page.getByRole('button', { name: 'Open half sheet' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Add a gallery' })
  await expect(dialog).toBeVisible()
  // Initial focus is the heading (tabindex=-1), never the input.
  await expect(dialog.locator('h2')).toBeFocused()
  // Background is inert while the sheet is open.
  expect(await page.locator('#app').evaluate((n) => (n as HTMLElement).inert)).toBe(true)
  // Tab cycles inside the sheet.
  await page.keyboard.press('Tab')
  const inside = await page.evaluate(() => document.querySelector('.m-sheet')!.contains(document.activeElement))
  expect(inside).toBe(true)
  // Nested sheet opens from the pinned footer; Escape closes it first.
  await dialog.getByRole('button', { name: 'Add gallery' }).click()
  const nested = page.getByRole('dialog', { name: 'Remove this gallery?' })
  await expect(nested).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(nested).toBeHidden()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('half sheet keeps its pinned footer inside a short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 500 })
  await openSpecimen(page, 'dark')
  await page.getByRole('button', { name: 'Open half sheet' }).click()
  await expect(page.locator('.m-sheet')).not.toHaveClass(/m-sheet--entering/)
  const footer = page.getByRole('button', { name: 'Add gallery' })
  await expect(footer).toBeVisible()
  // The slide-up transition takes 240ms — measure where it lands, not mid-flight.
  await expect.poll(async () => {
    const box = await footer.boundingBox()
    return box ? box.y + box.height : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(500)
})

test('reduced motion: the sheet animates opacity only, no transform', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openSpecimen(page, 'dark')
  await page.getByRole('button', { name: 'Open half sheet' }).click()
  await expect(page.getByRole('dialog', { name: 'Add a gallery' })).toBeVisible()
  await expect(page.locator('.m-sheet')).not.toHaveClass(/m-sheet--entering/)
  const transform = await page.locator('.m-sheet').evaluate((n) => getComputedStyle(n).transform)
  // Under reduced motion the element sits at translateY(0) — an identity
  // transform, never a translate of the sheet itself.
  expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform)
})

test('theme toggle persists across reload and html.light applies before paint', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const page = await context.newPage()
  await page.goto(specimen, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await page.reload({ waitUntil: 'domcontentloaded' })
  expect(await page.evaluate(() => localStorage.getItem('manorama:theme'))).toBe('light')
  await expect(page.locator('html')).toHaveClass(/light/)
  await context.close()
})

test('html.light is applied by theme-init.js before first paint', async ({ browser }) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    try { localStorage.setItem('manorama:theme', 'light') } catch { /* ignore */ }
    ;(window as unknown as { __themeAtDCL: unknown }).__themeAtDCL = null
    document.addEventListener('DOMContentLoaded', () => {
      (window as unknown as { __themeAtDCL: unknown }).__themeAtDCL = document.documentElement.classList.contains('light')
    })
  })
  const page = await context.newPage()
  await page.goto(specimen, { waitUntil: 'domcontentloaded' })
  expect(await page.evaluate(() => (window as unknown as { __themeAtDCL: unknown }).__themeAtDCL)).toBe(true)
  await context.close()
})
