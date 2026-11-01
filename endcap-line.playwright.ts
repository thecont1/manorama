import { expect, test, type BrowserContext } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5174'

const png = (id: string) => ({ id, filename: `${id}.png`, src: '/favicon.ico', width: 4, height: 3, alt: id })

const signInRetention = async (context: BrowserContext) => {
  const login = await context.request.get(`${base}/.dev-seed/login?account=dbid:AAATESTretention`, { maxRedirects: 0 })
  expect(login.status()).toBe(302)
}

test('"The End." renders on a single line', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signInRetention(context)
  const spawn = await context.request.post(`${base}/.dev-seed/spawn`, {
    data: { accountId: 'dbid:AAATESTretention', galleries: [{ slug: 'endcap-line', images: [png('a'), png('b'), png('c')] }] },
  })
  expect(spawn.status()).toBe(200)
  const page = await context.newPage()
  try {
    await page.goto(`${base}/retention-qa/endcap-line`, { waitUntil: 'domcontentloaded' })
    const curtain = page.locator('[data-curtain]')
    await curtain.click({ timeout: 20_000 })
    await expect(curtain).toBeHidden({ timeout: 10_000 })
    await page.keyboard.press('End')
    await page.waitForTimeout(1400)
    await page.keyboard.press('ArrowRight')
    const endcap = page.locator('[data-endcard]')
    await expect(endcap).toBeVisible({ timeout: 10_000 })

    const line = endcap.locator('.endcap-line')
    await expect(line).toHaveText('The End.')
    const box = await line.boundingBox()
    const fontSize = await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    // One line: the span's height is a single line box, not a wrapped stack.
    expect(box!.height).toBeLessThan(fontSize * 1.6)
    await page.screenshot({ path: 'outputs/endcap-single-line.png' })
  } finally {
    await context.close().catch(() => {})
  }
})
