/**
 * Measures and photographs the gallery chrome harnesses.
 *
 * The bug this exists to catch is a sizing one: `.control-logo` is
 * `position: fixed`, so a `height: 100%` on it resolves against the viewport
 * rather than the control row, and the wordmark paints at viewport scale. A
 * screenshot alone would show "big logo"; the numbers say exactly how big.
 */
import { chromium } from '@playwright/test'

const repo = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')
const out = `${repo}/.work/previews`

const harnesses = [
  { name: 'native', file: `${repo}/.work/previews/native-chrome.html` },
  { name: 'desktop', file: `${repo}/.work/previews/desktop-chrome.html` },
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
      const box = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
      }
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        row: box('.stage-arrows'),
        button: box('.control-logo'),
        wrap: box('.control-logo .brand-mark-wrap'),
        image: box('.control-logo .brand-mark-wrap img'),
      }
    })

    const shot = `${out}/${harness.name}-${viewport.name}.png`
    await page.screenshot({ path: shot })
    console.log(`${harness.name} @ ${viewport.width}x${viewport.height}`)
    console.log(`  row    ${JSON.stringify(measured.row)}`)
    console.log(`  button ${JSON.stringify(measured.button)}`)
    console.log(`  wrap   ${JSON.stringify(measured.wrap)}`)
    console.log(`  image  ${JSON.stringify(measured.image)}`)
    console.log(`  -> ${shot}`)
    await page.close()
  }
}

await browser.close()
