import { expect, test, type Page } from '@playwright/test'

/**
 * P4 entry anchor. A nonzero ?photo= entry must stay docked when earlier
 * frames decode after the retired 150-frame reseed cap (about 2.5s at 60Hz).
 * The anchor follows the decode reflow, not a frame-count guess.
 */

const base = process.env.GALLERY_URL ?? 'http://localhost:5173'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'
const slug = process.env.GALLERY_SLUG ?? 'dev-dropbox'

const dismissCurtain = async (page: Page) => {
  const curtain = page.locator('[data-curtain]')
  if (!(await curtain.isVisible().catch(() => false))) return
  await expect.poll(async () => {
    if (await curtain.isHidden().catch(() => true)) return true
    await curtain.click({ timeout: 2_000 }).catch(() => {})
    return curtain.isHidden().catch(() => true)
  }, { timeout: 30_000, intervals: [500] }).toBe(true)
}

test('a slow decode after the old reseed cap still docks the entered photograph', async ({ page }) => {
  test.setTimeout(90_000)
  const probe = await page.request.get(`${base}/${owner}/${slug}`)
  test.skip(probe.status() !== 200, 'seeded gallery is not reachable')
  const ids = [...(await probe.text()).matchAll(/data-image-id="([^"]+)"/g)].map((match) => match[1])
  const unique = [...new Set(ids)]
  test.skip(unique.length < 3, 'need at least three photographs')
  const entry = unique[2]
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'image' && !route.request().url().includes('logo')) await gate
    await route.continue()
  })
  await page.goto(`${base}/${owner}/${slug}?photo=${encodeURIComponent(entry)}`, { waitUntil: 'domcontentloaded' })
  await dismissCurtain(page)
  const sequence = page.locator('.stage-seq')
  await expect(sequence).toBeVisible({ timeout: 15_000 })
  await expect(sequence).toContainText('3')
  // Longer than the retired 150-frame cap, while the earlier frames are still withheld.
  await page.waitForTimeout(4_000)
  await expect(sequence).toContainText('3')
  release()
  await expect(page.locator(`[data-image-id="${entry}"]`).first()).toBeVisible({ timeout: 20_000 })
  await expect(sequence).toContainText('3')
})
