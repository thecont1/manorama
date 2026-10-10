/**
 * Reference capture: the public web gallery at an iPhone-sized viewport.
 *
 * The web app is the reference implementation and the iOS shell must match it.
 * This script photographs the same states the native harness photographs, so
 * the two sets can be laid side by side.
 *
 *   GET /thecontrarian/italy  ->  curtain, first image, controls modal, info sheet
 */
import { chromium, type Page } from 'playwright'

const URL_GALLERY = 'https://manorama.xyz/thecontrarian/italy'
const OUT = '/Users/home/DEV/tools/manorama/.work/stocktake/web'

const VIEWPORTS = {
  iphone: { width: 393, height: 852, dpr: 3, mobile: true },
  wide: { width: 1440, height: 900, dpr: 2, mobile: false },
} as const

const shoot = async (page: Page, name: string) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ${name}.png`)
}

const run = async (label: keyof typeof VIEWPORTS) => {
  const vp = VIEWPORTS[label]
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    userAgent: vp.mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : undefined,
  })
  const page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [console] ${m.text()}`)
  })

  console.log(`== ${label} ${vp.width}x${vp.height}@${vp.dpr} ==`)
  await page.goto(URL_GALLERY, { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500)
  await shoot(page, `${label}-01-curtain`)

  // Dismiss the curtain the way a finger does.
  await page.mouse.click(vp.width / 2, vp.height / 2)
  await page.waitForTimeout(1600)
  await shoot(page, `${label}-02-first-image`)

  // The one visible control.
  const control = page.locator('.control-logo')
  console.log(`    control-logo count=${await control.count()}`)
  const box = await control.first().boundingBox()
  console.log(`    control-logo box=${JSON.stringify(box)}`)
  await control.first().click({ force: true })
  await page.waitForTimeout(1400)
  await shoot(page, `${label}-03-controls-modal`)

  // Dismiss, then the information sheet.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(900)
  await page.keyboard.press('i')
  await page.waitForTimeout(1400)
  await shoot(page, `${label}-04-info-sheet`)

  await browser.close()
}

const main = async () => {
  const only = process.argv[2]
  for (const label of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]) {
    if (only && only !== label) continue
    await run(label)
  }
}

await main()