import { expect, test, type APIRequestContext } from '@playwright/test'

const base = 'http://localhost:5174'
const owner = 'thecontrarian'
const ownerId = 'dbid:AAATESTowner1'
const freeOwner = 'retention-qa'
const freeId = 'dbid:AAATESTretention'

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const pixel = (id: string) => ({ id, filename: `${id}.png`, src: PIXEL, width: 1, height: 1, alt: '', c2pa: false, placeholder: PIXEL })
const spawn = (request: APIRequestContext, galleries: { slug: string; createdAt: string; images: unknown[] }[], accountId = ownerId) =>
  request.post(`${base}/.dev-seed/spawn`, { data: { accountId, galleries } })
const make = (count: number, items: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}-${index}`,
    createdAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    images: Array.from({ length: items }, (_, item) => pixel(`${prefix}-${index}-${item}`)),
  }))

test.describe('the lean Library', () => {
  test('a Visionary library keeps ten strips then compact rows, and pins repartition', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.request.post(`${base}/.dev-seed/reset`)
    await spawn(context.request, make(11, 1, 'lean'))
    await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
    const page = await context.newPage()
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })

    const strips = page.locator('.admin-gallery-strip-frame')
    const rows = page.locator('.lib-compact-row')
    await expect(strips).toHaveCount(10)
    const total = await page.locator('[data-gallery-card]').count()
    expect(total).toBeGreaterThanOrEqual(11)
    await expect(rows).toHaveCount(total - 10)
    await expect(page.getByRole('heading', { name: 'More galleries' })).toBeVisible()

    // Pin the newest compact row — it enters the strips; the eldest strip
    // drops to compact.
    const firstRow = rows.first()
    const pinnedSlug = (await firstRow.getAttribute('data-gallery-card'))!
    const eldestStripSlug = (await page.locator('.lib-card[data-gallery-card]').nth(9).getAttribute('data-gallery-card'))!
    await firstRow.getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Pin to top' }).click()
    await expect(page.locator('.admin-toast')).toContainText('pinned to top', { timeout: 15_000 })
    await expect(page.locator(`.admin-gallery-strip-frame >> nth=9`)).toHaveCount(1)
    await expect(page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`).getByLabel('Pinned')).toBeVisible()
    await expect(page.locator(`.lib-compact-row[data-gallery-card="${eldestStripSlug}"]`)).toBeVisible()

    // Unpin restores the previous partition.
    await page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`).getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Unpin' }).click()
    await expect(page.locator('.admin-toast')).toContainText('unpinned', { timeout: 15_000 })
    await expect(page.locator(`.lib-compact-row[data-gallery-card="${pinnedSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${eldestStripSlug}"]`)).toBeVisible()
    await context.close()
  })

  test('a free library strips only retained galleries under Temporary, with no pin', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.request.post(`${base}/.dev-seed/reset`)
    await spawn(context.request, make(5, 1, 'freeq'), freeId)
    await context.request.get(`${base}/.dev-seed/login?account=${freeId}`, { maxRedirects: 0 })
    const page = await context.newPage()
    await page.goto(`${base}/${freeOwner}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.admin-gallery-strip-frame')).toHaveCount(3)
    await expect(page.locator('.lib-compact-row')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Temporary galleries' })).toBeVisible()
    // Pinning is a Visionary surface — no menu offers it on the free plan.
    await page.locator('.lib-card').first().getByRole('button', { name: /actions$/ }).click()
    await expect(page.getByRole('button', { name: 'Pin to top' })).toHaveCount(0)
    await context.close()
  })

  test('the Library payload stays lean at 99 galleries × 50 items', async ({ browser }) => {
    const context = await browser.newContext()
    await context.request.post(`${base}/.dev-seed/reset`)
    const spawned = await (await spawn(context.request, make(99, 50, 'bulk'))).json() as { results: { ok: boolean }[] }
    expect(spawned.results.filter((result) => result.ok).length).toBeGreaterThanOrEqual(90)
    await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
    const response = await context.request.get(`${base}/${owner}`)
    expect(response.status()).toBe(200)
    const html = await response.text()
    const bytes = Buffer.byteLength(html)
    console.log(`library html: ${(bytes / 1024).toFixed(1)} KB`)
    expect(bytes).toBeLessThan(400 * 1024)
    // Serialized island props carry at most 10×12 rail items + one cover per
    // compact gallery — the whole manifest no longer ships.
    const propItems = (html.match(/&quot;filename&quot;/g) ?? []).length
    console.log(`prop items: ${propItems}`)
    expect(propItems).toBeLessThanOrEqual(10 * 12 + 89)
    await context.close()
  })
})
