/**
 * Photographs the opening-screen harnesses and reports the geometry of the
 * provider row, so "three icons in a row, named beneath" is checked as a
 * measurement and not just an impression.
 */
import { chromium } from '@playwright/test'

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const out = `${repo}/.work/previews`

const harnesses = [
  { name: 'native-landing', file: `${repo}/.work/previews/native-landing.html` },
  { name: 'desktop-welcome', file: `${repo}/.work/previews/desktop-welcome.html` },
]
const viewports = [
  { name: 'iphone', width: 390, height: 844 },
  { name: 'wide', width: 1440, height: 900 },
]

const browser = await chromium.launch()

for (const harness of harnesses) {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
    await page.goto(`file://${harness.file}`)
    await page.waitForLoadState('load')

    const measured = await page.evaluate(() => {
      const row = document.querySelector('.native-signin-icons, .desktop-signin-icons')
      const buttons = [...document.querySelectorAll('.native-signin-icon, .desktop-signin-icon')]
      const labels = buttons.map((button) => {
        const label = button.querySelector('span')
        const r = label?.getBoundingClientRect()
        return { text: label?.textContent, top: r ? Math.round(r.top) : null, left: r ? Math.round(r.left) : null }
      })
      const boxes = buttons.map((button) => {
        const r = button.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      })
      // The spacing the eye reads is between glyph centres, not cell edges.
      const glyphCentres = buttons.map((button) => {
        const glyph = button.querySelector('svg')?.getBoundingClientRect()
        return glyph ? Math.round(glyph.x + glyph.width / 2) : null
      })
      const rowBox = row?.getBoundingClientRect()
      return {
        row: rowBox ? { w: Math.round(rowBox.width), h: Math.round(rowBox.height), y: Math.round(rowBox.y) } : null,
        buttons: boxes,
        glyphCentres,
        labels,
        // The folder action is what the Mac shell must no longer offer.
        folderAction: document.querySelectorAll('.desktop-folder-action').length,
        scrolls: document.documentElement.scrollHeight > window.innerHeight,
      }
    })

    const shot = `${out}/${harness.name}-${viewport.name}.png`
    await page.screenshot({ path: shot })
    console.log(`${harness.name} @ ${viewport.width}x${viewport.height}`)
    console.log(`  row          ${JSON.stringify(measured.row)}`)
    console.log(`  buttons      ${JSON.stringify(measured.buttons)}`)
    console.log(`  labels       ${JSON.stringify(measured.labels)}`)
    console.log(`  folderAction ${measured.folderAction}  pageScrolls ${measured.scrolls}`)
    console.log(`  -> ${shot}`)
    await page.close()
  }
}

await browser.close()
    console.log(`  glyphCentres ${JSON.stringify(measured.glyphCentres)}`)
