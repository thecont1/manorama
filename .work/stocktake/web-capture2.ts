/**
 * The remaining web reference surfaces: the signed-out landing page and the
 * G selector filmstrip, at an iPhone-sized viewport.
 */
import { chromium } from 'playwright'

const OUT = '/Users/home/DEV/tools/manorama/.work/stocktake/web'

const main = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  const page = await context.newPage()

  await page.goto('https://manorama.xyz/', { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${OUT}/iphone-00-landing.png` })
  console.log('  iphone-00-landing.png')

  await page.goto('https://manorama.xyz/thecontrarian/italy', { waitUntil: 'load', timeout: 60_000 })
  await page.waitForTimeout(2500)
  await page.mouse.click(196, 426)
  await page.waitForTimeout(1600)
  await page.keyboard.press('g')
  await page.waitForTimeout(1600)
  await page.screenshot({ path: `${OUT}/iphone-05-selector.png` })
  console.log('  iphone-05-selector.png')

  await browser.close()
}

await main()