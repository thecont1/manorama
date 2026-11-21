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
      const bar = document.querySelector('.desktop-titlebar')
      const rail = document.querySelector('.admin-gallery-strip-frame')
      return `${bar ? getComputedStyle(bar).height : 'none'}/${rail ? getComputedStyle(rail).overflowX : 'none'}`
    }), { timeout: 15_000 })
    .toBe('28px/auto')
  // The rail's geometry is only meaningful once the originals have decoded.
  // A pinned gallery keeps its compact cover in the home section too, so
  // each pin adds one more decoded image beside the rail's own.
  const pinnedCovers = built.galleries.filter((gallery) => gallery.pinnedAt).length
  await expect
    .poll(async () => page.locator('.desktop-catalogue img.is-loaded').count(), { timeout: 30_000, intervals: [250, 500] })
    .toBe(allPhotos.length + pinnedCovers)
  return api
}

/** One gapless row: equal heights, source-true widths, no gaps, pink first frame. */
const measureRail = (page: Page) =>
  page.evaluate(() => {
    const card = document.querySelector('.lib-card') as HTMLElement
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
          disabled: (item.firstElementChild as HTMLButtonElement | null)?.disabled ?? false,
        }
      }),
      frame: { ...box(frame), scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth },
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      firstFrameIsButton: items[0]?.firstElementChild?.tagName,
    }
  })

