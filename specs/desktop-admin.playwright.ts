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
 * drag titlebar at auto height, the strip frame with no overflow rule at
 * all — and WebKit is the engine where that shows first. Both signals come
 * only from the app's own CSS, so wait for them before measuring anything.
 */
const settleStyles = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => {
      const bar = document.querySelector('.desktop-titlebar')
      const rail = document.querySelector('.admin-gallery-strip-frame')
      return `${bar ? getComputedStyle(bar).height : 'none'}/${rail ? getComputedStyle(rail).overflowX : 'none'}`
    }), { timeout: 15_000 })
    .toBe('28px/auto')

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

        // The settings screen is shut until asked for, and the gear that
        // opens it is a 44px target in the Library heading's action row.
        const tab = page.locator('.admin-heading-actions').getByRole('button', { name: 'Settings', exact: true })
        const pane = page.locator('[data-screen="settings"]')
        const galleryList = page.locator('.gallery-list')
        await expect(pane).toHaveCount(0)
        await expect(tab).toHaveAttribute('aria-expanded', 'false')
        const tabBox = (await tab.boundingBox())!
        expect(tabBox.width).toBeGreaterThanOrEqual(44)

        // The rail-led owner shell: drag titlebar on top, shared mark and
        // Library heading in the rail, Add on the same action row, then the
        // quiet scope line before the cards.
        const bar = page.locator('.desktop-titlebar')
        const brand = page.locator('.admin-brand-mark')
        const heading = page.getByRole('heading', { name: 'Library', exact: true })
        await expect(bar).toBeVisible()
        await expect(brand).toBeVisible()
        await expect(heading).toBeVisible()
        await expect(page.getByRole('button', { name: 'Add Gallery', exact: true })).toBeVisible()
        const barBox = (await bar.boundingBox())!
        const headingBox = (await heading.boundingBox())!
        expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1)

        // One quiet line carries the local/cloud scope: the plan, the
        // retained-cloud count, and how many galleries live on this Mac.
        const sub = page.locator('.admin-library-sub')
        await expect(sub).toContainText('Visionary')
        await expect(sub).toContainText('Cloud galleries')
        await expect(sub).toContainText('2 Local galleries on this device')
        expect(api.calls()).toBeGreaterThan(0)

        // The settings screen swaps in for the gallery list — the rail stays.
        await tab.click()
        await expect(pane).toBeVisible()
        await expect(galleryList).toBeHidden()
        await expect(pane).toContainText('Visionary')
        await expect(pane).toContainText('Local galleries')
        await pane.getByRole('button', { name: 'Back to the library' }).click()
        await expect(pane).toHaveCount(0)
        await expect(galleryList).toBeVisible()

        // The local catalogue is on the page, in the web dashboard's type.
        // The pinned gallery rides the "Pinned galleries" strip with its rail
        // of originals; the unpinned one sits compact under "Local galleries".
        // The rail's geometry is measured in desktop-catalogue.playwright.ts.
        const cards = page.locator('.lib-card')
        const compact = page.locator('.lib-compact-card')
        await expect(cards).toHaveCount(1)
        await expect(compact).toHaveCount(1)
        await expect(cards.first()).toContainText('Bangkok Rain')
        await expect(cards.first()).toContainText('25 photographs')
        // The source is named by kind, never by its path: the root path and
        // mount point are local-only by contract and stay off the surface.
        await expect(cards.nth(0).locator('.lib-card-sub')).toContainText('This Mac')
        await expect(compact.nth(0).locator('.lib-card-sub')).toContainText('Memory card')
        await expect(page.locator('body')).not.toContainText('/Volumes/NO NAME/DCIM')
        await expect(page.locator('body')).not.toContainText('/Users/photographer/Pictures')
        // Each card carries exactly one ··· menu — the old workbench card
        // actions (View/Rescan/Share/Remove) stay off it.
        const anyCard = page.locator('.lib-card, .lib-compact-card')
        for (let index = 0; index < 2; index++) {
          await expect(anyCard.nth(index).locator('.lib-card-menu')).toHaveCount(1)
        }
        for (const old of ['View', 'Rescan', 'Share', 'Remove']) {
          await expect(page.locator('.lib-card button, .lib-compact-card button', { hasText: old })).toHaveCount(0)
        }

        for (const theme of ['dark', 'light'] as const) {
          await tab.click()
          await expect(pane).toBeVisible()
          await expect(galleryList).toBeHidden()
          await expect(tab).toHaveAttribute('aria-expanded', 'true')
          await expect(pane.getByRole('button', { name: 'Back to the library' })).toBeVisible()
          if (theme === 'light') await pane.getByRole('radio', { name: 'Light', exact: true }).click()
          await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
          // The panes' own copy is measured settled, not mid-crossfade.
          await page.waitForTimeout(250)
          const contrast = await pane.evaluate(element => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
            const background = rgb(getComputedStyle(element).backgroundColor)
            const luminance = (channels: number[]) => channels.slice(0, 3).map(c => {
              const s = c / 255
              return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
            }).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0)
            const bg = luminance(background)
            return [...element.querySelectorAll<HTMLElement>('.m-actionrow-label, .m-actionrow-value, label, .m-note, .m-error, .m-settings-address')].map(node => {
              const color = rgb(getComputedStyle(node).color)
              const alpha = color[3] ?? 1
              const fg = luminance(color.slice(0, 3).map((c, i) => c * alpha + background[i] * (1 - alpha)))
              return { text: node.textContent, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) }
            })
          })
          for (const sample of contrast) expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)

          // The screen swaps into the galleries' cell; its own width never
          // outgrows it.
          expect(await pane.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
          await expect(pane.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
          if (!reduced) {
            await mkdir(evidence, { recursive: true })
            await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-pane.png`), animations: 'disabled', timeout: 10_000 })
          }
          await pane.getByRole('button', { name: 'Back to the library' }).click()
          await expect(pane).toHaveCount(0)
          await expect(galleryList).toBeVisible()
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
          if (!reduced) await page.screenshot({ path: resolve(evidence, `${size.name}-${theme}-admin.png`), animations: 'disabled', timeout: 10_000 })
        }

        // The theme is the web dashboard's: same key, so a reload keeps it.
        expect(await page.evaluate(() => localStorage.getItem('manorama:theme'))).toBe('light')
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
        await expect(page.locator('html')).toHaveClass(/light/)
        await expect(pane).toHaveCount(0)
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
    const tab = page.locator('.admin-heading-actions').getByRole('button', { name: 'Settings', exact: true })
    const pane = page.locator('[data-screen="settings"]')
    await tab.click()
    await expect(pane).toBeVisible()
    // Crossing the 820px breakpoint stacks the workbench but must not disturb
    // the open settings screen, and the URL stays clean throughout.
    await page.setViewportSize({ width: 760, height: 520 })
    await expect(pane).toBeVisible()

    // The screen states the account's own address, taken from the session.
    await expect(page.locator('.m-settings-address')).toContainText('manorama.xyz/')
    await expect(page.locator('#web-settings-owner-address')).toHaveValue('thecontrarian')

    // The gear itself is the way back out alongside the pane's own ‹ Back —
    // it survives a second breakpoint trip for free.
    await page.setViewportSize({ width: 1280, height: 840 })
    await expect(pane).toBeVisible()
    await tab.click()
    await expect(pane).toHaveCount(0)

    await tab.click()
    await expect(pane).toBeVisible()
    await pane.getByRole('button', { name: 'Back to the library' }).click()
    await expect(pane).toHaveCount(0)
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
    const tab = page.locator('.admin-heading-actions').getByRole('button', { name: 'Settings', exact: true })
    const pane = page.locator('[data-screen="settings"]')

    for (const theme of ['dark', 'light'] as const) {
      // Fresh contexts start dark; light is reached through the settings
      // screen's own Appearance segment, exactly like the main spec.
      const isLight = await page.evaluate(() => document.documentElement.classList.contains('light'))
      if ((theme === 'light') !== isLight) {
        await tab.click()
        await expect(pane).toBeVisible()
        await pane.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click()
        await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
        await pane.getByRole('button', { name: 'Back to the library' }).click()
        await expect(pane).toHaveCount(0)
      }

      // Library → Gallery settings through the card's ··· menu.
      const card = page.locator('.lib-card').first()
      await card.locator('.lib-card-menu').click()
      await page.getByRole('dialog').getByRole('button', { name: 'More settings…' }).click()
      await expect(details).toBeVisible()
      // The sheet states the gallery's own facts once: the panel head
      // carries the title and the count/source line — never both.
      await expect(details.locator('.m-owner-panel-title')).toHaveText('Bangkok Rain')
      await expect(details.locator('.m-owner-panel-meta')).toContainText('25 photographs · Folder on this Mac')
      // An available source states nothing; local-only facts stay off the
      // surface: no paths, no invented public/provider/vault/offline metadata.
      await expect(details.locator('[data-availability]')).toHaveCount(0)
      await expect(details).not.toContainText('/Users/photographer/Pictures')
      await expect(details).not.toContainText('/Volumes')
      for (const banned of ['public', 'provider', 'vault', 'offline']) {
        await expect(details).not.toContainText(banned)
      }
      // The cloud sheet's full row set, in its order — management rows
      // mirror the card menu's verbs, and the only absent slice is the
      // device group a gallery of local files cannot use.
      await expect(details.locator('.m-actionrow')).toHaveCount(8)
      const labels = await details.locator('.m-actionrow-label').allTextContents()
      expect(labels.map(label => label.trim())).toEqual([
        'Open gallery', 'View source',
        'Name', 'Caption', 'Address',
        'Reorder photographs', 'Refresh gallery contents',
        'Remove from Library',
      ])

      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `window-${theme}-details.png`), animations: 'disabled', timeout: 10_000 })

      // Publish opens the shared Sheet: the sheet presentation, never
      // the inline header, and the upload-confirmation copy. Nothing here may
      // connect or upload to a real provider. The action lives in the card
      // menu, so the settings sheet closes first.
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
      await expect(details).toHaveCount(0)
      await card.locator('.lib-card-menu').click()
      await page.getByRole('dialog').getByRole('button', { name: 'Publish this gallery' }).click()
      const share = page.locator('.desktop-share--sheet')
      await expect(share).toBeVisible()
      await expect(page.locator('.desktop-share-header')).toHaveCount(0)
      await expect(page.locator('.m-sheet')).toBeVisible()
      await expect(share).toContainText('nothing uploads until you confirm')
      await expect(share).toContainText('Dropbox')
      await expect(share).toContainText('Google Drive')
      await page.screenshot({ path: resolve(evidence, `window-${theme}-share.png`), animations: 'disabled', timeout: 10_000 })

      // Closing the sheet returns to the Library and the URL is clean.
      await page.getByRole('button', { name: 'Close' }).click()
      await expect(share).toBeHidden()
      await expect(page.locator('.desktop-catalogue')).toBeVisible()
      expect(new URL(page.url()).search).toBe('')
    }

    expect(errors).toEqual([])
  } finally { await context.close() }
})
