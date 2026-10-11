import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  blockProductionApi,
  buildCatalogue,
  installBridge,
  photoBridgePayload,
  photosFrom,
  servePhotos,
  type FixturePhoto,
} from './desktop-admin-fixture'

/**
 * macOS Catalogue parity: the web/iOS admin workbench, in the desktop shell.
 *
 * The desktop SPA talks to Tauri over `window.__TAURI_INTERNALS__`, which is the
 * only place the official API reads. Stubbing it there lets the real island run
 * its real launch path — restore the session, read the catalogue, probe the
 * sources — in a plain browser, which is what makes this suite possible without
 * a bundled app. Thumbnails are the owner's originals, served read-only through
 * a route interception: nothing is copied, resized or re-encoded, so the pink
 * frame and the aspect-true widths are measured against the real files.
 *
 * The evidence these tests write are browser captures at the app's own window
 * sizes. They are not native screenshots and are not stored with them.
 *
 * WebKit is the engine the macOS webview ships (WKWebView); Chromium is run
 * alongside it as a second opinion.
 */

const base = process.env.DESKTOP_URL ?? 'http://localhost:5176'
// The owner's own photographs, read-only. The albums under Dropbox
// `CloudStorage` are dataless placeholders on this machine (0 bytes on disk,
// `sips` reports `<nil>`), so the fixture has to come from a folder whose
// pixels are actually present.
const SOURCE = process.env.MANORAMA_DESKTOP_SOURCE ?? '/Users/home/Pictures'
const FIXTURE_COUNT = 12

const evidence = resolve('outputs/desktop-catalogue-parity')

/** tauri.conf.json's window — the app opens at this size, and 760 is its floor. */
const sizes = [
  { name: 'window-1280x840', width: 1280, height: 840 },
  { name: 'wide-1440x900', width: 1440, height: 900 },
  { name: 'minimum-760x620', width: 760, height: 620 },
]

/** An absent folder is a skip, not a load failure. */
const readPhotos = (): FixturePhoto[] => {
  try {
    return photosFrom(SOURCE, FIXTURE_COUNT)
  } catch {
    return []
  }
}

const allPhotos = readPhotos()
const built = buildCatalogue(allPhotos, SOURCE)

/** Signed in, catalogue seeded, originals served from disk. */
const openCatalogue = async (page: Page) => {
  // The originals are served from disk by the shared fixture, and the sync seam
  // is answered locally: the suite stays deterministic and never reaches the
  // real API.
  await servePhotos(page, allPhotos)
  const api = await blockProductionApi(page)
  await page.addInitScript(installBridge, photoBridgePayload(built))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.desktop-catalogue')).toBeVisible({ timeout: 15_000 })
  // dev serves the stylesheet out of the module graph, so it can land after the
  // DOM does. An unstyled page still measures plausible-looking numbers — a
  // 2170px logo, an edge tab at the body's 8px margin — and every geometry
  // assertion below would be measuring nothing. Both signals come only from the
  // app's own CSS.
  await expect
    .poll(() => page.evaluate(() => {
      const tab = document.querySelector('.admin-edge-tab')
      const rail = document.querySelector('.admin-gallery-strip-frame')
      return `${tab ? getComputedStyle(tab).position : 'none'}/${rail ? getComputedStyle(rail).overflowX : 'none'}`
    }), { timeout: 15_000 })
    .toBe('fixed/auto')
  // The rail's geometry is only meaningful once the originals have decoded.
  await expect
    .poll(async () => page.locator('.desktop-catalogue img.is-loaded').count(), { timeout: 30_000, intervals: [250, 500] })
    .toBe(allPhotos.length)
  return api
}

/** One gapless row: equal heights, source-true widths, no gaps, pink first frame. */
const measureRail = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('.admin-gallery-card') as HTMLElement
    const frame = card.querySelector('.admin-gallery-strip-frame') as HTMLElement
    const items = [...card.querySelectorAll('.admin-gallery-strip-item')] as HTMLElement[]
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    return {
      count: items.length,
      rows: new Set(items.map((item) => Math.round(item.getBoundingClientRect().y))).size,
      boxes: items.slice(0, 5).map((item) => {
        const image = item.querySelector('img') as HTMLImageElement
        const style = getComputedStyle(item)
        return {
          ...box(item),
          aspect: image.naturalWidth / image.naturalHeight,
          outline: `${style.outlineWidth} ${style.outlineColor}`,
          disabled: (item as HTMLButtonElement).disabled,
        }
      }),
      frame: { ...box(frame), scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth },
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      firstFrameIsButton: items[0]?.tagName,
    }
  })

