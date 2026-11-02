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
  test('a Visionary library keeps three strips then compact cards, and pins repartition', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    // Specs run in parallel against one in-memory store: a neighbouring
    // spec's reset can wipe the spawn mid-navigation, so the whole
    // seed-and-load retries until the galleries stay. Once rendered, the
    // DOM is immune to later resets.
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      await spawn(context.request, make(11, 1, 'lean'))
      await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
      await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      // The seed fixture keeps its live-provider galleries after every
      // reset — count the spawned prefix rather than the whole page.
      await expect(page.locator('[data-gallery-card^="lean-"]')).toHaveCount(11, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })

    const strips = page.locator('.admin-gallery-strip-frame')
    const cards = page.locator('.lib-compact-card')
    await expect(strips).toHaveCount(3)
    await expect(page.locator('.lib-compact-card[data-gallery-card^="lean-"]')).toHaveCount(8)
    await expect(page.getByRole('heading', { name: 'More galleries' })).toBeVisible()

    // Pin the newest compact card — it enters the strips; the eldest strip
    // drops to compact.
    const firstCard = cards.first()
    const pinnedSlug = (await firstCard.getAttribute('data-gallery-card'))!
    const eldestStripSlug = (await page.locator('.lib-card[data-gallery-card]').nth(2).getAttribute('data-gallery-card'))!
    await firstCard.getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Pin to top' }).click()
    await expect(page.locator('.admin-toast')).toContainText('pinned to top', { timeout: 15_000 })
    await expect(page.locator(`.admin-gallery-strip-frame >> nth=2`)).toHaveCount(1)
    await expect(page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`).getByLabel('Pinned')).toBeVisible()
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${eldestStripSlug}"]`)).toBeVisible()

    // Unpin restores the previous partition.
    await page.locator(`.lib-card[data-gallery-card="${pinnedSlug}"]`).getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Unpin' }).click()
    await expect(page.locator('.admin-toast')).toContainText('unpinned', { timeout: 15_000 })
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${pinnedSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${eldestStripSlug}"]`)).toBeVisible()
    await context.close()
  })

  test('a free library strips only retained galleries under Temporary, with no pin', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      await spawn(context.request, make(5, 1, 'freeq'), freeId)
      await context.request.get(`${base}/.dev-seed/login?account=${freeId}`, { maxRedirects: 0 })
      await page.goto(`${base}/${freeOwner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-gallery-card^="freeq-"]')).toHaveCount(5, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('.admin-gallery-strip-frame')).toHaveCount(3)
    await expect(page.locator('.lib-compact-card')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Temporary galleries' })).toBeVisible()
    // Pinning is a Visionary surface — no menu offers it on the free plan.
    await page.locator('.lib-card').first().getByRole('button', { name: /actions$/ }).click()
    await expect(page.getByRole('button', { name: 'Pin to top' })).toHaveCount(0)
    await context.close()
  })

  test('a strip rail ships every item; compact cards ship one cover', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      // Three strip galleries of 50 plus six compacts: 3×50 rail items and
      // 6 covers is the whole prop list — no "+N" tile, no hidden trim.
      await spawn(context.request, [...make(3, 50, 'bulk'), ...make(6, 50, 'rest')])
      await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
      await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-gallery-card^="bulk-"], [data-gallery-card^="rest-"]')).toHaveCount(9, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('.admin-gallery-strip-frame')).toHaveCount(3)
    await expect(page.locator('.lib-card').first().locator('.admin-gallery-strip-item')).toHaveCount(50)
    await expect(page.locator('.admin-strip-more')).toHaveCount(0)
    // The pristine provider galleries land in the compact list too, so the
    // page-level count varies with the environment — assert the spawned
    // prefixes instead: whichever three galleries the recency sort strips,
    // the other six spawned are exactly the compacts.
    await expect(page.locator('.lib-compact-card[data-gallery-card^="rest-"], .lib-compact-card[data-gallery-card^="bulk-"]')).toHaveCount(6)
    await context.close()
  })

  test('the Library payload stays lean at 99 galleries × 50 items', async ({ browser }) => {
    const context = await browser.newContext()
    let html = ''
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      const spawned = await (await spawn(context.request, make(99, 50, 'bulk'))).json() as { results: { ok: boolean }[] }
      expect(spawned.results.filter((result) => result.ok).length).toBeGreaterThanOrEqual(90)
      await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
      const response = await context.request.get(`${base}/${owner}`)
      expect(response.status()).toBe(200)
      html = await response.text()
      // A parallel reset landing between spawn and this fetch leaves only
      // the pristine fixtures in the markup — retry until the bulk slugs
      // actually rendered.
      expect(html).toContain('bulk-0')
    }).toPass({ timeout: 90_000 })
    const bytes = Buffer.byteLength(html)
    console.log(`library html: ${(bytes / 1024).toFixed(1)} KB`)
    expect(bytes).toBeLessThan(400 * 1024)
    // Serialized island props carry the 3 full rails plus one cover per
    // compact gallery — the whole manifest no longer ships. The pristine
    // provider galleries add up to 4 covers on top of the spawned 96.
    const propItems = (html.match(/&quot;filename&quot;/g) ?? []).length
    console.log(`prop items: ${propItems}`)
    expect(propItems).toBeLessThanOrEqual(3 * 50 + 100)
    await context.close()
  })
})
