import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { blockProductionApi, bridgePayload, installBridge } from './desktop-admin-fixture'

/**
 * The macOS catalogue's admin surface, exercised in a real browser.
 *
 * The desktop bundle is a client-only SPA: outside the Tauri webview its IPC
 * bridge is absent, so the shell would stop at the welcome screen. The shared
 * fixture installs the bridge before any page script runs and answers the
 * handful of commands the catalogue actually calls, which is what lets the
 * signed-in surface render at all. Everything asserted below — quadrants,
 * pane, theme, focus, contrast, overflow — is then the real bundle's own
 * behaviour, not a fixture's. The screenshots are browser evidence for the
 * desktop shell and are deliberately NOT presented as native macOS captures.
 *
 * Run against `bun run dev:desktop` (port 5175).
 */

const base = process.env.DESKTOP_URL ?? 'http://localhost:5175'
const evidence = resolve('demo-captures/desktop-admin')

const sizes = [
  { name: 'window', width: 1280, height: 840 },
  { name: 'narrow', width: 1024, height: 700 },
  // The Tauri window's declared minimum: below 820px the workbench stacks.
  { name: 'minimum', width: 760, height: 520 },
  { name: 'wide', width: 2560, height: 1440 },
]

for (const size of sizes) {
  for (const reduced of [false, true]) {
    test(`desktop admin ${size.name}${reduced ? ' without motion' : ''}: quadrants, pane, both themes`, async ({ browser }) => {
      test.setTimeout(75_000)
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        reducedMotion: reduced ? 'reduce' : 'no-preference',
      })
      await context.addInitScript(installBridge, bridgePayload)
      try {
        const page = await context.newPage()
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        // The bundle's default API base is production. Nothing in this spec
        // may reach it: the catalogue's sync seam is answered locally, which
        // also proves the seam still fires after the redesign.
        const api = await blockProductionApi(page)
        await page.goto(base, { waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })

        // The pane is closed until asked for, and the tab that opens it is a
        // 44px target centred on the left edge.
        const tab = page.getByRole('button', { name: 'Account menu', exact: true })
        const dialog = page.getByRole('dialog', { name: 'Account', exact: true })
        await expect(dialog).toBeHidden()
        await expect(tab).toHaveAttribute('aria-expanded', 'false')
        const tabBox = (await tab.boundingBox())!
        expect(tabBox.x).toBeLessThanOrEqual(1)
        expect(Math.abs(tabBox.y + tabBox.height / 2 - size.height / 2)).toBeLessThan(2)
        expect(tabBox.width).toBeGreaterThanOrEqual(44)

        // Two quadrants and the gallery list below both of them.
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
        const logoBox = (await welcome.locator('img').boundingBox())!
        expect(logoBox.x + logoBox.width).toBeLessThanOrEqual(welcomeBox.x + welcomeBox.width)

        // The account's own facts, not invented copy: the name and plan the
        // session carries, and the count of galleries this Mac holds.
        await expect(welcome).toContainText('Welcome to manorama.xyz.')
        await expect(welcome).toContainText('You are a Pro User.')
        await expect(welcome).toContainText('2 galleries on this Mac.')
        await expect(importer.getByRole('button', { name: 'Choose a folder or card' })).toBeVisible()
        await expect(importer).toContainText('2 galleries on this Mac')
        // The catalogue syncs gallery-level metadata only, and says so quietly.
        await expect(page.locator('.desktop-sync-state')).toContainText('Catalogue synced.')
        expect(api.calls()).toBeGreaterThan(0)

        // The local catalogue is on the page, in the web dashboard's type.
        const rows = page.locator('.desktop-gallery')
        await expect(rows).toHaveCount(2)
        await expect(rows.first()).toContainText('Bangkok Rain')
        await expect(rows.first()).toContainText('(25 photos)')
        await expect(page.getByText('/Volumes/NO NAME/DCIM')).toBeVisible()

        for (const theme of ['dark', 'light'] as const) {
          await tab.click()
          await expect(dialog).toBeVisible()
          await expect(tab).toHaveAttribute('aria-expanded', 'true')
          await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()
          if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
          await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
          // Footer links animate their colour over 180ms; measure the settled
          // theme rather than the crossfade.
          await page.waitForTimeout(250)
          const contrast = await dialog.evaluate(element => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
            const background = rgb(getComputedStyle(element).backgroundColor)
            const luminance = (channels: number[]) => channels.slice(0, 3).map(c => {
              const s = c / 255
              return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
            }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
            const bg = luminance(background)
            return [...element.querySelectorAll<HTMLElement>('.admin-intro, .admin-greeting, .admin-drawer-action, .site-footer-link, .site-footer-copy')].map(node => {
              const color = rgb(getComputedStyle(node).color)
              const alpha = color[3] ?? 1
              const fg = luminance(color.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)))
              return { text: node.textContent, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
            })
          })
          for (const sample of contrast) expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)

          const panelBox = (await dialog.boundingBox())!
          expect(Math.abs(panelBox.x)).toBeLessThan(1)
          const paneLogo = (await dialog.locator('.admin-brand-logo').boundingBox())!
          expect(paneLogo.x).toBeGreaterThanOrEqual(panelBox.x)
          expect(paneLogo.x + paneLogo.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
          expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
          // Tab stays inside the pane: the last action wraps to the close button.
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
          if (!reduced) await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-admin.png`), animations: 'disabled', timeout: 10_000 })
        }

        // The theme is the web dashboard's: same key, so a reload keeps it.
        expect(await page.evaluate(() => localStorage.getItem('manorama:theme'))).toBe('light')
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
        await expect(page.locator('html')).toHaveClass(/light/)
        await expect(dialog).toBeHidden()
        expect(new URL(page.url()).search).toBe('')
        expect(errors).toEqual([])
      } finally { await context.close() }
    })
  }
}

test('the desktop admin surface survives a resize without losing the pane state', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  await context.addInitScript(installBridge, bridgePayload)
  try {
    const page = await context.newPage()
    await blockProductionApi(page)
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
    const tab = page.getByRole('button', { name: 'Account menu', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Account', exact: true })
    await tab.click()
    await expect(dialog).toBeVisible()
    // Crossing the 820px breakpoint stacks the workbench but must not disturb
    // the open pane, and the URL stays clean throughout.
    await page.setViewportSize({ width: 760, height: 520 })
    await expect(dialog).toBeVisible()

    // The pane states the account's own address, taken from the session.
    await expect(page.locator('.admin-greeting-url')).toHaveText('manorama.xyz/thecontrarian')

    // Backdrop interaction is the third way out, alongside Esc and the close
    // button — and it hands focus back to the tab like the other two.
    await page.mouse.click(700, 300)
    await expect(dialog).toBeHidden()
    await expect(tab).toBeFocused()

    await tab.click()
    await expect(dialog).toBeVisible()
    await page.getByRole('button', { name: 'Close account menu' }).click()
    await expect(dialog).toBeHidden()
    await expect(tab).toBeFocused()
    expect(new URL(page.url()).search).toBe('')
  } finally { await context.close() }
})
