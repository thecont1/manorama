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
    const cards = page.locator('.lib-compact-card')
    // Nothing spawned is pinned: every lean-* gallery is a compact card
    // under "More galleries" — "Your galleries" holds only pins (the
    // pristine fixtures arrive pinned, so assert by prefix).
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(0)
    await expect(page.locator('.lib-compact-card[data-gallery-card^="lean-"]')).toHaveCount(11)
    await expect(page.getByRole('heading', { name: 'More galleries' })).toBeVisible()
    const pristineStrips = await strips.count()

    // Pin the newest compact card — it becomes a permanent strip, and a
    // second pin joins it: Visionary pins any number, nothing is evicted.
    const firstCard = cards.first()
    const secondCard = cards.nth(1)
    const firstSlug = (await firstCard.getAttribute('data-gallery-card'))!
    const secondSlug = (await secondCard.getAttribute('data-gallery-card'))!
    for (const slug of [firstSlug, secondSlug]) {
      await page.locator(`.lib-compact-card[data-gallery-card="${slug}"]`).getByRole('button', { name: /actions$/ }).click()
      await page.getByRole('button', { name: 'Pin to “Your galleries”' }).click()
      await expect(page.locator('.admin-toast')).toContainText('pinned', { timeout: 15_000 })
    }
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(2)
    await expect(strips).toHaveCount(pristineStrips + 2)
    await expect(page.locator(`.lib-card[data-gallery-card="${firstSlug}"]`).getByLabel('Pinned')).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${secondSlug}"]`)).toBeVisible()
    await expect(page.locator('.lib-compact-card[data-gallery-card^="lean-"]')).toHaveCount(9)
    await expect(page.getByRole('heading', { name: 'Your galleries' })).toBeVisible()

    // Unpin returns the card to "More galleries" — still permanent for a
    // paid account, just no longer a strip.
    await page.locator(`.lib-card[data-gallery-card="${firstSlug}"]`).getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Unpin gallery' }).click()
    await expect(page.locator('.admin-toast')).toContainText('unpinned', { timeout: 15_000 })
    await expect(page.locator(`.lib-compact-card[data-gallery-card="${firstSlug}"]`)).toBeVisible()
    await expect(page.locator('.lib-card[data-gallery-card^="lean-"]')).toHaveCount(1)
    await context.close()
  })

  test('a free library strips the retained set and the pin cap offers the chooser', async ({ browser }) => {
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
    await expect(page.getByRole('heading', { name: 'Your galleries' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Temporary galleries' })).toBeVisible()

    // Pinning is how a Free gallery becomes permanent — a temporary card
    // offers it, but with all three permanent slots taken the chooser
    // answers instead of a bare refusal.
    const tempSlug = (await page.locator('.lib-compact-card').first().getAttribute('data-gallery-card'))!
    const victimSlug = (await page.locator('.lib-card').first().getAttribute('data-gallery-card'))!
    await page.locator('.lib-compact-card').first().getByRole('button', { name: /actions$/ }).click()
    await page.getByRole('button', { name: 'Pin to “Your galleries”' }).click()
    const chooser = page.getByRole('dialog')
    await expect(chooser).toBeVisible()
    await expect(chooser).toContainText('Your galleries are full')
    await expect(chooser).toContainText('Upgrade to Visionary')
    await expect(chooser.locator('.lib-pin-choice-list li')).toHaveCount(3)

    // One tap on the gallery to give up: it drops back to the temporary
    // set and the candidate takes its permanent slot.
    await chooser.locator('.lib-pin-choice-list li', { hasText: victimSlug }).getByRole('button', { name: 'Unpin' }).click()
    await expect(page.locator('.admin-toast')).toContainText('permanent', { timeout: 15_000 })
    await expect(page.locator(`.lib-card[data-gallery-card="${tempSlug}"]`)).toBeVisible()
    await expect(page.locator(`.lib-card[data-gallery-card="${tempSlug}"]`).getByLabel('Pinned')).toBeVisible()
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
      // strips ship every item, the covers ship exactly one.
      await spawn(context.request, [...make(3, 50, 'bulk', true), ...make(6, 50, 'rest')])
      await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
      await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-gallery-card^="bulk-"], [data-gallery-card^="rest-"]')).toHaveCount(9, { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    await expect(page.locator('.lib-card[data-gallery-card^="bulk-"]')).toHaveCount(3)
    await expect(page.locator('.lib-card[data-gallery-card="bulk-0"]').locator('.admin-gallery-strip-item')).toHaveCount(50)
    await expect(page.locator('.admin-strip-more')).toHaveCount(0)
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
