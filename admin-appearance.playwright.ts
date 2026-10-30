import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = process.env.GALLERY_URL ?? 'http://localhost:5175'
const evidence = resolve('demo-captures/web/admin-appearance')
const sizes = [
  { name: 'iphone', width: 375, height: 812, touch: true },
  { name: 'iphone-plus', width: 390, height: 844, touch: true },
  { name: 'ipad', width: 1376, height: 1032, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'wide', width: 2560, height: 1440, touch: false },
]

for (const size of sizes) {
  for (const reduced of [false, true]) {
    test(`${size.name}: both themes, top bar and editor${reduced ? ' without motion' : ''}`, async ({ browser }) => {
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
        // Chrome is the shared top bar: centred mark, Settings gear right.
        const topbar = page.locator('.m-topbar')
        const gear = topbar.getByRole('button', { name: 'Settings', exact: true })
        await expect(topbar).toBeVisible()
        await expect(gear).toBeVisible()
        await expect(topbar.locator('.m-topbar-logo')).toHaveAttribute('src', '/manorama-merged-logo.png')
        const gearBox = await gear.boundingBox()
        expect(gearBox!.x).toBeGreaterThan(size.width / 2)
        expect(gearBox!.width).toBeGreaterThanOrEqual(44)
        await expect(page.getByText('Photo Editor', { exact: true })).toHaveCount(0)

        // The Library leads with its heading; the sponsored portrait slot sits
        // between it and the first card.
        await expect(page.getByRole('region', { name: 'Welcome to manorama' })).toHaveCount(0)
        const heading = page.getByRole('heading', { name: 'Library', exact: true })
        const sponsored = page.locator('.account-ad')
        const firstCard = page.locator('.lib-card').first()
        await expect(sponsored).toBeVisible()
        const headingBox = (await heading.boundingBox())!
        const sponsoredBox = (await sponsored.boundingBox())!
        const cardBox = (await firstCard.boundingBox())!
        expect(sponsoredBox.y).toBeGreaterThanOrEqual(headingBox.y + headingBox.height)
        expect(cardBox.y).toBeGreaterThanOrEqual(sponsoredBox.y + sponsoredBox.height)

        for (const theme of ['dark', 'light'] as const) {
          await gear.click()
          const settings = page.locator('.web-settings')
          await expect(settings).toBeVisible()
          // The seeded owner is pro — the plan row carries Visionary.
          await expect(settings.getByText('Visionary', { exact: true }).first()).toBeVisible()
          await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click()
          await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
          // Footer links animate their color over 180ms. Measure the settled
          // theme, not the intermediate light-on-light crossfade.
          await page.waitForTimeout(250)
          const contrast = await settings.evaluate(element => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
            const background = rgb(getComputedStyle(element).backgroundColor)
            const luminance = (channels: number[]) => channels.slice(0, 3).map(c => {
              const s = c / 255
              return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
            }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
            const bg = luminance(background)
            return [...element.querySelectorAll<HTMLElement>('.m-actionrow-label, .m-actionrow-value, .m-note, .m-panel > p')].map(node => {
              const color = rgb(getComputedStyle(node).color)
              const alpha = color[3] ?? 1
              const fg = luminance(color.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)))
              return { text: node.textContent, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
            })
          })
          for (const sample of contrast) expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)
          expect(await settings.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
          if (!reduced) {
            await mkdir(evidence, { recursive: true })
            await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-pane.png`), animations: 'disabled', timeout: 10_000 })
          }
          await settings.getByRole('button', { name: 'Back', exact: true }).click()
          await expect(settings).toHaveCount(0)
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
          // The rail is one row even before its source images finish loading.
          const rail = page.locator('.admin-gallery-strip').first()
          const items = rail.locator('.admin-gallery-strip-item')
          const tops = await items.evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().top))
          expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2)
          if (!reduced) await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-admin.png`), animations: 'disabled', timeout: 10_000 })
        }
        // Back from Settings restores the clean library URL; a resize never
        // introduces horizontal overflow; the console stays quiet.
        await page.setViewportSize({ width: size.width > 800 ? 428 : 1100, height: size.height })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
        await page.setViewportSize({ width: size.width, height: size.height })
        expect(new URL(page.url()).search).toBe('')
        expect(errors).toEqual([])
      } finally { await context.close() }
    })
  }
}
