import { expect, test, type Page } from '@playwright/test'
import { blockProductionApi, bridgePayload, installBridge, PIXEL } from './desktop-admin-fixture'

const webUrl = process.env.GALLERY_URL ?? 'http://localhost:5173'
const nativeUrl = process.env.NATIVE_GALLERY_URL ?? 'http://localhost:5174'
const desktopUrl = process.env.DESKTOP_URL ?? 'http://localhost:5175'
const roots = '.gallery-list, .native-list-card, .native-lib-foot'

const openLibrary = async (page: Page, surface: string) => {
  if (surface === 'web') {
    await expect(async () => {
      await page.request.get(`${webUrl}/.dev-seed/login`, { maxRedirects: 0 })
      await page.goto(`${webUrl}/thecontrarian`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 5000 })
    }).toPass({ timeout: 30_000 })
  } else if (surface === 'desktop') {
    await blockProductionApi(page)
    await page.addInitScript(installBridge, bridgePayload)
    await page.goto(desktopUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.desktop-catalogue .lib-card-title').first()).toBeVisible()
  } else {
    await page.addInitScript(() => {
      localStorage.setItem('capacitor-storage_manorama.session-token', JSON.stringify('quiet-fixture-token'))
      localStorage.setItem('capacitor-storage_manorama.owner-slug', JSON.stringify('fixture'))
    })
    const galleries = ['A quiet afternoon', 'Along the coast', 'Portraits'].map((title, index) => ({
      slug: `quiet-${index}`, title, caption: '', date: '', imageCount: 1, retention: 'retained',
      expiresAt: null, sourceUrl: null, createdAt: null, pinnedAt: index === 0 ? '2026-11-16T00:00:00Z' : null,
      images: [{ id: `photo-${index}`, filename: 'photo.gif', src: PIXEL, width: 1, height: 1 }],
    }))
    await page.route('**/api/**', (route) => route.fulfill({ json: route.request().url().endsWith('/api/galleries')
      ? { galleries } : { galleries: [], devices: [], identities: [], suppressions: [], show: false } }))
    await page.goto(nativeUrl, { waitUntil: 'domcontentloaded' })
    // One gallery is pinned, so it lists twice: its strip in "Pinned
    // galleries" and its compact card in "Cloud galleries".
    await expect(page.locator('.native-list-card .lib-card-title')).toHaveCount(4)
    await expect(page.locator('.native-library-layout')).toHaveCSS('grid-template-areas', '"rail galleries"')
  }
  await expect(page.locator('.lib-quiet-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.locator(`:is(${roots}) img`).first().evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

const sample = (page: Page) => page.evaluate((selector) => {
  const elements = [...document.querySelectorAll(selector)].flatMap(root => [root, ...root.querySelectorAll('*')])
    .filter(el => el.getClientRects().length && [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()))
  return elements.map(el => {
    const style = getComputedStyle(el)
    return { text: el.textContent?.trim(), color: style.color, fill: style.webkitTextFillColor }
  })
}, roots)

const finishTransitions = (page: Page) => page.evaluate(async (selector) => {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  await Promise.all([...document.querySelectorAll(selector)].flatMap(el => el.getAnimations({ subtree: true }))
    .map(animation => animation.finished.catch(() => {})))
}, roots)

const midTransition = (page: Page) => page.evaluate(async () => {
  const toggle = document.querySelector<HTMLButtonElement>('.lib-quiet-toggle')!
  toggle.click()
  await new Promise<void>(resolve => setTimeout(resolve, 300))
})

for (const browserName of ['chromium', 'webkit'] as const) {
  const engineTest = test.extend({ browserName })
  engineTest.describe(`Library Quiet in ${browserName}`, () => {
    for (const surface of ['web', 'native', 'desktop']) {
      for (const theme of ['dark', 'light']) {
        engineTest(`${surface} ${theme} restores every word through the same fade`, async ({ page }, testInfo) => {
          await page.setViewportSize(surface === 'native' ? { width: 951, height: 669 } : { width: 1440, height: 900 })
          await page.addInitScript(theme => localStorage.setItem('manorama:theme', theme), theme)
          await openLibrary(page, surface)
          await finishTransitions(page)
          const normal = await sample(page)
          expect(normal.length).toBeGreaterThan(3)
          for (const word of normal) expect(word.fill, word.text).toBe(word.color)
          const photo = page.locator(`${surface === 'native' ? '.native-list-card' : '.gallery-list'} img`).first()
          const photoBox = await photo.boundingBox()

          await midTransition(page)
          const fading = await sample(page)
          for (const [index, word] of fading.entries()) {
            expect(word.fill, word.text).not.toBe(normal[index].fill)
            expect(word.color, word.text).toBe(normal[index].color)
          }
          await finishTransitions(page)
          const dim = await sample(page)
          for (const word of dim) expect(word.fill, word.text).toMatch(/, 0\.05\)$/)

          await midTransition(page)
          const returning = await sample(page)
          for (const [index, word] of returning.entries()) {
            expect(word.color, word.text).toBe(normal[index].color)
            expect(word.fill, word.text).not.toBe(dim[index].fill)
            expect(word.fill, word.text).not.toBe(normal[index].fill)
          }
          await page.screenshot({ path: testInfo.outputPath('restoring.png') })
          await finishTransitions(page)
          await expect.poll(() => sample(page)).toEqual(normal)
          expect(await photo.boundingBox()).toEqual(photoBox)
          await expect(photo).toHaveCSS('filter', 'none')

          await midTransition(page)
          await midTransition(page)
          await finishTransitions(page)
          await expect.poll(() => sample(page)).toEqual(normal)

          await page.emulateMedia({ reducedMotion: 'reduce' })
          await midTransition(page)
          await finishTransitions(page)
          await midTransition(page)
          await finishTransitions(page)
          await expect.poll(() => sample(page)).toEqual(normal)
          await page.screenshot({ path: testInfo.outputPath('restored.png') })
        })
      }

      engineTest(`${surface} lifts the hovered card's details to full alpha`, async ({ page }) => {
        await page.setViewportSize(surface === 'native' ? { width: 951, height: 669 } : { width: 1440, height: 900 })
        await openLibrary(page, surface)
        await page.evaluate(() => document.querySelector<HTMLButtonElement>('.lib-quiet-toggle')!.click())
        await finishTransitions(page)
        const root = surface === 'native' ? '.native-list-card' : '.gallery-list'
        const card = page.locator(`${root} :is(.lib-card, .lib-compact-card)`).first()
        const word = card.locator('.lib-card-title, .lib-card-sub').first()
        await expect(word).toBeVisible()
        const dim = await word.evaluate(el => getComputedStyle(el).webkitTextFillColor)
        expect(dim).toMatch(/, 0\.05\)$/)

        await card.hover()
        await finishTransitions(page)
        const lifted = await word.evaluate(el => ({
          fill: getComputedStyle(el).webkitTextFillColor,
          color: getComputedStyle(el).color,
        }))
        // Full alpha means the quieted fill gives way to the card's own
        // color — the same reading as an un-quieted card.
        expect(lifted.fill).toBe(lifted.color)
      })
    }
  })
}