const paneContrast = (page: Page) =>
  page.evaluate(() => {
    const panel = document.querySelector('[data-screen="settings"]') as HTMLElement
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
    return [...panel.querySelectorAll<HTMLElement>('.m-actionrow-label, .m-actionrow-value, label, .m-note, .m-error, .m-settings-address')].map((node) => {
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
    // This config declares no projects, so the project name is empty and a
    // `-` prefix would land in every filename. Fall back to the browser in use.
    const engine = testInfo.project.name || String(testInfo.project.use?.defaultBrowserType ?? 'browser')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: size.width, height: size.height })
    const api = await openCatalogue(page)

    // The shell announces itself ready only once the catalogue is restored, so
    // this is the gate for everything below.
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()

    // ── The account surface speaks the shared vocabulary ───────────────────
    // Scope and sync ride the quiet status line; the plan and the Mac's own
    // facts live in the account pane, not a persistent introduction.
    const sub = page.locator('.admin-library-sub')
    await expect(sub).toContainText('Visionary')
    await expect(sub).toContainText('Cloud galleries')
    await expect(sub).toContainText(`${built.galleries.length} Local galleries on this device`)
    // The launch really did call the account's seam, and the fixture answered.
    expect(api.calls()).toBeGreaterThan(0)
    // Both sources are on the page: the pinned folder rides the "Pinned
    // galleries" strip AND keeps its compact card; both sit compact under
    // "Local galleries".
    await expect(page.locator('.lib-card')).toHaveCount(1)
    await expect(page.locator('.lib-compact-card')).toHaveCount(2)
    // Sources are named by kind, never by path — the roots are local-only by
    // contract and stay off the surface.
    await expect(page.locator('.lib-card').nth(0).locator('.lib-card-sub')).toContainText('This Mac')
    await expect(page.locator('.lib-compact-card', { hasText: 'Monsoon Card' }).locator('.lib-card-sub')).toContainText('Memory card')
    await expect(page.locator('.lib-compact-card', { hasText: 'Pictures' })).toHaveCount(1)
    await expect(page.locator('body')).not.toContainText('/Volumes/NO NAME/DCIM')
    await expect(page.locator('body')).not.toContainText(SOURCE)
    // Each card carries exactly one ··· menu — the old workbench card actions
    // (View/Rescan/Share/Remove) stay off it. One strip plus each gallery's
    // home card.
    const cardTotal = await page.locator('.lib-card, .lib-compact-card').count()
    for (let index = 0; index < cardTotal; index++) {
      const card = page.locator('.lib-card, .lib-compact-card').nth(index)
      await expect(card.locator('.lib-card-menu')).toHaveCount(1)
    }
    for (const old of ['View', 'Rescan', 'Share', 'Remove']) {
      await expect(page.locator('.lib-card button, .lib-compact-card button', { hasText: old })).toHaveCount(0)
    }

    // ── The rail-led owner shell, like the web Library ────────────────────
    // Drag titlebar on top, shared mark and Library heading in the rail,
    // Add on the same action row, cards under the quiet status line.
    const bar = page.locator('.desktop-titlebar')
    const heading = page.getByRole('heading', { name: 'Library', exact: true })
    await expect(bar).toBeVisible()
    await expect(page.locator('.admin-brand-mark')).toBeVisible()
    await expect(heading).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Gallery', exact: true })).toBeVisible()
    const barBox = (await bar.boundingBox())!
    const headingBox = (await heading.boundingBox())!
    expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1)

    // One labelled control opens the settings screen — the gear in the
    // heading's action row — and the screen is shut until it is asked for.
    const tab = page.locator('.admin-heading-actions').getByRole('button', { name: 'Settings', exact: true })
    const pane = page.locator('[data-screen="settings"]')
    const galleryList = page.locator('.gallery-list')
    await expect(pane).toHaveCount(0)
    await expect(tab).toHaveAttribute('aria-expanded', 'false')
    const tabBox = (await tab.boundingBox())!
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
    // Shocking pink belongs to the photograph in hand inside the picker. This
    // rail marks the gallery it opens with an ink outline instead, so a row of
    // galleries is not a row of pink frames.
    expect(rail.boxes[0].outline).not.toBe('3px rgb(252, 15, 192)')
    expect(rail.boxes[0].outline).not.toBe('none')
    // The rail is a real horizontal travel, not a wrapped or clipped row.
    expect(rail.frame.scrollWidth).toBeGreaterThan(rail.frame.clientWidth + 1)
    expect(rail.documentOverflow).toBeLessThanOrEqual(1)

    for (const theme of ['dark', 'light'] as const) {
      await tab.click()
      await expect(pane).toBeVisible()
      await expect(galleryList).toBeHidden()
      await expect(tab).toHaveAttribute('aria-expanded', 'true')
      if (theme === 'light') await pane.getByRole('radio', { name: 'Light', exact: true }).click()
      await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light)/)
      // The screen's copy settles before it is measured or photographed.
      await page.waitForTimeout(250)

      expect(await pane.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      for (const sample of await paneContrast(page)) {
        expect(sample.ratio, `${theme} ${sample.text}`).toBeGreaterThanOrEqual(4.5)
      }

      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-${theme}-pane.png`), animations: 'disabled', timeout: 15_000 })
      await pane.getByRole('button', { name: 'Back to the library' }).click()
      await expect(pane).toHaveCount(0)
      await expect(galleryList).toBeVisible()
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
        // The stage opens behind its entry curtain; enter it the way a viewer
        // does, so the stage (and its exit cue) are actually reachable.
        await page.getByRole('button', { name: 'Enter gallery' }).click()
        await expect(page.locator('[data-curtain]')).toBeHidden({ timeout: 15_000 })
        await page.screenshot({ path: resolve(evidence, `${engine}-${size.name}-light-stage.png`), animations: 'disabled', timeout: 15_000 })
        // The viewer's exit cue: the `‹ Library` chrome pill, always mounted.
        await page.locator('[data-chrome-library]').click()
        await expect(page.locator('.desktop-catalogue')).toBeVisible()
        await expect
          .poll(() => page.locator('html').evaluate((element) => element.classList.contains('light')), { timeout: 10_000 })
          .toBe(true)
      }
    }

    expect(errors).toEqual([])
  })
}

test('window-1280x840: details surface and share sheet over real photographs, both themes', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  test.skip(allPhotos.length < 4, `no photographs with pixels on disk under ${SOURCE}`)
  const engine = testInfo.project.name || String(testInfo.project.use?.defaultBrowserType ?? 'browser')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 840 })
  await openCatalogue(page)
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()

  const record = built.galleries[0]
  const details = page.locator('[data-screen="local-details"]')
  const tab = page.locator('.admin-heading-actions').getByRole('button', { name: 'Settings', exact: true })
  const pane = page.locator('[data-screen="settings"]')

  for (const theme of ['dark', 'light'] as const) {
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
    await expect(details.locator('.m-owner-panel-title')).toHaveText(record.title)
    await expect(details.locator('.m-owner-panel-meta')).toContainText(`${record.itemCount} photographs · Folder on this Mac`)
    // An available source states nothing; local-only facts stay off the
    // surface: no paths, no invented public/provider/vault/offline metadata.
    await expect(details.locator('[data-availability]')).toHaveCount(0)
    await expect(details).not.toContainText(SOURCE)
    await expect(details).not.toContainText('/Volumes')
    for (const banned of ['public', 'provider', 'vault', 'offline']) {
      await expect(details).not.toContainText(banned)
    }
    await expect(details.locator('.m-actionrow')).toHaveCount(8)
    const labels = await details.locator('.m-actionrow-label').allTextContents()
    expect(labels.map(label => label.trim())).toEqual([
      'Open gallery', 'View source',
      'Name', 'Caption', 'Address',
      'Reorder photographs', 'Refresh gallery contents',
      'Remove from Library',
    ])

    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: resolve(evidence, `${engine}-window-1280x840-${theme}-details.png`), animations: 'disabled', timeout: 15_000 })

    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(details).toHaveCount(0)
    expect(new URL(page.url()).search).toBe('')
    await card.locator('.lib-card-menu').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Publish this gallery' }).click()
    const share = page.locator('.desktop-share--sheet')
    await expect(share).toBeVisible()
    await expect(page.locator('.desktop-share-header')).toHaveCount(0)
    await expect(share).toContainText('nothing uploads until you confirm')
    await expect(share).toContainText('Dropbox')
    await page.screenshot({ path: resolve(evidence, `${engine}-window-1280x840-${theme}-share.png`), animations: 'disabled', timeout: 15_000 })

    await page.getByRole('button', { name: 'Close' }).click()
    await expect(share).toBeHidden()
    await expect(page.locator('.desktop-catalogue')).toBeVisible()
    await expect(details).toHaveCount(0)
    expect(new URL(page.url()).search).toBe('')
  }

  expect(errors).toEqual([])
})
