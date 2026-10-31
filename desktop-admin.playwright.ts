import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { blockProductionApi, bridgePayload, GALLERY_ID, installBridge } from './desktop-admin-fixture'

/**
 * The macOS catalogue's admin surface, exercised in a real browser.
 *
 * The desktop bundle is a client-only SPA: outside the Tauri webview its IPC
 * bridge is absent, so the shell would stop at the welcome screen. The shared
 * fixture installs the bridge before any page script runs and answers the
 * handful of commands the catalogue actually calls, which is what lets the
 * signed-in surface render at all. Everything asserted below — quadrants,
 * pane, theme, focus, contrast, overflow, and the Library → Details → share
 * flow — is then the real bundle's own behaviour, not a fixture's. The
 * screenshots are browser evidence for the desktop shell and are deliberately
 * NOT presented as native macOS captures.
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

/**
 * dev serves the stylesheet out of the module graph, so it can land after the
 * DOM does. An unstyled page still measures plausible-looking numbers — the
 * edge tab at the body's 8px margin, the drawer scrim with no size at all — and
 * WebKit is the engine where that shows first. Both signals come only from the
 * app's own CSS, so wait for them before measuring anything.
 */
const settleStyles = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => {
      const bar = document.querySelector('.m-topbar')
      const scrim = document.querySelector('.admin-drawer-scrim')
      return `${bar ? getComputedStyle(bar).height : 'none'}/${scrim ? getComputedStyle(scrim).position : 'none'}`
    }), { timeout: 15_000 })
    .toBe('52px/absolute')

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
        await settleStyles(page)

        // The pane is closed until asked for, and the gear that opens it is a
        // 44px target parked in the shared top bar's end slot — the same
        // contract as the web and native libraries.
        const tab = page.getByRole('button', { name: 'Settings', exact: true })
        const dialog = page.getByRole('dialog', { name: 'Account', exact: true })
        await expect(dialog).toBeHidden()
        await expect(tab).toHaveAttribute('aria-expanded', 'false')
        const tabBox = (await tab.boundingBox())!
        expect(tabBox.x).toBeGreaterThan(size.width / 2)
        expect(tabBox.y).toBeLessThan(52)
        expect(tabBox.width).toBeGreaterThanOrEqual(44)

        // The compact owner shell: shared mark in the bar, Library and Add on
        // one row, then the quiet scope/sync line before the cards.
        const bar = page.locator('.m-topbar')
        const heading = page.getByRole('heading', { name: 'Library', exact: true })
        await expect(bar).toBeVisible()
        await expect(bar.locator('img.m-topbar-logo')).toBeVisible()
        await expect(heading).toBeVisible()
        await expect(page.getByRole('button', { name: 'Add Gallery', exact: true })).toBeVisible()
        const barBox = (await bar.boundingBox())!
        const headingBox = (await heading.boundingBox())!
        expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1)

        // One quiet line carries the local/cloud scope: the Mac's label, its
        // gallery and photograph counts, and the last sync outcome.
        const sub = page.locator('.admin-library-sub')
        await expect(sub).toContainText('2 galleries')
        await expect(sub).toContainText('photographs')
        await expect(sub).toContainText('Catalogue synced.')
        expect(api.calls()).toBeGreaterThan(0)

        // The account's own facts — the plan the session carries — live in
        // the pane, not as a persistent introduction on the page.
        await tab.click()
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('You are a Visionary.')
        await expect(dialog).toContainText('2 galleries')
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()

        // The local catalogue is on the page, in the web dashboard's type.
        // The galleries are the shared Library cards, each hanging its rail of
        // originals above the title row. The rail's geometry is measured in
        // desktop-catalogue.playwright.ts.
        const cards = page.locator('.lib-card')
        await expect(cards).toHaveCount(2)
        await expect(cards.first()).toContainText('Bangkok Rain')
        await expect(cards.first()).toContainText('25 photographs')
        // The source is named by kind, never by its path: the root path and
        // mount point are local-only by contract and stay off the surface.
        await expect(cards.nth(0).locator('.lib-card-sub')).toContainText('Folder on this Mac')
        await expect(cards.nth(1).locator('.lib-card-sub')).toContainText('Memory card')
        await expect(page.locator('body')).not.toContainText('/Volumes/NO NAME/DCIM')
        await expect(page.locator('body')).not.toContainText('/Users/photographer/Pictures')
        // Each card carries exactly one ··· menu — the old workbench card
        // actions (View/Rescan/Share/Remove) stay off it.
        for (let index = 0; index < 2; index++) {
          await expect(cards.nth(index).locator('.lib-card-menu')).toHaveCount(1)
        }
        for (const old of ['View', 'Rescan', 'Share', 'Remove']) {
          await expect(page.locator('.lib-card button', { hasText: old })).toHaveCount(0)
        }

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
            return [...element.querySelectorAll<HTMLElement>('.admin-greeting-url, .desktop-device-line, .admin-drawer-action, .site-footer-link, .site-footer-copy')].map(node => {
              const color = rgb(getComputedStyle(node).color)
              const alpha = color[3] ?? 1
              const fg = luminance(color.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)))
              return { text: node.textContent, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
            })
          })
          for (const sample of contrast) expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)

          const panelBox = (await dialog.boundingBox())!
          expect(Math.abs(panelBox.x)).toBeLessThan(1)
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
    await settleStyles(page)
    const tab = page.getByRole('button', { name: 'Settings', exact: true })
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
    // button — and it hands focus back to the tab like the other two. The
    // scrim is unreachable while the pane is a full-screen sheet at phone
    // width, so the click happens after crossing back to window size; the
    // pane surviving a second breakpoint trip is covered for free.
    await page.setViewportSize({ width: 1280, height: 840 })
    await expect(dialog).toBeVisible()
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