const paneContrast = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('.admin-drawer-panel') as HTMLElement
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
    const luminance = (channels: number[]) =>
      channels.slice(0, 3)
        .map((channel) => {
          const s = channel / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const background = rgb(getComputedStyle(panel).backgroundColor)
    const bg = luminance(background)
    return [...panel.querySelectorAll<HTMLElement>('.admin-intro, .admin-greeting, .admin-drawer-action, .site-footer-link, .site-footer-copy, .desktop-device-line')].map((node) => {
      const color = rgb(getComputedStyle(node).color)
      const alpha = color[3] ?? 1
      const fg = luminance(color.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha)))
      return { text: node.textContent?.slice(0, 40), ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) }
    })
  })

for (const size of sizes) {
  test(`${size.name}: workbench, account pane, both themes, rail geometry`, async ({ page }, testInfo) => {
    test.setTimeout(180_000)
    test.skip(allPhotos.length < 4, `no photographs with pixels on disk under ${SOURCE}`)
    const engine = testInfo.project.name
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: size.width, height: size.height })
    const api = await openCatalogue(page)

    // The shell announces itself ready only once the catalogue is restored, so
    // this is the gate for everything below.
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()

    // ── The account surface speaks the shared vocabulary ───────────────────
    // The same sentences the web dashboard's and iOS's panes use, with the
    // Mac's own local fact after them.
    const planSentence = 'You are a Pro User.'
    await expect(page.locator('.admin-welcome-note')).toContainText('Welcome to manorama.xyz.')
    await expect(page.locator('.admin-welcome-note')).toContainText(planSentence)
    await expect(page.locator('.admin-welcome-note')).toContainText(`${built.galleries.length} galleries on this Mac.`)
    await expect(page.locator('.admin-limit-count')).toContainText('on this Mac')
    await expect(page.locator('.desktop-sync-state')).toContainText('Catalogue synced.')
    // The launch really did call the account's seam, and the fixture answered.
    expect(api.calls()).toBeGreaterThan(0)
    // Both sources are on the page: the folder of originals and the card.
    await expect(page.locator('.admin-gallery-card')).toHaveCount(built.galleries.length)
    await expect(page.getByText('/Volumes/NO NAME/DCIM')).toBeVisible()

    // ── The workbench, arranged like the web dashboard and iOS admin ────────
    const welcome = page.getByRole('region', { name: 'Welcome to manorama' })
    const importer = page.getByRole('region', { name: 'Add a gallery' })
    const heading = page.getByRole('heading', { name: 'Your galleries', exact: true })
    await expect(welcome).toBeVisible()
    await expect(importer).toBeVisible()
    await expect(heading).toBeVisible()
    const welcomeBox = (await welcome.boundingBox())!
    const importBox = (await importer.boundingBox())!
    const headingBox = (await heading.boundingBox())!
    // Which branch applies is the stylesheet's call, and the engine's scrollbar
    // decides the layout width it is measured against: WebKit's classic
    // scrollbar takes ~15px off a 1440 window, so the same CSS splits in
    // Chromium and stacks in WebKit. Both are correct — this asserts the
    // intended geometry of whichever branch is in force, at every size.
    const split = welcomeBox.x + welcomeBox.width < size.width / 2 + 1
    if (split) {
      expect(importBox.x).toBeGreaterThan(size.width / 2)
      expect(Math.abs(welcomeBox.y - importBox.y)).toBeLessThan(2)
    } else {
      expect(importBox.y).toBeGreaterThanOrEqual(welcomeBox.y + welcomeBox.height - 1)
    }
    expect(headingBox.y).toBeGreaterThanOrEqual(Math.max(welcomeBox.y + welcomeBox.height, importBox.y + importBox.height) - 1)

    // The account controls are one labelled tab on the left edge, vertically
    // centred, and the pane is shut until it is asked for.
    const tab = page.getByRole('button', { name: 'Account menu', exact: true })
    const pane = page.getByRole('dialog', { name: 'Account', exact: true })
    await expect(pane).toBeHidden()
    await expect(tab).toHaveAttribute('aria-expanded', 'false')
    const tabBox = (await tab.boundingBox())!
    expect(tabBox.x).toBeLessThanOrEqual(1)
    expect(Math.abs(tabBox.y + tabBox.height / 2 - size.height / 2)).toBeLessThan(2)
    expect(tabBox.width).toBeGreaterThanOrEqual(44)

    // ── One gapless, aspect-true rail of clickable originals ───────────────
    const rail = await measureRail(page)
    expect(rail.count).toBe(allPhotos.length)
    expect(rail.rows).toBe(1)
    expect(rail.firstFrameIsButton).toBe('BUTTON')
    const heights = rail.boxes.map((box) => box.height)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5)
    // Fit to the viewport height (native/styles.css: clamp(96px, 16dvh, 208px)).
    const expectedHeight = Math.min(Math.max(96, size.height * 0.16), 208)
    expect(Math.abs(heights[0] - expectedHeight)).toBeLessThan(2)
    for (let index = 0; index < rail.boxes.length - 1; index++) {
      const current = rail.boxes[index]
      const next = rail.boxes[index + 1]
      expect(Math.abs(next.x - (current.x + current.width))).toBeLessThan(1.5)
    }
    for (const box of rail.boxes) expect(Math.abs(box.width / box.height - box.aspect)).toBeLessThan(0.02)
    // The gallery's face carries the shocking pink the picker gives the
    // photograph in hand.
    expect(rail.boxes[0].outline).toBe('3px rgb(252, 15, 192)')
    // The rail is a real horizontal travel, not a wrapped or clipped row.
    expect(rail.frame.scrollWidth).toBeGreaterThan(rail.frame.clientWidth + 1)
    expect(rail.documentOverflow).toBeLessThanOrEqual(1)

    for (const theme of ['dark', 'light'] as const) {
      await tab.click()
      await expect(pane).toBeVisible()
      await expect(tab).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()
      if (theme === 'light') await pane.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
      await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
      // The pane's copy settles before it is measured or photographed.
      await page.waitForTimeout(250)

      expect(await pane.evaluate((element) => Math.abs(element.getBoundingClientRect().x))).toBeLessThan(1)
      expect(await pane.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      for (const sample of await paneContrast(page)) {
        expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)
      }

      // Tab is a loop inside the pane, not a walk into the galleries behind it.
      await page.getByRole('button', { name: 'Sign out', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: 'Close account menu' })).toBeFocused()

      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-${theme}-pane.png`), animations: 'disabled', timeout: 15_000 })
      await page.keyboard.press('Escape')
      await expect(pane).toBeHidden()
      await expect(tab).toBeFocused()
      await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-${theme}-catalogue.png`), animations: 'disabled', timeout: 15_000 })

      // The stage is a neutral near-black by contract: opening a photograph in
      // light mode must not carry the light ink onto it, and returning must
      // restore the choice.
      if (theme === 'light' && size.name.startsWith('window')) {
        await page.locator('.admin-gallery-strip-item').nth(2).click()
        await expect(page.locator('.curtain')).toBeVisible({ timeout: 15_000 })
        // The class is applied from the island's effect, so it lands a frame
        // after the DOM that proves the stage opened.
        await expect
          .poll(() => page.locator('html').evaluate((element) => element.classList.contains('light')), { timeout: 10_000 })
          .toBe(false)
        await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-light-stage.png`), animations: 'disabled', timeout: 15_000 })
        await page.getByRole('button', { name: 'Back to the catalogue' }).click()
        await expect(page.locator('.desktop-catalogue')).toBeVisible()
        await expect
          .poll(() => page.locator('html').evaluate((element) => element.classList.contains('light')), { timeout: 10_000 })
          .toBe(true)
      }
    }

    expect(errors).toEqual([])
  })
}
