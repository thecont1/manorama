import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5174'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'
const member = process.env.GALLERY_MEMBER ?? 'dbid:AAATESTretention'

const signIn = async (context: BrowserContext, account?: string) => {
  await expect.poll(async () => {
    const login = await context.request.get(`${base}/.dev-seed/login${account ? `?account=${account}` : ''}`, { maxRedirects: 0, timeout: 15_000 })
    return login.status()
  }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
}

const cellIds = (page: Page) =>
  page.locator('.viewer-edit-cell [data-grid-item]').evaluateAll((els) => els.map((el) => el.getAttribute('data-image-id')))
const browseIds = (page: Page) =>
  page.locator('.viewer-filmstrip-item[data-grid-item]').evaluateAll((els) => els.map((el) => el.getAttribute('data-image-id')))

const openPicker = async (page: Page) => {
  await page.locator('[data-chrome-position]').click()
  await expect(page.locator('.viewer-filmstrip')).toBeVisible({ timeout: 10_000 })
}
const enterEdit = async (page: Page) => {
  await page.getByRole('button', { name: 'Reorder photographs' }).click()
  await expect(page.locator('.viewer-edit-cell').first()).toBeVisible({ timeout: 20_000 })
}
const mark = (page: Page, imageId: string) =>
  page.locator(`.viewer-edit-cell:has([data-image-id="${imageId}"])`).locator('.viewer-edit-mark')
// The mark fades in on hover, so a locator click's actionability retries
// can flake against the matrix re-render — drive the pointer directly.
const clickMark = async (page: Page, imageId: string) => {
  const box = (await mark(page, imageId).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const openGallery = async (page: Page, slug: string) => {
  await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
  const curtain = page.locator('[data-curtain]')
  if (await curtain.isVisible()) {
    await curtain.click()
    await expect(curtain).toBeHidden()
  }
  await expect(page.locator('[data-chrome-position]')).toBeVisible({ timeout: 15_000 })
}

const discoverSlug = async (page: Page) => {
  await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
  // Specs share one seeded store: another spec's spawned galleries are
  // always newest and sort first — and its next reset deletes them
  // underneath us. The last card is the oldest entry, a pristine seed
  // that every reset re-inserts.
  return (await page.locator('[data-gallery-card]').last().getAttribute('data-gallery-card'))!
}

test('owner Edit mode reorders and hides, reload shows the result, and restore is idempotent', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    await context.request.post(`${base}/.dev-seed/reset`)
    await expect.poll(async () => (await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })).status()).toBe(302)
    const slug = await discoverSlug(page)
    await openGallery(page, slug)
    await openPicker(page)

    // One screen, two modes: the top bar says what a tap does and holds
    // the mode's controls; the bottom bar keeps title and count.
    const top = page.locator('.viewer-picker-top')
    await expect(top).toContainText('Tap a photograph to open it.')
    const header = page.locator('.viewer-picker-header')
    await expect(header).toContainText('photograph')
    const headerBox = (await header.boundingBox())!
    expect(headerBox.y + headerBox.height).toBeGreaterThan(page.viewportSize()!.height - 80)

    await enterEdit(page)
    await expect(top).toContainText('pick it up')
    await expect(top.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await expect(top.getByRole('button', { name: 'Save' })).toBeVisible()
    await expect(top.locator('.viewer-edit-sizer svg.s')).toBeVisible()
    await expect(top.locator('.viewer-edit-sizer svg.l')).toBeVisible()

    const ids = await cellIds(page)
    expect(ids.length).toBeGreaterThanOrEqual(4)

    // Edit-mode thumbnails must render — the filmstrip img fade-in needs
    // its is-loaded mark, and decoded media must have real pixels.
    await expect(async () => {
      const unseen = await page.locator('.viewer-edit-cell img').evaluateAll((imgs) =>
        imgs.filter((img) => {
          const hidden = img.closest('.viewer-edit-cell')!.classList.contains('is-hidden')
          return !(img as HTMLImageElement).naturalWidth || getComputedStyle(img).opacity !== (hidden ? '0.32' : '1')
        }).length)
      expect(unseen).toBe(0)
    }).toPass({ timeout: 30_000 })

    // Move the first photograph to position 3, then hide the second.
    await page.locator('.viewer-edit-cell [data-grid-item]').nth(0).click()
    await page.locator('.viewer-edit-cell [data-grid-item]').nth(2).click()
    expect((await cellIds(page))[2]).toBe(ids[0])

    const hideCell = page.locator(`.viewer-edit-cell:has([data-image-id="${ids[1]}"])`)
    await hideCell.hover()
    await clickMark(page, ids[1])
    await expect(hideCell).toHaveClass(/is-hidden/)
    await page.screenshot({ path: 'outputs/picker-edit-held.png' })

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.viewer-filmstrip')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('[data-chrome-position]')).toBeVisible({ timeout: 20_000 })

    // Browse order: the moved photograph took edit position 3, and the
    // hidden one ahead of it drops out — browse shows it at index 1.
    await openPicker(page)
    const after = await browseIds(page)
    expect(after.indexOf(ids[0])).toBe(1)
    expect(after).not.toContain(ids[1])

    // Edit shows it again — present, dimmed.
    await enterEdit(page)
    await expect(page.locator(`.viewer-edit-cell.is-hidden:has([data-image-id="${ids[1]}"])`)).toHaveCount(1)

    // Restore the seed order so a second run starts from the same slate.
    await clickMark(page, ids[1])
    await expect(page.locator(`.viewer-edit-cell:has([data-image-id="${ids[1]}"])`)).not.toHaveClass(/is-hidden/)
    const current = await cellIds(page)
    const heldIndex = current.indexOf(ids[0])
    await page.locator('.viewer-edit-cell [data-grid-item]').nth(heldIndex).click()
    await page.locator('.viewer-edit-cell [data-grid-item]').nth(0).click()
    expect((await cellIds(page))[0]).toBe(ids[0])
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.viewer-filmstrip')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('[data-chrome-position]')).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close().catch(() => {})
  }
})

