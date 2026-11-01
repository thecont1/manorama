import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5174'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'

const signIn = async (context: BrowserContext) => {
  await expect.poll(async () => {
    const login = await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })
    return login.status()
  }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
}

const openReorder = async (page: Page, slug: string) => {
  await page.goto(`${base}/${owner}?details=${slug}`, { waitUntil: 'domcontentloaded' })
  const details = page.locator('[data-screen="details"]')
  await expect(details).toBeVisible({ timeout: 20_000 })
  await details.getByRole('button', { name: 'Reorder photographs' }).click()
  await expect(page.locator('[data-screen="reorder"]')).toBeVisible({ timeout: 10_000 })
}

const clickMark = async (page: Page, index: number) => {
  const item = page.locator('.web-reorder-item').nth(index)
  const mark = item.locator('.web-reorder-hide')
  await item.hover()
  await expect(async () => expect(await mark.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)).toPass({ timeout: 5_000 })
  await mark.click()
}

test('a hidden photograph is marked hidden in the Library strip', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    const slug = (await page.locator('[data-gallery-card]').first().getAttribute('data-gallery-card'))!

    // The seed's state persists between runs — start from a clean slate by
    // un-hiding anything a previous pass hid, then save.
    await openReorder(page, slug)
    const showMarks = page.locator('.web-reorder-hide[aria-label^="Show"]')
    while (await showMarks.count() > 0) {
      const index = await showMarks.first().evaluate((el) => {
        const items = [...document.querySelectorAll('.web-reorder-item')]
        return items.indexOf(el.closest('.web-reorder-item')!)
      })
      await clickMark(page, index)
    }
    const save = page.getByRole('button', { name: 'Save' })
    if (await save.isEnabled()) {
      await save.click()
      await expect(page.locator('[data-screen="reorder"]')).toHaveCount(0, { timeout: 10_000 })
      await openReorder(page, slug)
    }

    // Hide the first two photographs and save.
    await clickMark(page, 0)
    await clickMark(page, 1)
    await save.click()
    await expect(page.locator('[data-screen="reorder"]')).toHaveCount(0, { timeout: 10_000 })

    // Back on the Library rail the two items carry is-hidden + the chip.
    const card = page.locator(`[data-gallery-card="${slug}"]`)
    await expect(card.locator('.admin-gallery-strip-item.is-hidden')).toHaveCount(2)
    await expect(card.locator('.admin-strip-badge--hidden')).toHaveCount(2)
    const first = card.locator('.admin-gallery-strip-item.is-hidden').first()
    await expect(async () => {
      expect(await first.locator('img').evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(0.32)
    }).toPass({ timeout: 5_000 })
    await page.screenshot({ path: 'outputs/library-hidden-strip.png' })
  } finally {
    await context.close().catch(() => {})
  }
})
