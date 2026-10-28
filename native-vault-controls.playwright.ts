import { test, expect } from '@playwright/test'
import { showChrome } from './playwright-helpers'
const base = process.env.CAPTURE_URL ?? 'http://localhost:4182'
test.describe.configure({ mode: 'serial' })
for (const viewport of [{ width: 375, height: 812 }, { width: 1376, height: 1032 }, { width: 1440, height: 900 }]) {
  test(`${viewport.width}: native picker works before caching and controls return to account`, async ({ browser, request }) => {
    test.setTimeout(75000)
    const context = await browser.newContext({ viewport })
    await request.get(`${base}/state/3`)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.lib-card').first()).toBeVisible({ timeout: 30000 })
    await expect(page.locator('main .native-load-policy')).toHaveCount(0)
    await expect(page.locator('main .native-house-cards')).toHaveCount(0)
    await expect(page.locator('.lib-th.is-active')).toHaveCount(0)
    const menu = page.getByRole('button', { name: 'Account menu', exact: true })
    if (viewport.width < 820) await expect(menu.locator('.native-account-hamburger')).toBeVisible()
    await expect.poll(() => page.locator('.lib-th img').first().evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0), { timeout: 15000 }).toBe(true)
    // A gallery card reads top-down: the rail of every photograph, then the
    // title row with its ··· menu, then metadata, caption and address.
    const cards = page.locator('.lib-card')
    const cardCount = await cards.count()
    expect(cardCount).toBeGreaterThan(0)
    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index)
      const box = async (selector: string) => (await card.locator(selector).first().boundingBox())!
      const rail = await box('.lib-rail')
      const head = await box('.lib-card-head')
      const sub = await box('.lib-card-sub')
      const link = await box('.native-gallery-link')
      expect(rail.y + rail.height, `card ${index} keeps its rail above the title`).toBeLessThanOrEqual(head.y + 4)
      expect(head.y + head.height, `card ${index} keeps its metadata under the title`).toBeLessThanOrEqual(sub.y + 4)
      expect(sub.y + sub.height, `card ${index} puts its address under the metadata`).toBeLessThanOrEqual(link.y + 4)
      // The rail spans the card and carries a cell per photograph.
      const cardBox = (await card.boundingBox())!
      expect(Math.abs(rail.width - cardBox.width), `card ${index} spans its rail across the card`).toBeLessThanOrEqual(8)
      expect(await card.locator('.lib-th').count(), `card ${index} carries at least one rail cell`).toBeGreaterThan(0)
      // The title and its ··· affordance share the head row.
      const title = await box('.lib-card-title')
      const menuButton = await box('.lib-card-menu')
      expect(Math.abs(menuButton.y - title.y), `card ${index} keeps its menu on the title's line`).toBeLessThanOrEqual(title.height)
      expect(menuButton.x, `card ${index} keeps its menu right of the title`).toBeGreaterThan(title.x)
    }
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-admin.png`, fullPage: true })

    // The page runs to both edges now that the account tab lives at the top.
    const shellPadding = await page.locator('.native-account-shell')
      .evaluate((node) => getComputedStyle(node).paddingLeft)
    if (viewport.width < 820) expect(shellPadding).toBe('24px')

    // Add is a deliberate, keyboard-safe sheet with one pinned CTA.
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const addSheet = page.getByRole('dialog', { name: 'Add gallery' })
    await expect(addSheet).toBeVisible()
    await expect(addSheet.getByLabel('Public Dropbox, Google Drive, iCloud, or MEGA link')).toBeVisible()
    await expect(addSheet.getByRole('button', { name: 'Paste', exact: true })).toBeVisible()
    await expect(addSheet.getByLabel('Name (optional)')).toBeVisible()
    await expect(page.locator('.m-sheet-foot').getByRole('button', { name: 'Add gallery', exact: true })).toBeInViewport()
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-add.png`, fullPage: false })
    await addSheet.getByRole('button', { name: 'Close', exact: true }).click()

    // The card's only chrome is its ··· affordance — the actions live in a
    // sheet of word rows, opened on demand.
    const firstCard = cards.first()
    await expect(firstCard.locator('.native-gallery-actions')).toHaveCount(0)
    await firstCard.locator('.lib-card-menu').click()
    const cardMenu = page.getByRole('menu')
    await expect(cardMenu).toBeVisible()
    await expect(cardMenu.getByRole('menuitem')).toHaveText([
      'Share link', 'Gallery details', 'Reorder photographs', 'Read the folder again', 'Remove gallery',
    ])
    await expect(page.getByRole('dialog').locator('h2')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(cardMenu).toHaveCount(0)

    // Details owns metadata editing and device policy; the Library card no
    // longer doubles as an inline editor.
    await firstCard.locator('.lib-card-menu').click()
    await page.getByRole('menuitem', { name: 'Gallery details', exact: true }).click()
    const libraryDetails = page.locator('[data-screen="details"]')
    await expect(libraryDetails).toBeVisible()
    await expect(libraryDetails.locator('.m-actionrow').filter({ hasText: 'Caption' })).toBeVisible()
    await expect(libraryDetails.locator('.m-actionrow-label').getByText('Address', { exact: true })).toBeVisible()
    const detailBounds = await libraryDetails.locator('.m-actionrow, .m-panel-note').evaluateAll((nodes) =>
      nodes.map((node) => ({ className: node.className, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: window.innerWidth })))
    const detailOverflow = detailBounds.filter((node) => node.right > node.viewport + 1).length
    expect(detailOverflow, JSON.stringify(detailBounds)).toBe(0)
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-details.png`, fullPage: true })
    await libraryDetails.locator('.m-topbar button').click()
    await expect(libraryDetails).toHaveCount(0)

    // Reorder lives in the card's ··· menu: the picker's matrix, in order.
    // One photograph is picked up and put down, and only that order is
    // saved. (The rail itself opens the gallery — exercised below as the
    // viewer-entry path.)
    await firstCard.locator('.lib-card-menu').click()
    await page.getByRole('menuitem', { name: 'Reorder photographs', exact: true }).click()
    const editor = page.locator('[data-gallery-editor]')
    await expect(editor).toBeVisible()
    const cells = editor.locator('.native-global-grid .native-global-cell')
    await expect(cells.first()).toBeVisible()
    const cellCount = await cells.count()
    expect(cellCount).toBeGreaterThan(1)
    const heights = await cells.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))
    expect(new Set(heights).size).toBe(1)
    const overlaps = await cells.evaluateAll((nodes) => {
      const rects = nodes.map((node) => ({ key: node.getAttribute('data-order-key'), rect: node.getBoundingClientRect() }))
      const collisions: string[] = []
      for (let a = 0; a < rects.length; a += 1) {
        for (let b = a + 1; b < rects.length; b += 1) {
          const one = rects[a]!
          const two = rects[b]!
          if (one.rect.left < two.rect.right - 1 && one.rect.right > two.rect.left + 1 && one.rect.top < two.rect.bottom - 1 && one.rect.bottom > two.rect.top + 1) {
            collisions.push(`${one.key}:${two.key}`)
          }
        }
      }
      return collisions
    })
    expect(overlaps).toEqual([])
    // Order assertions read data-order-key, not data-photo: the save writes
    // orderKeys (ref ?? filename ?? id), which is what the recorded PATCH
    // must match.
    const orderBefore = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-order-key')))
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-editor.png`, fullPage: false })
    await cells.nth(cellCount - 1).click()
    await expect(cells.nth(cellCount - 1)).toHaveClass(/is-active/)
    await expect(editor.locator('.native-editor-note')).toContainText('in hand')
    await editor.locator('[data-editor-scroll]').evaluate((node) => { node.scrollTop = 0 })
    const originalFirst = editor.locator(`[data-order-key="${orderBefore[0]}"]`)
    await expect(originalFirst).toBeVisible()
    await originalFirst.click()
    await expect(editor.locator('.native-editor-note')).toContainText('position 1 of')
    const orderAfter = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-order-key')))
    expect(orderAfter[0]).toBe(orderBefore[cellCount - 1])
    await editor.locator('.native-editor-save').click()
    await expect(editor.locator('.native-editor-note')).toContainText('saved')
    const saved = await page.evaluate(() => (window as unknown as {
      __capturePatch?: { url: string; body: { order?: string[] } }[]
    }).__capturePatch ?? [])
    const lastWrite = saved.at(-1)
    expect(lastWrite?.url).toContain('/api/galleries/')
    expect(lastWrite?.body.order).toHaveLength(22)
    expect(new Set(lastWrite?.body.order).size).toBe(22)
    expect(lastWrite?.body.order?.[0]).toBe(orderBefore[cellCount - 1])
    for (const key of orderBefore) expect(lastWrite?.body.order).toContain(key)
    await editor.locator('[aria-label="Close the editor"]').click()
    await expect(editor).toHaveCount(0)

    await menu.click()
    const account = page.getByRole('dialog', { name: 'Account', exact: true })
    if (viewport.width < 820) {
      await expect.poll(async () => (await account.boundingBox())?.y ?? -999).toBeGreaterThanOrEqual(0)
      const bounds = await account.boundingBox()
      expect(bounds!.x).toBe(0)
      expect(bounds!.width).toBe(viewport.width)
      expect(bounds!.height).toBe(viewport.height)
    }
    // The menu's brand is the page's brand: same place, same size, same
    // measure for the tagline, so the menu reads as the page unfolding.
    const pageMark = (await page.locator('[aria-label="Account overview"] .landing-brand-mark').boundingBox())!
    const menuMark = (await account.locator('.native-drawer-brand .landing-brand-mark').boundingBox())!
    // A phone shows the sheet edge to edge, so the wordmark lands on the same
    // pixel; on a wide screen the page's brand sits in its own column while the
    // sheet runs full width, so only its size has to match there.
    if (viewport.width < 820) expect(Math.abs(menuMark.x - pageMark.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(menuMark.width - pageMark.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(menuMark.height - pageMark.height)).toBeLessThanOrEqual(1)
    // The tagline is set in the page's own type on both surfaces; only a
    // phone-wide sheet reproduces the page's measure exactly.
    const introType = (locator: typeof page.locator extends never ? never : ReturnType<typeof page.locator>) => locator.evaluate((node) => {
      const style = getComputedStyle(node)
      return `${style.fontSize}/${style.lineHeight}/${style.fontFamily.split(',')[0]}`
    })
    const pageIntroType = await introType(page.locator('[aria-label="Account overview"] .landing-brand-intro'))
    const menuIntroType = await introType(account.locator('.native-drawer-brand .landing-brand-intro'))
    expect(menuIntroType).toBe(pageIntroType)
    if (viewport.width < 820) {
      const pageIntro = await page.locator('[aria-label="Account overview"] .landing-brand-intro').evaluate((node) => Math.round(node.getBoundingClientRect().height))
      const menuIntro = await account.locator('.native-drawer-brand .landing-brand-intro').evaluate((node) => Math.round(node.getBoundingClientRect().height))
      expect(menuIntro).toBe(pageIntro)
    }
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-account.png`, fullPage: false })
    await account.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.locator('.native-settings')
    await expect(settings).toBeVisible()
    await expect(settings.locator('#settings-load-policy')).toBeVisible()
    await expect(settings.getByText('House cards', { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: 'Learn about Visionary', exact: true }).click()
    const visionary = page.locator('.native-visionary')
    await expect(visionary).toBeVisible()
    await expect(visionary).toContainText('from 3 to 99')
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-visionary.png`, fullPage: false })
    await visionary.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: 'Privacy Policy', exact: true }).click()
    const privacy = page.locator('.privacy-view')
    await expect(privacy).toBeVisible()
    await expect(privacy.locator('h1')).toHaveText('Privacy Policy')
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-privacy.png`, fullPage: false })
    await privacy.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(settings).toBeVisible()
    await expect(settings.getByText('Appearance', { exact: true }).first()).toBeVisible()
    await settings.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-settings-light.png`, fullPage: false })
    await settings.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/light/)
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-settings.png`, fullPage: false })
    await settings.getByRole('button', { name: 'Back', exact: true }).click()
    // The rail is the card's most obvious affordance, so it opens the
    // gallery — the editor lives on the card menu, exercised above.
    await page.locator('.lib-card .lib-th').first().click()
    const curtain = page.locator('[data-curtain]')
    await expect(curtain).toBeVisible()
    await expect.poll(async () => {
      if (await curtain.isHidden()) return true
      await curtain.click({ timeout: 2000 }).catch(() => {})
      return curtain.isHidden()
    }, { timeout: 20000 }).toBe(true)
    // The temporary chrome is the web's control set: a quiet rest bubble
    // at rest, bars on demand — nothing floats over a photograph for long.
    await expect(page.locator('.stage-seq')).toBeVisible()
    await showChrome(page)
    await page.getByRole('button', { name: 'Display', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Display' })
    await expect(dialog).toBeVisible()
    // Fullscreen is a web capability; native shells keep the same Display
    // controls except this browser-only escape hatch.
    await expect(dialog.getByRole('switch', { name: 'Fullscreen', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const positionBeforeDetails = await page.locator('.stage-seq-tally').textContent()
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    const viewerDetails = page.locator('[data-screen="details"]')
    await expect(viewerDetails).toBeVisible()
    const keepCopy = page.getByRole('switch', { name: 'Keep a copy on this device' })
    await expect(keepCopy).toHaveAttribute('aria-checked', 'true')
    await keepCopy.click()
    await expect(keepCopy).toHaveAttribute('aria-checked', 'false')
    await expect(viewerDetails.getByRole('status').filter({ hasText: 'Streaming from cloud' })).toBeVisible()
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-viewer-details.png`, fullPage: true })
    await viewerDetails.locator('.m-topbar button').click()
    await expect(viewerDetails).toHaveCount(0)
    await expect(page.locator('[data-curtain]')).toBeHidden()
    await expect(page.locator('.stage-seq-tally')).toHaveText(positionBeforeDetails ?? '')
    await page.keyboard.press('g')
    const picker = page.locator('[data-global-view]')
    await expect(picker).toBeVisible()
    // The grid is drawn from the vault, or from the open gallery while the
    // vault is still filling, so the first frame may arrive a beat late.
    await expect(picker.locator('[data-grid-frame]').first()).toBeVisible({ timeout: 20000 })
    await expect(picker).not.toContainText('still settling')
    await page.getByRole('button', { name: 'Close photo picker', exact: true }).click()
    await showChrome(page)
    await page.getByRole('button', { name: 'Display', exact: true }).click()
    await page.getByRole('dialog', { name: 'Display' }).getByRole('button', { name: 'Close', exact: true }).click()
    // The chrome's Library pill is the exit; the endcard carries a second
    // Library control that stays behind the track until it is revealed.
    await page.locator('[data-chrome-library]').click()
    await expect(page.locator('.native-account-overview')).toBeVisible()
    await expect(page.locator('[data-stage]')).toHaveCount(0)
    expect(errors).toEqual([])
    await context.close()
  })
}

test('375: a viewer that asks for less motion gets a still pill', async ({ browser, request }) => {
  test.setTimeout(60000)
  // The bob is decoration, so it stands down when the platform asks for less
  // motion — the pill itself stays exactly where it is.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' })
  await request.get(`${base}/state/3`)
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lib-card', { timeout: 30000 })
  await page.locator('.lib-card .lib-card-title').first().click()
  const curtain = page.locator('[data-curtain]')
  await expect(curtain).toBeVisible()
  await expect.poll(async () => {
    if (await curtain.isHidden()) return true
    await curtain.click({ timeout: 2000 }).catch(() => {})
    return curtain.isHidden()
  }, { timeout: 20000 }).toBe(true)
  const bubble = page.locator('.stage-seq')
  await expect(bubble).toBeVisible()
  // The web's fade-in may still run; what must not run is the drift.
  expect(await bubble.evaluate((node) => node.getAnimations().map((animation) => (animation as CSSAnimation).animationName))).not.toContain('native-logo-bob')
  await context.close()
})
