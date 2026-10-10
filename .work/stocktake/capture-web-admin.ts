import { chromium, webkit } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dir, '../..')
const base = process.env.WEB_CAPTURE_URL ?? 'http://localhost:5173'
const out = resolve(root, 'demo-captures/web')
await mkdir(out, { recursive: true })
const reports: unknown[] = []
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true })
  try {
    for (const viewport of [
      { name: 'iphone', width: 428, height: 926, dpr: 3, touch: true },
      { name: 'ipad', width: 1376, height: 1032, dpr: 2, touch: true },
      { name: 'desktop', width: 1440, height: 900, dpr: 1, touch: false },
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.dpr, hasTouch: viewport.touch })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/.dev-seed/login`)
      await page.getByRole('heading', { name: 'Add a gallery', exact: true }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      const field = page.getByLabel('Public Dropbox, Google Drive, iCloud, or MEGA link', { exact: true })
      await field.scrollIntoViewIfNeeded()
      const box = await field.boundingBox()
      if (!box || box.width <= 0 || box.height <= 0 || box.y + box.height > viewport.height) throw new Error(`URL input not reachable: ${viewport.name}`)
      await field.fill('https://mega.nz/folder/example#keep-the-key')
      await field.press('Tab')
      // Do not publish a gallery. Editing proves the field works; API creation
      // is tested separately with route interception against the real component.
      const name = `${engine.name()}-${viewport.name}-admin.png`
      await page.screenshot({ path: resolve(out, name), scale: 'device' })
      await page.screenshot({ path: resolve(out, `${engine.name()}-${viewport.name}-admin-full.png`), fullPage: true, scale: 'device' })
      const links = await page.locator('a[aria-label$="in a new tab"]').evaluateAll(els => els.map(e => ({ href: e.getAttribute('href'), target: e.getAttribute('target') })))
      if (links.some(link => link.target !== '_blank')) throw new Error('Gallery links must open in a new tab')
      reports.push({ engine: engine.name(), viewport, field: box, errors, galleryLinks: links, file: name })
      await context.close()
    }
  } finally { await browser.close() }
}
await writeFile(resolve(out, 'admin-verification.json'), JSON.stringify(reports, null, 2))
console.log(JSON.stringify(reports, null, 2))
