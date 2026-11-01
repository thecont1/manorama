import { expect, test, type BrowserContext } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5174'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'

const signIn = async (context: BrowserContext) => {
  await expect.poll(async () => {
    const login = await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })
    return login.status()
  }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
}

test('Details deep link reaches Reorder without leaving the dashboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    // Discover a slug, then land on the ?details= URL exactly the way the
    // viewer's details navigation does — a fresh load whose only history
    // entry IS the details surface.
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    const slug = (await page.locator('[data-gallery-card]').first().getAttribute('data-gallery-card'))!

    await page.goto(`${base}/${owner}?details=${slug}`, { waitUntil: 'domcontentloaded' })
    const details = page.locator('[data-screen="details"]')
    await expect(details).toBeVisible({ timeout: 20_000 })

    await details.getByRole('button', { name: 'Reorder photographs' }).click()

    // The bug: history.back() walked to the entry before ?details= and the
    // dashboard unloaded. Now the reorder screen must appear on the same page.
    await expect(page.locator('[data-screen="reorder"]')).toBeVisible({ timeout: 10_000 })
    await expect(details).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(`/${owner}`)
    expect(new URL(page.url()).searchParams.get('details')).toBeNull()

    // The overlay is fixed but the Library page's own scrollbar would sit
    // beside it — the body must not scroll while the reorder is up.
    expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).toBe('hidden')

    // Sizer layout: finite slider, layout toggle beside it in the same bar.
    const sizer = page.locator('.web-reorder-sizer')
    const range = sizer.locator('input[type="range"]')
    const views = sizer.locator('.web-reorder-views')
    await expect(views).toBeVisible()
    const rBox = (await range.boundingBox())!
    const vBox = (await views.boundingBox())!
    const sBox = (await sizer.boundingBox())!
    expect(rBox.width).toBeLessThan(400)
    expect(rBox.width).toBeGreaterThan(90)
    // Same row: vertical centres within a few px; toggle right of the slider.
    expect(Math.abs(rBox.y + rBox.height / 2 - (vBox.y + vBox.height / 2))).toBeLessThan(8)
    expect(vBox.x).toBeGreaterThan(rBox.x + rBox.width)
    // The bar no longer stretches the slider end to end.
    expect(rBox.width).toBeLessThan(sBox.width / 2)
    await page.screenshot({ path: 'outputs/reorder-sizer.png' })

    await context.close()
  } finally {
    await context.close().catch(() => {})
  }
})

test('?reorder=1 deep link lands inside the reorder overlay', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    const slug = (await page.locator('[data-gallery-card]').first().getAttribute('data-gallery-card'))!

    // The Settings popover's Reorder row emits ?details=&reorder=1 — the
    // details surface must hand straight off into the overlay.
    await page.goto(`${base}/${owner}?details=${slug}&reorder=1`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-screen="reorder"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-screen="details"]')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('reorder')).toBeNull()
    expect(new URL(page.url()).searchParams.get('details')).toBeNull()
  } finally {
    await context.close().catch(() => {})
  }
})

test('the hide mark surfaces on hover, conceals in draft, and writes on Save', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    const slug = (await page.locator('[data-gallery-card]').first().getAttribute('data-gallery-card'))!
    await page.goto(`${base}/${owner}?details=${slug}`, { waitUntil: 'domcontentloaded' })
    const details = page.locator('[data-screen="details"]')
    await expect(details).toBeVisible({ timeout: 20_000 })
    await details.getByRole('button', { name: 'Reorder photographs' }).click()
    await expect(page.locator('[data-screen="reorder"]')).toBeVisible({ timeout: 10_000 })

    const first = page.locator('.web-reorder-item').first()
    const mark = first.locator('.web-reorder-hide')
    // The mark is opacity-revealed (hover/tap/focus), not display-toggled —
    // assert the computed style rather than Playwright visibility.
    const markOpacity = () => mark.evaluate((el) => Number(getComputedStyle(el).opacity))
    expect(await markOpacity()).toBe(0)
    await first.hover()
    await expect(async () => expect(await markOpacity()).toBe(1)).toPass({ timeout: 5_000 })

    await mark.click()
    await expect(first).toHaveClass(/is-hidden/)
    await expect(mark).toHaveAttribute('aria-label', /^Show /)
    // Concealment alone dirties the draft — Save was disabled until now.
    const save = page.getByRole('button', { name: 'Save' })
    await expect(save).toBeEnabled()

    // The mark on a hidden cell is the way back — one tap restores it.
    await mark.click()
    await expect(first).not.toHaveClass(/is-hidden/)
    await expect(save).toBeDisabled()
    await page.screenshot({ path: 'outputs/reorder-hide.png' })
  } finally {
    await context.close().catch(() => {})
  }
})
