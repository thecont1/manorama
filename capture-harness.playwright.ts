import { test, expect } from '@playwright/test'

const base = process.env.CAPTURE_URL
// One server owns a state slot, just like one simulator capture run.
test.describe.configure({ mode: 'serial' })
test.beforeEach(() => test.skip(!base, 'CAPTURE_URL is required'))

for (const viewport of [{ width: 375, height: 812 }, { width: 1376, height: 1032 }, { width: 1440, height: 900 }]) {
  for (const state of [0, 1, 2, 3, 4]) {
    test(`${viewport.width} capture state ${state} reaches its real UI`, async ({ page, request }) => {
      test.setTimeout(90000)
      await page.setViewportSize(viewport)
      const picked = await request.get(`${base}/state/${state}`)
      const { generation } = await picked.json()
      await page.goto(`${base}/?owner=thecontrarian&slug=italy`)
      await expect.poll(async () => (await (await request.get(`${base}/__capture/report`)).json())?.ready, { timeout: 75000 }).toBe(true)
      const report = await (await request.get(`${base}/__capture/report`)).json()
      expect(report.state).toBe(state)
      expect(report.generation).toBe(generation)
      if (state === 0) await expect(page.locator('[data-curtain]')).toBeVisible()
      if (state === 1) {
        await expect(page.locator('[data-curtain]')).toBeHidden()
        await expect(page.locator('[data-stage] img.frame-img').first()).toBeVisible()
      }
      if (state === 2) await expect(page.getByRole('dialog', { name: 'Display settings' })).toBeVisible()
      if (state === 3) {
        const input = page.getByLabel('Public Dropbox, Google Drive, iCloud, or MEGA link', { exact: true })
        await expect(input).toBeInViewport()
        await input.fill('https://mega.nz/folder/example#preserve-fragment')
        await page.getByRole('button', { name: 'Manorama-fy it!' }).click()
        await expect(page.locator('[data-curtain]')).toBeVisible()
        expect(await page.evaluate(() => (window as unknown as { __captureImport: unknown }).__captureImport)).toEqual({ url: 'https://mega.nz/folder/example#preserve-fragment', quick: true })
      }
      if (state === 4) await expect(page.locator('[data-grid-frame]')).toHaveCount(22)
      const stale = await request.post(`${base}/__capture/report`, { data: { state, generation: generation - 1, ready: true } })
      expect(stale.status()).toBe(409)
    })
  }
}

test('missing assets are errors, never a 200 HTML shell', async ({ request }) => {
  expect((await request.get(`${base}/assets/missing.js`)).status()).toBe(404)
})
