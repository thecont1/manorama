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
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.lib-th img').first().evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0), { timeout: 15000 }).toBe(true)
    // A gallery card reads top-down: the cover photograph, then the title row
    // with its ··· menu, then metadata and any caption.
    const cards = page.locator('.lib-card')
    const cardCount = await cards.count()
    expect(cardCount).toBeGreaterThan(0)
    for (let index = 0; index < cardCount; index += 1) {
      const card = cards.nth(index)
      const box = async (selector: string) => (await card.locator(selector).first().boundingBox())!
      const cover = await box('.native-library-cover-slot')
      const head = await box('.lib-card-head')
      const sub = await box('.lib-card-sub')
      expect(cover.y + cover.height, `card ${index} keeps its cover above the title`).toBeLessThanOrEqual(head.y + 4)
      expect(head.y + head.height, `card ${index} keeps its metadata under the title`).toBeLessThanOrEqual(sub.y + 4)
      // The compact card's cover fills the card's own width. It is a column
      // of the Library grid now, not a strip that runs to the screen's edge.
      const cardBox = (await card.boundingBox())!
      expect(Math.abs(cardBox.x - cover.x), `card ${index} keeps its cover flush left`).toBeLessThanOrEqual(1)
      expect(Math.abs(cardBox.x + cardBox.width - cover.x - cover.width), `card ${index} keeps its cover flush right`).toBeLessThanOrEqual(1)
      // One cover cell per card: the gallery's own first photograph.
      expect(await card.locator('.lib-th').count(), `card ${index} carries its cover cell`).toBe(1)
      // A bitmap is never shown larger than it is.
      const picture = await card.locator('.lib-th img').first().evaluate((node) => {
        const image = node as HTMLImageElement
        const rect = image.getBoundingClientRect()
        return { width: rect.width, height: rect.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }
      })
      expect(picture.width, `card ${index} never upscales its cover`).toBeLessThanOrEqual(picture.naturalWidth + 1)
      expect(picture.height, `card ${index} never upscales its cover`).toBeLessThanOrEqual(picture.naturalHeight + 1)
      // The title and its ··· affordance share the head row.
      const title = await box('.lib-card-title')
      const menuButton = await box('.lib-card-menu')
      expect(Math.abs(menuButton.y - title.y), `card ${index} keeps its menu on the title's line`).toBeLessThanOrEqual(title.height)
      expect(menuButton.x, `card ${index} keeps its menu right of the title`).toBeGreaterThan(title.x)
      // Title → metadata → caption is one tight group; the breathing room is
      // reserved for the next gallery's card.
      const caption = card.locator('.native-gallery-caption')
      const captionCount = await caption.count()
      let captionBottom = sub.y + sub.height
      if (captionCount > 0) {
        const captionBox = (await caption.first().boundingBox())!
        captionBottom = captionBox.y + captionBox.height
        expect(captionBox.y - (sub.y + sub.height), `card ${index} keeps its caption in the metadata group`).toBeLessThanOrEqual(12)
      }
      if (index + 1 < cardCount) {
        const nextCover = await cards.nth(index + 1).locator('.native-library-cover-slot').first().boundingBox()!
        // The grid wraps to several columns on wider layouts: a same-row
        // neighbour's cover sits level with this one's, so the deliberate
        // vertical gap is only owed to the card that wraps to the next row.
        if (Math.abs(nextCover.y - cover.y) <= 4) {
          expect(nextCover.x - (cover.x + cover.width), `card ${index} keeps the grid's column gap`).toBeGreaterThanOrEqual(15)
        } else {
          expect(nextCover.y - captionBottom, `card ${index} leaves a deliberate gap to the next gallery`).toBeGreaterThanOrEqual(30)
        }
      }
    }
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-admin.png`, fullPage: true })

    // The page runs to both edges now that the account tab lives at the top.
    // The shell carries no side padding of its own — the Library grid's
    // gutter does the insetting, and it does it at every width.
    const shell = page.locator('.native-account-shell')
    expect(await shell.evaluate((node) => getComputedStyle(node).paddingLeft)).toBe('0px')
    const gutter = await cards.first().evaluate((node) => {
      const column = node.closest('.native-list-card')!.getBoundingClientRect()
      return Math.round(node.getBoundingClientRect().x - column.x)
    })
    expect(gutter, 'the card is inset from its column by a comfortable gutter').toBeGreaterThanOrEqual(16)
    expect(gutter, 'the card is inset from its column by a comfortable gutter').toBeLessThanOrEqual(32)

    // Add is a deliberate, keyboard-safe sheet with one pinned CTA — and a
    // real 44px finger target, not just a tall-enough label.
    const addTrigger = page.getByRole('button', { name: 'Add Gallery', exact: true })
    const addBox = (await addTrigger.boundingBox())!
    expect(addBox.height, 'Add Gallery meets the 44px touch floor').toBeGreaterThanOrEqual(44)
    expect(addBox.width, 'Add Gallery meets the 44px touch floor').toBeGreaterThanOrEqual(44)
    await addTrigger.click()
    const addSheet = page.getByRole('dialog', { name: 'Add a gallery' })
    await expect(addSheet).toBeVisible()
    await expect(addSheet.getByLabel('Shared folder or album link — Dropbox, Google Drive, iCloud, MEGA, Ente or Proton Drive')).toBeVisible()
    // The sheet asks for one thing: the link. The name and the caption only
    // appear once the source has answered, so a typo is never dressed up as
    // a filled-in form. There is no paste button to press — the field is it.
    await expect(addSheet.getByLabel('Name (optional)')).toHaveCount(0)
    // The pinned CTA waits for the link: an empty field has nothing to create.
    const createGallery = page.locator('.m-sheet-foot').getByRole('button', { name: 'Create gallery', exact: true })
    await expect(createGallery).toBeInViewport()
    await expect(createGallery).toBeDisabled()
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
      'Pin gallery', 'Copy link', 'Post to X', 'Gallery details', 'Reorder photographs', 'Refresh gallery contents', 'Remove gallery',
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
    // The address stays readable here; editing it lives in Settings.
    await expect(libraryDetails.locator('.d-addr')).toBeVisible()
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
    // Cancel and Save share the shared 44px bar buttons — the editor used to
    // shrink them to 36px.
    for (const cls of ['.native-editor-cancel', '.native-editor-save']) {
      const box = (await editor.locator(cls).boundingBox())!
      expect(box.height, `${cls} meets the 44px touch floor`).toBeGreaterThanOrEqual(44)
    }
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
    // The PATCH writes the whole session order but the editor only mounts a
    // window; walk the scroll container to collect every order key.
    const orderAll: (string | null)[] = [...orderBefore]
    const scroller = editor.locator('[data-editor-scroll]')
    for (let guard = 0; guard < 40; guard += 1) {
      const collected = orderAll.length
      await scroller.evaluate((node) => { node.scrollTop += node.clientHeight })
      await page.waitForTimeout(120)
      const mounted = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-order-key')))
      for (const key of mounted) if (!orderAll.includes(key)) orderAll.push(key)
      if (orderAll.length === collected) break
    }
    await scroller.evaluate((node) => { node.scrollTop = 0 })
    await expect(cells.first()).toBeVisible()
    // The mounted window re-mounts asynchronously after the jump — wait for
    // the original top window to be back in place or `nth(cellCount - 1)`
    // can target a cell that has not mounted yet.
    await expect.poll(() => cells.count()).toBeGreaterThanOrEqual(cellCount)
    await expect(cells.first()).toHaveAttribute('data-order-key', orderBefore[0]!)
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-editor.png`, fullPage: false })
    await cells.nth(cellCount - 1).click()
    await expect(cells.nth(cellCount - 1)).toHaveClass(/is-active/)
    await expect(editor.locator('.native-editor-note')).toContainText('Picked up')
    await editor.locator('[data-editor-scroll]').evaluate((node) => { node.scrollTop = 0 })
    const originalFirst = editor.locator(`[data-order-key="${orderBefore[0]}"]`)
    await expect(originalFirst).toBeVisible()
    await originalFirst.click()
    // The move result is announced in the hidden live region, never shown.
    await expect(page.locator('.m-sr-only')).toContainText('position 1 of')
    await expect(editor.locator('.native-editor-note')).not.toContainText('Moved')
    const orderAfter = await cells.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-order-key')))
    expect(orderAfter[0]).toBe(orderBefore[cellCount - 1])
    await editor.locator('.native-editor-save').click()
    await expect(editor.locator('.native-editor-note')).toContainText('saved')
    const saved = await page.evaluate(() => (window as unknown as {
      __capturePatch?: { url: string; body: { order?: string[] } }[]
    }).__capturePatch ?? [])
    const lastWrite = saved.at(-1)
    expect(lastWrite?.url).toContain('/api/galleries/')
    // The click-tap move lifted the last mounted cell to position 1; assert
    // the complete saved sequence, not just its membership.
    const heldKey = orderBefore[cellCount - 1]
    expect(lastWrite?.body.order).toEqual([heldKey, ...orderAll.filter((key) => key !== heldKey)])
    await editor.locator('.native-editor-cancel').click()
    await expect(editor).toHaveCount(0)

    // Account controls live in Settings, opened from the top bar — the
    // Library page itself is the account surface now.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.locator('.native-settings')
    await expect(settings).toBeVisible()
    await page.screenshot({ path: `demo-captures/admin-gallery-focus/native-${viewport.width}-account.png`, fullPage: false })
    await expect(settings.getByRole('radiogroup', { name: 'New galleries', exact: true })).toBeVisible()
    await expect(settings.getByText('House cards', { exact: true })).toBeVisible()
    await settings.getByRole('button', { name: /Visionary/, exact: false }).click()
    const visionary = page.locator('.native-visionary')
    await expect(visionary).toBeVisible()
    await expect(visionary).toContainText('3 → 99')
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-visionary.png`, fullPage: false })
    await visionary.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(settings).toBeVisible()
    await settings.getByRole('button', { name: 'Privacy Policy', exact: true }).click()
    const privacy = page.locator('.privacy-view')
    await expect(privacy).toBeVisible()
    await expect(privacy.locator('h1')).toHaveText('Privacy Policy')
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-privacy.png`, fullPage: false })
    await privacy.getByRole('button', { name: 'Back to settings', exact: true }).click()
    await expect(settings).toBeVisible()
    await expect(settings.getByText('Appearance', { exact: true }).first()).toBeVisible()
    await settings.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-settings-light.png`, fullPage: false })
    await settings.getByRole('radio', { name: 'Dark', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/light/)
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-settings.png`, fullPage: false })
    await settings.getByRole('button', { name: 'Back to the library', exact: true }).click()
    // The cover is the card's most obvious affordance, so it opens the
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
    await expect(page.locator('[data-chrome-position]')).toBeVisible()
    await showChrome(page)
    // The viewer's own settings are the gallery's: the chrome's pill opens
    // the Gallery Settings sheet.
    await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Gallery Settings' })
    await expect(dialog).toBeVisible()
    // Fullscreen is a web capability; native shells keep the same Display
    // controls except this browser-only escape hatch.
    await expect(dialog.getByRole('switch', { name: 'Fullscreen', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const positionBeforeDetails = await page.locator('[data-chrome-position]').textContent()
    // The gallery's own panel — the device policy included — lives one layer
    // in, behind More Settings.
    await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
    await page.getByRole('button', { name: 'More Settings', exact: true }).click()
    const keepCopy = page.getByRole('switch', { name: 'Keep copy on this device' })
    await expect(keepCopy).toHaveAttribute('aria-checked', 'false')
    await keepCopy.click()
    await expect(keepCopy).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('status').filter({ hasText: 'encrypted' })).toBeVisible()
    await page.screenshot({ path: `docs/redesign-parity/native-${viewport.width}-viewer-details.png`, fullPage: true })
    await page.getByRole('button', { name: /^Back to / }).click()
    await expect(keepCopy).toHaveCount(0)
    await expect(page.locator('[data-curtain]')).toBeHidden()
    await expect(page.locator('[data-chrome-position]')).toHaveText(positionBeforeDetails ?? '')
    await page.keyboard.press('g')
    const picker = page.locator('[data-global-view]')
    await expect(picker).toBeVisible()
    // The grid is drawn from the vault, or from the open gallery while the
    // vault is still filling, so the first frame may arrive a beat late.
    await expect(picker.locator('[data-grid-frame]').first()).toBeVisible({ timeout: 20000 })
    await expect(picker).not.toContainText('still settling')
    await page.getByRole('button', { name: 'Close photo picker', exact: true }).click()
    await showChrome(page)
    await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Gallery Settings' }).getByRole('button', { name: 'Close', exact: true }).click()
    // The chrome's Library pill is the exit; the endcard carries a second
    // Library control that stays behind the track until it is revealed.
    await page.locator('[data-chrome-library]').click()
    await expect(page.locator('.native-account-shell')).toBeVisible()
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
  await showChrome(page)
  const bubble = page.locator('[data-chrome-position]')
  await expect(bubble).toHaveCSS('opacity', '1')
  // The web's fade-in may still run; what must not run is the drift.
  expect(await bubble.evaluate((node) => node.getAnimations().map((animation) => (animation as CSSAnimation).animationName))).not.toContain('native-logo-bob')
  await context.close()
})
