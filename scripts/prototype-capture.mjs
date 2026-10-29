/** One-off P0 tool: screenshot the docs/redesign-prototype screens at phone
 *  sizes into docs/redesign-parity/prototype/<size>/. Serves the folder
 *  statically itself; not part of the test suite. Run: bun scripts/prototype-capture.mjs */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'

const ROOT = resolve('docs/redesign-prototype')
const OUT = resolve('docs/redesign-parity/prototype')
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = join(ROOT, path === '/' ? 'index.html' : path)
    try {
      const f = Bun.file(file)
      if (!(await f.exists())) return new Response('not found', { status: 404 })
      return new Response(f, { headers: { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  },
})
const base = `http://127.0.0.1:${server.port}`
console.log(`serving ${ROOT} on ${base}`)

const viewports = [
  { name: '390x844', width: 390, height: 844 },
  { name: '375x812', width: 375, height: 812 },
]

const app = (page) => page.locator('#app')
const shot = async (page, dir, name) => {
  const path = join(dir, `${name}.png`)
  await app(page).screenshot({ path, animations: 'disabled' })
  console.log(`  ${name}.png`)
}
const closeSheet = async (page) => {
  await page.locator('#scrim').click({ force: true }).catch(() => {})
  await page.locator('.sheet.on, .dialog.on').first().waitFor({ state: 'hidden', timeout: 3000 }).catch(async () => {
    await page.keyboard.press('Escape')
  })
}
const chromeOn = async (page) => {
  // Tap the stage to wake the temporary chrome.
  await page.locator('#stage').click({ position: { x: 10, y: 10 }, force: true })
  await page.locator('#chrome.on').waitFor({ state: 'attached', timeout: 5000 })
}
const chromeOff = async (page) => {
  await page.waitForFunction(() => !document.querySelector('#chrome.on'), null, { timeout: 8000 }).catch(() => {})
}

const browser = await chromium.launch()
for (const vp of viewports) {
  const dir = join(OUT, vp.name)
  mkdirSync(dir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 })
  // The prototype simulates vault progress on an interval and loads rail
  // thumbnails after a random delay — both make captures nondeterministic.
  // Freeze the delay and kill the ticker before any app script runs.
  await page.addInitScript(() => {
    window.setInterval = () => 0
    Math.random = () => 0.5
  })
  const go = async (hash) => {
    await page.goto(`${base}/#${hash}`, { waitUntil: 'domcontentloaded' })
    // Every thumbnail inside the IO margin must have started and finished
    // loading; cells beyond it legitimately keep data-src.
    await page.waitForFunction(() => [...document.querySelectorAll('.th img')].every((img) => {
      if (img.dataset.src) {
        const r = img.getBoundingClientRect()
        return r.bottom < -240 || r.top > innerHeight + 240
      }
      return img.complete
    }), null, { timeout: 15000 }).catch(() => {})
  }
  console.log(`${vp.name}:`)

  await go('welcome')
  await shot(page, dir, 'welcome')

  await go('library')
  await shot(page, dir, 'library')

  await page.locator('#s-library [data-open="add"]').first().click()
  await page.locator('#sh-add.on').waitFor({ state: 'visible' })
  await shot(page, dir, 'add')
  await closeSheet(page)

  await go('viewer')
  await page.locator('#curtain').waitFor({ state: 'visible' })
  await shot(page, dir, 'viewer-curtain')
  await page.locator('#curtain').click({ force: true })
  await page.locator('#curtain').waitFor({ state: 'hidden', timeout: 8000 })
  await chromeOff(page)
  await shot(page, dir, 'viewer')

  await chromeOn(page)
  await shot(page, dir, 'viewer-chrome')

  await page.locator('#chrome [data-open="view"]').click()
  await page.locator('#sh-view.on').waitFor({ state: 'visible' })
  await shot(page, dir, 'display')
  await closeSheet(page)

  await chromeOn(page).catch(() => {})
  await page.locator('#chrome [data-open="info"]').click()
  await page.locator('#sh-info.on').waitFor({ state: 'visible' })
  await shot(page, dir, 'info')
  await closeSheet(page)

  await go('details')
  await shot(page, dir, 'details')

  await go('reorder')
  await shot(page, dir, 'reorder')

  await go('settings')
  await shot(page, dir, 'settings')

  await page.locator('#s-settings [data-open="pro"]').first().click()
  await page.locator('#sh-pro.on').waitFor({ state: 'visible' })
  await shot(page, dir, 'visionary')
  await closeSheet(page)

  await go('privacy')
  await shot(page, dir, 'privacy')

  await page.close()
}
await browser.close()
server.stop()
console.log('done')