test('desktop admin details: Library → Details → share sheet, both themes, clean back', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  await context.addInitScript(installBridge, bridgePayload)
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await blockProductionApi(page)
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
    await settleStyles(page)

    const details = page.locator('[data-screen="local-details"]')
    const tab = page.getByRole('button', { name: 'Settings', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Account', exact: true })

    for (const theme of ['dark', 'light'] as const) {
      // Fresh contexts start dark; light is reached through the pane's own
      // control, exactly like the main spec.
      const isLight = await page.evaluate(() => document.documentElement.classList.contains('light'))
      if ((theme === 'light') !== isLight) {
        await tab.click()
        await expect(dialog).toBeVisible()
        await page.getByRole('button', { name: theme === 'light' ? 'Switch to light mode' : 'Switch to dark mode', exact: true }).click()
        await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      }

      // Library → Details through the card's ··· menu → Gallery details.
      const card = page.locator('.lib-card').first()
      await card.locator('.lib-card-menu').click()
      await page.getByRole('dialog').getByRole('button', { name: 'Gallery details' }).click()
      await expect(details).toBeVisible()
      expect(new URL(page.url()).searchParams.get('details')).toBe(GALLERY_ID)
      // The surface states the gallery's own facts once: the top bar carries
      // Back, the body carries the title — never both.
      await expect(details.locator('.m-topbar-title')).toHaveCount(0)
      await expect(details.locator('.d-name')).toHaveText('Bangkok Rain')
      await expect(details.locator('.d-sub').first()).toHaveText('25 photographs · Folder on this Mac')
      await expect(details.locator('[data-availability="available"]')).toHaveText('Source available')
      // Local-only facts stay off the surface: no paths, no invented
      // public/provider/vault/offline/reorder metadata.
      await expect(details).not.toContainText('/Users/photographer/Pictures')
      await expect(details).not.toContainText('/Volumes')
      for (const banned of ['public', 'provider', 'vault', 'offline', 'reorder']) {
        await expect(details).not.toContainText(banned)
      }
      // Exactly the five action rows, in the contract's order, and no more.
      await expect(details.locator('.m-actionrow')).toHaveCount(5)
      const labels = await details.locator('.m-actionrow-label').allTextContents()
      expect(labels.map(label => label.trim())).toEqual(['Open', 'Publish', 'Name', 'Read the folder again', 'Remove from Library'])

      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `window-${theme}-details.png`), animations: 'disabled', timeout: 10_000 })

      // Publish opens the shared Sheet: the sheet presentation, never
      // the inline header, and the upload-confirmation copy. Nothing here may
      // connect or upload to a real provider.
      await details.getByRole('button', { name: 'Publish' }).click()
      const share = page.locator('.desktop-share--sheet')
      await expect(share).toBeVisible()
      await expect(page.locator('.desktop-share-header')).toHaveCount(0)
      await expect(page.locator('.m-sheet')).toBeVisible()
      await expect(share).toContainText('nothing uploads until you confirm')
      await expect(share).toContainText('Dropbox')
      await expect(share).toContainText('Google Drive')
      await page.screenshot({ path: resolve(evidence, `window-${theme}-share.png`), animations: 'disabled', timeout: 10_000 })

      // Closing the sheet returns to Details, untouched.
      await page.getByRole('button', { name: 'Close' }).click()
      await expect(share).toBeHidden()
      await expect(details).toBeVisible()

      // Back returns to the Library and the URL is clean.
      await details.getByRole('button', { name: 'Back' }).click()
      await expect(page.locator('.desktop-catalogue')).toBeVisible()
      await expect(details).toHaveCount(0)
      expect(new URL(page.url()).search).toBe('')
    }

    expect(errors).toEqual([])
  } finally { await context.close() }
})
