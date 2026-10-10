import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.GALLERY_URL ?? 'http://localhost:5175'
const evidence = resolve('demo-captures/web/admin-appearance')
const sizes = [
  { name: 'iphone', width: 375, height: 812, touch: true },
  { name: 'ipad', width: 1376, height: 1032, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'wide', width: 2560, height: 1440, touch: false },
]

for (const size of sizes) {
  for (const reduced of [false, true]) {
    test(`${size.name}: both themes, edge tab and editor${reduced ? ' without motion' : ''}`, async ({ browser }) => {
      test.setTimeout(75_000)
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        hasTouch: size.touch,
        deviceScaleFactor: size.name === 'ipad' ? 2 : 1,
        reducedMotion: reduced ? 'reduce' : 'no-preference',
      })
      try {
        // The HTTP door only mints a test session. Do not wait for unrelated
        // provider image downloads or the page's global load event to finish.
        await expect.poll(async () => {
          const login = await context.request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })
          return login.status()
        }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(`${base}/thecontrarian`, { waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
        const tab = page.getByRole('button', { name: 'Account menu', exact: true })
        const dialog = page.getByRole('dialog', { name: 'Account', exact: true })
        await expect(dialog).toBeHidden()
        await expect(tab).toHaveAttribute('aria-expanded', 'false')
        const tabBox = await tab.boundingBox()
        expect(tabBox!.x).toBeLessThanOrEqual(1)
        expect(Math.abs(tabBox!.y + tabBox!.height / 2 - size.height / 2)).toBeLessThan(2)
        expect(tabBox!.width).toBeGreaterThanOrEqual(44)
        await expect(page.getByText('Photo Editor', { exact: true })).toHaveCount(0)

        const welcome = page.getByRole('region', { name: 'Welcome to manorama' })
        const importer = page.getByRole('region', { name: 'Add a gallery' })
        const heading = page.getByRole('heading', { name: 'Your galleries', exact: true })
        await expect(welcome).toBeVisible()
        await expect(importer).toBeVisible()
        const welcomeBox = (await welcome.boundingBox())!
        const importBox = (await importer.boundingBox())!
        const headingBox = (await heading.boundingBox())!
        if (size.width >= 820) {
          expect(welcomeBox.x + welcomeBox.width).toBeLessThan(size.width / 2)
          expect(importBox.x).toBeGreaterThan(size.width / 2)
          expect(Math.abs(welcomeBox.y - importBox.y)).toBeLessThan(2)
        } else {
          expect(importBox.y).toBeGreaterThanOrEqual(welcomeBox.y + welcomeBox.height)
        }
        expect(headingBox.y).toBeGreaterThanOrEqual(Math.max(welcomeBox.y + welcomeBox.height, importBox.y + importBox.height))
        const headerLogo = (await welcome.locator('img').boundingBox())!
        expect(headerLogo.x + headerLogo.width).toBeLessThanOrEqual(welcomeBox.x + welcomeBox.width)
        await expect(welcome).toContainText('Welcome to manorama.xyz.')

        for (const theme of ['dark', 'light'] as const) {
          await tab.click()
          await expect(dialog).toBeVisible()
          await expect(tab).toHaveAttribute('aria-expanded', 'true')
          await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()
          if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
          await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
          // Footer links animate their color over 180ms. Measure the settled
          // theme, not the intermediate light-on-light crossfade.
          await page.waitForTimeout(250)
          const contrast = await dialog.evaluate(element => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
            const background = rgb(getComputedStyle(element).backgroundColor)
            const luminance = (channels: number[]) => channels.slice(0, 3).map(c => {
              const s = c / 255
              return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
            }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
            const bg = luminance(background)
            return [...element.querySelectorAll<HTMLElement>('.admin-intro, .admin-greeting, .admin-drawer-action, .site-footer-link, .site-footer-copy, .admin-delete-account summary')].map(node => {
              const color = rgb(getComputedStyle(node).color)
              const alpha = color[3] ?? 1
              const fg = luminance(color.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)))
              return { text: node.textContent, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
            })
          })
          for (const sample of contrast) expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)
          await expect.poll(async () => Math.abs((await dialog.boundingBox())!.x)).toBeLessThan(1)
          const panelBox = await dialog.boundingBox()
          const logoBox = await dialog.locator('.admin-brand-logo').boundingBox()
          expect(Math.abs(panelBox!.x)).toBeLessThan(1)
          expect(logoBox!.x).toBeGreaterThanOrEqual(panelBox!.x)
          expect(logoBox!.x + logoBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)
          expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
          await page.getByRole('button', { name: 'Sign out', exact: true }).focus()
          await page.keyboard.press('Tab')
          await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()
          if (!reduced) {
            await mkdir(evidence, { recursive: true })
            await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-pane.png`), animations: 'disabled', timeout: 10_000 })
          }
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
          await expect(tab).toBeFocused()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
          // The rail is one row even before its source images finish loading.
          const rail = page.locator('.admin-gallery-strip').first()
          const items = rail.locator('figure')
          const tops = await items.evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().top))
          expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2)
          if (!reduced) await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-admin.png`), animations: 'disabled', timeout: 10_000 })
        }
        // State survives a resize but not a document reload; URLs stay clean.
        await tab.click()
        await page.setViewportSize({ width: size.width > 800 ? 428 : 1100, height: size.height })
        await expect(dialog).toBeVisible()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
        await expect(dialog).toBeHidden()
        expect(new URL(page.url()).search).toBe('')
        expect(errors).toEqual([])
      } finally { await context.close() }
    })
  }
}
