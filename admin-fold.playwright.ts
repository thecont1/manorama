import { test, expect } from '@playwright/test'
const base = process.env.GALLERY_URL ?? 'http://localhost:5173'
const capture = process.env.CAPTURE_URL ?? 'http://localhost:4182'
for (const mode of ['web', 'native'] as const) {
  test(`${mode}: account controls stay off a vertical hinge and settings survives a segment change`, async ({ page, context, request }) => {
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
      // ?tier= feeds the harness's billing seam — the sponsored slot only
      // renders for a resolved entitlement.
      await page.goto(`${capture}?tier=free`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.native-account')).toBeVisible()
    }
    const main = page.locator(mode === 'web' ? '.admin-page' : '.native-account-shell')
    await expect(main).toHaveAttribute('data-admin-segmented', /^(true)?$/)
    // The Library's own panels must not straddle the hinge.
    const sponsored = page.locator(mode === 'web' ? '.account-ad' : '.native-account-ad')
    await expect(sponsored).toBeVisible()
    const sponsoredBox = (await sponsored.boundingBox())!
    expect(sponsoredBox!.x + sponsoredBox!.width <= 520 || sponsoredBox!.x >= 580).toBe(true)
    const gear = page.getByRole('button', { name: 'Settings', exact: true })
    await gear.click()
    const settings = page.locator(mode === 'web' ? '.web-settings' : '.native-settings')
    await expect(settings).toBeVisible()
    // The pushed settings surface survives a segment change.
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: mode === 'web' ? 'Back' : 'Back to the library', exact: true }).click()
    await expect(settings).toHaveCount(0)
  })
}
