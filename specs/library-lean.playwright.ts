import { expect, test, type APIRequestContext } from '@playwright/test'

const base = 'http://localhost:5174'
const owner = 'thecontrarian'
const ownerId = 'dbid:AAATESTowner1'
const freeOwner = 'retention-qa'
const freeId = 'dbid:AAATESTretention'

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const pixel = (id: string) => ({ id, filename: `${id}.png`, src: PIXEL, width: 1, height: 1, alt: '', c2pa: false, placeholder: PIXEL })
const spawn = (request: APIRequestContext, galleries: { slug: string; createdAt: string; images: unknown[]; pinned?: boolean }[], accountId = ownerId) =>
  request.post(`${base}/.dev-seed/spawn`, { data: { accountId, galleries } })
const make = (count: number, items: number, prefix: string, pinned = false) =>
  Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}-${index}`,
    createdAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    images: Array.from({ length: items }, (_, item) => pixel(`${prefix}-${index}-${item}`)),
    pinned,
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
    // Nothing spawned is pinned: every lean-* gallery is a compact card
    // under "Cloud galleries" — "Pinned galleries" holds only pins (the
    // pristine fixtures arrive pinned, so assert by prefix).
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(0)
    await expect(page.locator('.lib-compact-card[data-gallery-card^="lean-"]')).toHaveCount(11)
    // Section titles are collapse toggles (buttons), not headings.
    await expect(page.getByRole('button', { name: /Cloud galleries/ })).toBeVisible()
    const pristineStrips = await strips.count()
    const pinnedSection = page.locator('section[aria-labelledby="lib-strips-title"]')

    // Pin the newest compact card — it gains a strip in "Pinned galleries"
    // while its compact card stays put, and a second pin joins it:
    // Visionary pins any number, nothing is evicted.
    const leanCards = page.locator('.lib-compact-card[data-gallery-card^="lean-"]')
    const firstCard = leanCards.first()
    const secondCard = leanCards.nth(1)
    const firstSlug = (await firstCard.getAttribute('data-gallery-card'))!
    const secondSlug = (await secondCard.getAttribute('data-gallery-card'))!
    for (const slug of [firstSlug, secondSlug]) {
      await page.locator(`.lib-compact-card[data-gallery-card="${slug}"]`).getByRole('button', { name: /actions$/ }).click()
      await page.getByRole('button', { name: 'Pin gallery' }).click()
      await expect(page.locator('.admin-toast')).toContainText('pinned', { timeout: 15_000 })
    }
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(2)
    await expect(strips).toHaveCount(pristineStrips + 2)
    // Each pinned gallery now has two faces: the strip in "Pinned
    // galleries" and its compact card back in "Cloud galleries".
    await expect(pinnedSection.locator(`[data-gallery-card="${firstSlug}"]`)).toBeVisible()
    await expect(pinnedSection.locator(`[data-gallery-card="${secondSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${firstSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${secondSlug}"]`)).toBeVisible()
    await expect(page.locator('.lib-compact-card[data-gallery-card^="lean-"]')).toHaveCount(11)
    await expect(page.getByRole('button', { name: /Pinned galleries/ })).toBeVisible()

    // Unpin removes the strip — the home card was never gone, so nothing
    // moves back; it is still permanent for a paid account.
    await page.locator(`.lib-card[data-gallery-card="${firstSlug}"]`).getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Unpin gallery' }).click()
    await expect(page.locator('.admin-toast')).toContainText('unpinned', { timeout: 15_000 })
    await expect(pinnedSection.locator(`[data-gallery-card="${firstSlug}"]`)).toHaveCount(0)
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${firstSlug}"]`)).toBeVisible()
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(1)
    await context.close()
  })

  test('a free library strips the pinned set and the stopwatch swaps permanence', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      // Three retained galleries pinned into strips, two pipeline cards —
      // and every one of the five keeps a compact card under "Cloud
      // galleries", pinned or not.
      await spawn(context.request, [...make(3, 1, 'freeq', true), ...make(2, 1, 'freeq-temp')], freeId)
      await context.request.get(`${base}/.dev-seed/login?account=${freeId}`, { maxRedirects: 0 })
      await page.goto(`${base}/${freeOwner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      // Three strips plus five home cards — every gallery lists twice
      // once pinned, so the prefix matches eight cards.
      await expect(page.locator('[data-gallery-card^="freeq-"]')).toHaveCount(8, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('.admin-gallery-strip-frame')).toHaveCount(3)
    await expect(page.locator('.lib-compact-card')).toHaveCount(5)
    await expect(page.getByRole('button', { name: /Pinned galleries/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Cloud galleries/ })).toBeVisible()
    const pinnedSection = page.locator('section[aria-labelledby="lib-strips-title"]')

    // The stopwatch on a temporary card opens the keep/swap sheet — the
    // expiry in days, the Visionary path, and one Swap row per permanent
    // gallery in the quota. Pinned retained cards lead the compact grid,
    // so pick the pipeline card by its retention marker, not by position.
    const tempCard = page.locator('.lib-compact-card[data-retention="pipeline"]').first()
    const tempSlug = (await tempCard.getAttribute('data-gallery-card'))!
    const victimSlug = (await page.locator('.lib-card').first().getAttribute('data-gallery-card'))!
    await tempCard.locator('.lib-temp-flag').click()
    const chooser = page.getByRole('dialog')
    await expect(chooser).toBeVisible()
    await expect(chooser).toContainText('temporary gallery')
    await expect(chooser).toContainText('expires in')
    await expect(chooser.getByRole('link', { name: 'Upgrade' })).toBeVisible()
    await expect(chooser.locator('.lib-pin-choice-list li')).toHaveCount(4)

    // One tap swaps permanence, position and expiry — the temp takes
    // the victim's strip slot, the victim takes the temp's clock.
    await chooser.locator('.lib-pin-choice-list li', { hasText: victimSlug }).getByRole('button', { name: 'Swap' }).click()
    await expect(page.locator('.admin-toast')).toContainText('permanent', { timeout: 15_000 })
    await expect(page.locator(`.lib-card[data-gallery-card="${tempSlug}"]`)).toBeVisible()
    await expect(pinnedSection.locator(`[data-gallery-card="${tempSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${victimSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${victimSlug}"]`)).toContainText('Temporary')
    await context.close()
  })

  test('a strip rail ships every item; compact cards ship one cover', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await expect(async () => {
      await context.request.post(`${base}/.dev-seed/reset`)
      // Three pinned strip galleries of 50 plus six compact covers: the
      // strips ship every item, the covers ship exactly one. Each pinned
      // gallery also keeps its compact home card, so nine galleries are
      // twelve cards on the page.
      await spawn(context.request, [...make(3, 50, 'bulk', true), ...make(6, 50, 'rest')])
      await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
      await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-gallery-card^="bulk-"], [data-gallery-card^="rest-"]')).toHaveCount(12, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('.lib-card[data-gallery-card^="bulk-"]')).toHaveCount(3)
    await expect(page.locator('.lib-card[data-gallery-card="bulk-0"]').locator('.admin-gallery-strip-item')).toHaveCount(50)
    await expect(page.locator('.admin-strip-more')).toHaveCount(0)
    // The pinned three keep compact covers back in "Cloud galleries" too.
    await expect(page.locator('.lib-compact-card[data-gallery-card^="bulk-"]')).toHaveCount(3)
    await expect(page.locator('.lib-compact-card[data-gallery-card^="rest-"]')).toHaveCount(6)
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
      // Unpin whatever the fixture pinned so every gallery on the page is
      // a compact cover — the leanest the payload can ever be.
      const library = await (await context.request.get(`${base}/api/library`)).json() as { galleries?: { slug: string; pinnedAt: string | null }[] }
      for (const gallery of (library.galleries ?? []).filter((item) => item.pinnedAt)) {
        await context.request.patch(`${base}/api/galleries/${gallery.slug}/pin`, { data: { pinned: false }, headers: { 'Content-Type': 'application/json' } })
      }
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
    // Serialized island props carry one cover per compact gallery — no
    // gallery ships its manifest. A few covers ride along for the pristine
    // provider galleries, whose count varies with the environment.
    const propItems = (html.match(/&quot;filename&quot;/g) ?? []).length
    console.log(`prop items: ${propItems}`)
    expect(propItems).toBeLessThanOrEqual(99 + 20)
    await context.close()
  })
})
