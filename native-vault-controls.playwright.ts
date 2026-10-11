import { test, expect } from '@playwright/test'
const base = process.env.CAPTURE_URL ?? 'http://localhost:4182'
test.describe.configure({ mode: 'serial' })
for (const viewport of [{ width: 375, height: 812 }, { width: 1376, height: 1032 }, { width: 1440, height: 900 }]) {
  test(`${viewport.width}: native picker works before caching and controls return to account`, async ({ browser, request }) => {
    test.setTimeout(75000)
    const context = await browser.newContext({ viewport })
    await request.get(`${base}/state/3`)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.native-gallery-row-with-thumb').first()).toBeVisible({ timeout: 30000 })
    await expect(page.locator('main .native-load-policy')).toHaveCount(0)
    await expect(page.locator('main .native-house-cards')).toHaveCount(0)
    await expect(page.locator('.native-gallery-thumb.is-active')).toHaveCount(0)
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    if (viewport.width < 820) await expect(menu.locator('.native-account-hamburger')).toBeVisible()
    await expect.poll(() => page.locator('.native-gallery-thumb img').first().evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0), { timeout: 15000 }).toBe(true)
    // The actions belong to the copy column, so they sit beside the cover
    // instead of under the whole card. Whichever edge the cover takes, the
    // actions take the other, which is what keeps four actions and a
    // photograph on one phone screen. Alternation between cards is covered by
    // the account unit tests, whose fixture holds more than one gallery.
    const cards = page.locator('.native-gallery-list > li')
    const cardCount = await cards.count()
    expect(cardCount).toBeGreaterThan(0)
    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index)
      const cover = (await card.locator('.native-gallery-cover-row').boundingBox())!
      const actions = (await card.locator('.native-gallery-actions').boundingBox())!
      expect(actions.y, `card ${index} keeps its actions inside the card`).toBeGreaterThanOrEqual(cover.y - 1)
      const flipped = ((await card.getAttribute('class')) ?? '').includes('is-cover-right')
      if (flipped) expect(actions.x + actions.width, `card ${index} puts its actions left of a right-hand cover`).toBeLessThanOrEqual(cover.x + 1)
      else expect(actions.x, `card ${index} puts its actions right of a left-hand cover`).toBeGreaterThanOrEqual(cover.x + cover.width - 1)
    }
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-admin.png`, fullPage: true })
    await menu.click()
    const account = page.getByRole('dialog', { name: 'Account', exact: true })
    if (viewport.width < 820) {
      await expect.poll(async () => (await account.boundingBox())?.y ?? -999).toBeGreaterThanOrEqual(0)
      const bounds = await account.boundingBox()
      expect(bounds!.x).toBe(0)
      expect(bounds!.width).toBe(viewport.width)
      expect(bounds!.height).toBe(viewport.height)
    }
    await expect(account.locator('.native-load-policy')).toBeVisible()
    await expect(account.locator('.native-house-cards')).toBeVisible()
    await expect.poll(async () => (await account.boundingBox())?.x ?? -999).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-account.png`, fullPage: false })
    await page.getByRole('button', { name: 'Close account menu', exact: true }).click()
    await page.locator('.native-gallery-row-with-thumb').first().click()
    const curtain = page.locator('[data-curtain]')
    await expect(curtain).toBeVisible()
    await expect.poll(async () => {
      if (await curtain.isHidden()) return true
      await curtain.click({ timeout: 2000 }).catch(() => {})
      return curtain.isHidden()
    }, { timeout: 20000 }).toBe(true)
    await page.locator('button.control-logo').click()
    const dialog = page.getByRole('dialog', { name: 'Display settings' })
    await expect(dialog).toBeVisible()
    const stream = page.getByLabel('Don’t download this gallery', { exact: true })
    await expect(stream).not.toBeChecked()
    await stream.check()
    await expect(stream).toBeChecked()
    await expect(page.getByRole('status').filter({ hasText: 'Streaming from cloud' })).toBeVisible()
    await page.getByRole('button', { name: 'Close display settings', exact: true }).click()
    await page.keyboard.press('g')
    const picker = page.locator('[data-global-view]')
    await expect(picker).toBeVisible()
    await expect(picker.locator('[data-grid-frame]').first()).toBeVisible()
    await expect(picker).not.toContainText('still settling')
    await page.getByRole('button', { name: 'Close photo picker', exact: true }).click()
    await page.locator('button.control-logo').click()
    await page.getByRole('button', { name: 'Back to your galleries', exact: true }).click()
    await expect(page.locator('.native-account-overview')).toBeVisible()
    await expect(page.locator('[data-stage]')).toHaveCount(0)
    expect(errors).toEqual([])
    await context.close()
  })
}
