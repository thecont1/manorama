import { expect, test, type Browser, type Page } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5190'

const openAdmin = async (browser: Browser, touch = false) => {
  const context = await browser.newContext({
    viewport: touch ? { width: 375, height: 812 } : { width: 1440, height: 900 },
    hasTouch: touch,
    isMobile: touch,
  })
  const login = await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0 })
  expect(login.status()).toBe(302)
  const page = await context.newPage()
  await page.goto(base)
  const card = page.locator('[data-gallery-card]').first()
  await card.scrollIntoViewIfNeeded()
  await expect(card.locator('.admin-gallery-strip-item').nth(2)).toHaveCount(1)
  return { context, page, card }
}

const ids = (card: ReturnType<Page['locator']>) =>
  card.locator('.admin-gallery-strip-item').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-image-id')))

test('one-finger and two-finger touch pan without starting a reorder', async ({ browser }) => {
  const { context, page, card } = await openAdmin(browser, true)
  try {
    const frame = card.locator('.admin-gallery-strip-frame')
    await frame.evaluate((node) => { node.scrollLeft = 0 })
    const writes: string[] = []
    page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.url()) })
    const cdp = await context.newCDPSession(page)
    const box = (await card.locator('.admin-gallery-strip-item').first().boundingBox())!
    const y = box.y + box.height / 2
    const x = box.x + Math.min(box.width - 8, box.width / 2)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (const dx of [25, 55, 90, 125]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - dx, y, id: 1 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(frame).toHaveCSS('touch-action', 'pan-x')
    await expect(card.locator('.is-reordering')).toHaveCount(0)
    expect(writes).toEqual([])
    await frame.hover()
    await page.mouse.wheel(0, 120)
    await expect.poll(() => frame.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)

    await frame.evaluate((node) => { node.scrollLeft = 0 })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 2 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 2 }, { x: x - 35, y, id: 3 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 70, y, id: 2 }, { x: x - 105, y, id: 3 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(card.locator('.is-reordering')).toHaveCount(0)
    expect(writes).toEqual([])
  } finally {
    await context.close()
  }
})

test('a stationary long-press arms touch reordering and saves on release', async ({ browser }) => {
  const { context, page, card } = await openAdmin(browser, true)
  try {
    const frame = card.locator('.admin-gallery-strip-frame')
    await frame.evaluate((node) => { node.scrollLeft = 0 })
    const items = card.locator('.admin-gallery-strip-item')
    const before = await ids(card)
    const from = (await items.nth(1).boundingBox())!
    const to = (await items.nth(0).boundingBox())!
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
    const target = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
    const writes: string[] = []
    page.on('request', (request) => { if (request.method() === 'PATCH') writes.push(request.url()) })
    await items.nth(1).dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: start.x, clientY: start.y })
    await page.waitForTimeout(420)
    await expect(items.nth(1)).toHaveClass(/is-reordering/)
    await items.nth(1).dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: -100, clientY: target.y })
    await expect.poll(() => ids(card)).not.toEqual(before)
    await items.nth(1).dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: -100, clientY: target.y })
    await expect.poll(() => writes.length).toBe(1)
    await expect.poll(() => ids(card)).not.toEqual(before)
  } finally {
    await context.close()
  }
})
