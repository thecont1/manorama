import { expect, type Page } from '@playwright/test'

/** Summons the temporary viewer chrome the way visitors do — a stage
 *  tap — falling back to the skip button when the tap can't land
 *  (e.g. the stage is covered by an overlay the test opened). Waits for
 *  the bottom bar to report visible so callers can click straight on. */
export const showChrome = async (page: Page) => {
  const bottom = page.locator('[data-chrome-bottom]')
  if ((await bottom.count()) === 0 || !(await bottom.evaluate((el) => el.classList.contains('is-visible')).catch(() => false))) {
    const stage = page.locator('.viewer-stage')
    const box = await stage.boundingBox().catch(() => null)
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }
  if (!(await bottom.evaluate((el) => el.classList.contains('is-visible')).catch(() => false))) {
    await page.locator('.m-chrome-skip').evaluate((el: HTMLElement) => el.click())
  }
  await expect(bottom).toHaveClass(/is-visible/, { timeout: 10000 })
}
