import { test, expect } from '@playwright/test'

const base = process.env.GALLERY_URL ?? 'http://localhost:5175'

/** Contrast ratio of each selected node's computed color against the first
 *  non-transparent background up its ancestor chain — the same luminance
 *  math the admin appearance spec uses. */
const contrastOf = (el: HTMLElement, sel: string) => {
  const rgb = (v: string) => v.match(/[\d.]+/g)!.map(Number)
  const lum = (ch: number[]) => ch.slice(0, 3).map(c => { const s = c / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
  const bgOf = (n: HTMLElement): number[] => { let e: HTMLElement | null = n; while (e) { const b = rgb(getComputedStyle(e).backgroundColor); if ((b[3] ?? 1) > 0) return b; e = e.parentElement } return [0, 0, 0, 1] }
  return [...el.querySelectorAll<HTMLElement>(sel)].map(n => {
    const c = rgb(getComputedStyle(n).color); const a = c[3] ?? 1
    const bg = bgOf(n); const bgl = lum(bg)
    const fg = lum(c.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a)))
    return { text: n.textContent?.slice(0, 28), ratio: (Math.max(fg, bgl) + .05) / (Math.min(fg, bgl) + .05) }
  })
}

test('light mode: owner screens and the dark gallery stay readable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await expect.poll(async () => {
      const login = await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })
      return login.status()
    }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
    const page = await context.newPage()
    await page.goto(`${base}/thecontrarian`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.web-settings').getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.locator('.web-settings')).toHaveCount(0)

    // Gallery settings sheet: the surface stays readable in Light mode.
    await page.locator('.lib-card-menu').first().click()
    await page.locator('.lib-menu').getByRole('button', { name: 'Gallery settings' }).click()
    const sheet = page.getByRole('dialog', { name: 'Gallery settings' })
    await expect(sheet).toBeVisible()
    const sheetEl = await sheet.elementHandle()
    const ratios = await sheetEl!.evaluate(contrastOf, '.m-sheet-title, .m-actionrow-label, .m-actiongroup-label')
    expect(ratios.length).toBeGreaterThan(0)
    for (const r of ratios) expect(r.ratio).toBeGreaterThanOrEqual(4.5)
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(sheet).toHaveCount(0)

    // The gallery's canvas follows the owner's theme by default, so pin the
    // album to Dark first — the check below is that the *surfaces* keep
    // their own ink when a shell restores html.light globally.
    await page.goto(`${base}/thecontrarian/mixed-album`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.viewer-stage', { timeout: 15_000 })
    await page.evaluate(() => {
      localStorage.setItem('manorama:theme', 'light')
      localStorage.setItem('manorama:view:mixed-album', JSON.stringify({ background: 'dark' }))
      document.documentElement.classList.add('light')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.viewer-stage.bg-dark', { timeout: 15_000 })
    await page.evaluate(() => document.documentElement.classList.add('light'))

    // "The End." and the house plate keep light ink on the dark canvas.
    for (const sel of ['[data-endcard]', '[data-ad-frame]']) {
      const color = await page.locator(sel).evaluate(e => getComputedStyle(e).color)
      const channels = color.match(/[\d.]+/g)!.map(Number)
      expect(channels[0] + channels[1] + channels[2], `${sel} color ${color}`).toBeGreaterThan(600)
    }

    // The Light canvas is its own display choice (manorama:view:<slug>) — the
    // card surfaces ride it, so their copy must flip to dark ink.
    await page.evaluate(() => { localStorage.setItem('manorama:view:mixed-album', JSON.stringify({ background: 'light' })) })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.viewer-stage.bg-light', { timeout: 15_000 })
    for (const sel of ['[data-endcard]', '[data-ad-frame]']) {
      const el = page.locator(sel)
      const color = await el.evaluate(e => getComputedStyle(e).color)
      const channels = color.match(/[\d.]+/g)!.map(Number)
      expect(channels[0] + channels[1] + channels[2], `${sel} color ${color}`).toBeLessThan(120)
    }
    await page.evaluate(() => { localStorage.removeItem('manorama:view:mixed-album') })

    // Chrome auto-hides after 3s; tap the stage until the pill appears.
    const reveal = async (name: RegExp) => {
      const btn = page.getByRole('button', { name }).first()
      for (let i = 0; i < 4 && !(await btn.isVisible().catch(() => false)); i++) {
        await page.mouse.click(720, 450)
        await page.waitForTimeout(500)
      }
      await btn.click()
    }
    for (const { name, sel } of [
      { name: /^Settings/i, sel: '.m-sheet-label, .m-sheet-title, .m-sheet-hint, .m-segmented-option, .m-quiet-copy, kbd' },
      { name: /^Info/i, sel: '.m-sheet-label, .m-sheet-title, .m-info-row dt, .m-info-row dd, .m-quiet-copy' },
    ]) {
      await reveal(name)
      const sheet = page.locator('.m-sheet')
      await expect(sheet).toBeVisible()
      const samples = await sheet.evaluate(contrastOf as never, sel)
      for (const sample of samples) expect(sample.ratio, `${name} sheet ${sample.text}`).toBeGreaterThanOrEqual(4.5)
      await sheet.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(sheet).toHaveCount(0)
    }
  } finally { await context.close() }
})