test('the library card menu and the legacy ?reorder=1 link land in Edit mode', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    const slug = await discoverSlug(page)

    // Card menu → ?edit=1 → the picker opens straight into Edit.
    await page.locator(`[data-gallery-card="${slug}"]`).locator('.lib-card-menu').click()
    await page.getByRole('button', { name: 'Reorder photographs' }).click()
    await expect(page.locator('.viewer-edit-cell').first()).toBeVisible({ timeout: 20_000 })
    expect(new URL(page.url()).searchParams.get('edit')).toBeNull()

    // The old dashboard deep link hands off to the same place.
    await page.goto(`${base}/${owner}?details=${slug}&reorder=1`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.viewer-edit-cell').first()).toBeVisible({ timeout: 20_000 })
    expect(new URL(page.url()).pathname).toBe(`/${owner}/${slug}`)
    expect(new URL(page.url()).searchParams.get('reorder')).toBeNull()
  } finally {
    await context.close().catch(() => {})
  }
})

test('Escape steps back through Edit mode instead of closing the picker', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  try {
    const slug = await discoverSlug(page)
    await openGallery(page, slug)
    await openPicker(page)
    await enterEdit(page)

    const held = page.locator('.viewer-edit-item.is-held')
    const cell = page.locator('.viewer-edit-cell [data-grid-item]').first()
    await cell.click()
    await expect(held).toHaveCount(1)

    // Escape reaches the editor even when focus sits outside the dialog —
    // it puts the held photograph back, it does not close the picker.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(held).toHaveCount(0)
    await expect(page.locator('.viewer-edit-cell').first()).toBeVisible()

    // With nothing held, Escape exits Edit mode; the picker stays open.
    await page.keyboard.press('Escape')
    await expect(page.locator('.viewer-edit-cell')).toHaveCount(0)
    await expect(page.locator('.viewer-filmstrip')).toBeVisible()

    // Browse-mode Escape still closes the picker.
    await page.keyboard.press('Escape')
    await expect(page.locator('.viewer-filmstrip')).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await context.close().catch(() => {})
  }
})

test('visitors and members see no Reorder button in the picker', async ({ browser }) => {
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(ownerContext)
  const probe = await ownerContext.newPage()
  const slug = await discoverSlug(probe)
  await ownerContext.close()

  const visitorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const visitorPage = await visitorContext.newPage()
  try {
    await openGallery(visitorPage, slug)
    await openPicker(visitorPage)
    await expect(visitorPage.getByRole('button', { name: 'Reorder photographs' })).toHaveCount(0)
  } finally {
    await visitorContext.close().catch(() => {})
  }

  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(memberContext, member)
  const memberPage = await memberContext.newPage()
  try {
    await openGallery(memberPage, slug)
    await openPicker(memberPage)
    await expect(memberPage.getByRole('button', { name: 'Reorder photographs' })).toHaveCount(0)
  } finally {
    await memberContext.close().catch(() => {})
  }
})
