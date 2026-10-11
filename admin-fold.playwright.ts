import { test, expect } from '@playwright/test'
const base = process.env.GALLERY_URL ?? 'http://localhost:5173'
const capture = process.env.CAPTURE_URL ?? 'http://localhost:4182'
for (const mode of ['web', 'native'] as const) {
  test(`${mode}: account controls stay off a vertical hinge and pane restores focus`, async ({ page, context, request }) => {
    test.setTimeout(50_000)
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.addInitScript(() => {
      Object.assign(window, { __MANORAMA_IOS_FOLD__: { horizontalSizeClass: 'regular', verticalSizeClass: 'regular', hinge: { axis: 'vertical', start: 520, size: 60 } } })
    })
    if (mode === 'web') {
      await expect.poll(async () => (await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })).status(), { timeout: 30_000 }).toBe(302)
      await page.goto(`${base}/thecontrarian`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready]')).toBeVisible()
    } else {
      expect((await request.get(`${capture}/state/3`)).ok()).toBe(true)
      await page.goto(capture, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.native-account')).toBeVisible()
    }
    const main = page.locator(mode === 'web' ? '.admin-page' : '.native-account-shell')
    await expect(main).toHaveAttribute('data-admin-segmented', /^(true)?$/)
    const left = await page.locator(mode === 'web' ? '.admin-welcome' : '.native-account-left').boundingBox()
    const right = await page.locator(mode === 'web' ? '.gallery-import' : '.native-gallery-import').boundingBox()
    expect(left!.x + left!.width).toBeLessThanOrEqual(520)
    expect(right!.x).toBeGreaterThanOrEqual(580)
    const tab = page.getByRole('button', { name: 'Account menu', exact: true })
    await tab.click()
    const panel = page.getByRole('dialog', { name: 'Account', exact: true })
    await expect(panel).toBeVisible()
    await page.waitForTimeout(350)
    const bounds = (await panel.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(520)
    await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(tab).toBeFocused()
    await tab.click()
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(tab).toBeFocused()
  })
}
