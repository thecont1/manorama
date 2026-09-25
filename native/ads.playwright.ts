/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'
import type { GalleryImage } from '../app/lib/imagesource'

/**
 * Browser coverage for the ad plate rules (#23). Two mounts, both real:
 *
 *  - `/?owner=fixture&slug=ads-fixture` drives the shipped app — GalleryList
 *    opens through fetchGallery, resolves the plate through adFrameFor and
 *    composes it via BundledSource.listWithPlate exactly as production does.
 *    Unresolved billing in the browser preview is treated as free, so the
 *    house fallback plate is what a reviewer would see.
 *  - `/ads-fixture.html` mounts the same real GalleryShell + Viewer seam with
 *    the tier pinned, because billingState cannot be injected into main.tsx
 *    without a test seam in production code.
 *
 * Unlike the fold spec this suite must never pass quietly: without the
 * fixture server it fails outright, because "no plate observed" is only
 * evidence when the real Viewer rendered. Serve it with:
 *   VITE_API_BASE=http://127.0.0.1:5174 \
 *   bunx vite --config vite.config.native-fixture.ts --host 127.0.0.1 --port 5174
 */
const nativeUrl = process.env.NATIVE_GALLERY_URL
if (!nativeUrl) {
  throw new Error(
    'NATIVE_GALLERY_URL is required. Serve the native fixture first: ' +
    'bunx vite --config vite.config.native-fixture.ts --host 127.0.0.1 --port 5174',
  )
}

const apiPattern = '**/api/gallery/**'
const svg = (label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}`

const photo = (index: number): GalleryImage => ({
  id: `fixture-${index}`,
  filename: `fixture-${index}.svg`,
  src: svg(`photograph ${index + 1}`),
  width: 640,
  height: 900,
  alt: `Fixture photograph ${index + 1}`,
  c2pa: false,
  placeholder: svg(`placeholder ${index + 1}`),
})

const galleryPayload = (photoCount: number) => ({
  manifest: {
    slug: 'ads-fixture',
    title: 'Ad fixture',
    caption: 'A deterministic ad-safety acceptance gallery.',
    date: '2026-09-24',
    images: Array.from({ length: photoCount }, (_, index) => photo(index)),
  },
  settings: {
    title: 'Ad fixture',
    caption: 'A deterministic ad-safety acceptance gallery.',
    date: '2026-09-24',
    curtainKicker: 'A single album',
    curtainPrompt: 'Tap, click, or press Enter to enter',
    defaultMode: 'strip',
    defaultShowCaptions: false,
    defaultShowArrows: false,
    imageCaptions: {},
    imageAlts: {},
  },
})

/** Records every CTA navigation. The pointer path replays window.open (stage
 *  pointer capture swallows the anchor's native click); the keyboard path is
 *  a real target=_blank popup. Page-side opens land in __AD_FIXTURE_OPENED__;
 *  popups are recorded Node-side so waitForEvent gives deterministic order. */
const stubWindowOpen = (page: Page, popups: string[]) => {
  page.on('popup', (popup) => popups.push(popup.url()))
  return page.addInitScript(() => {
    const opened: string[] = []
    Object.assign(window, { __AD_FIXTURE_OPENED__: opened })
    window.open = (url?: string | URL) => {
      opened.push(String(url))
      return null
    }
  })
}

const enterGallery = async (page: Page) => {
  await expect(page.locator('[data-curtain]')).toBeVisible()
  await page.locator('[data-curtain]').click()
  await expect(page.locator('[data-track]')).toBeVisible()
}

type Opened = { page: Page; popups: string[] }
const openedUrls = async ({ page, popups }: Opened): Promise<string[]> => [
  ...await page.evaluate(
    () => (window as unknown as { __AD_FIXTURE_OPENED__: string[] }).__AD_FIXTURE_OPENED__),
  ...popups,
]

/** The shipped path: main.tsx -> GalleryList -> fetchGallery -> adFrameFor ->
 *  listWithPlate -> Viewer, with the manifest routed in place of the worker. */
const openApp = async (page: Page, photoCount = 24): Promise<Opened> => {
  const body = JSON.stringify(galleryPayload(photoCount))
  const popups: string[] = []
  await stubWindowOpen(page, popups)
  await page.route(apiPattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body }))
  // The house CTA's destination is intercepted too — an activated popup
  // must never reach real network in a test.
  await page.route('**/manorama.xyz*', (route) => route.fulfill({ status: 200, body: 'ok' }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=ads-fixture`)
  await enterGallery(page)
  return { page, popups }
}

/** The pinned-tier fixture: same real Viewer and adFrameFor policy, with the
 *  entitlement set before load — never a runtime switch the app could ship. */
const openFixture = async (page: Page, options: { photoCount?: number; tier: 'free' | 'pro' }) => {
  const photoCount = options.photoCount ?? 24
  const body = JSON.stringify(galleryPayload(photoCount))
  const popups: string[] = []
  await stubWindowOpen(page, popups)
  await page.addInitScript((config) => {
    Object.assign(window, { __MANORAMA_AD_FIXTURE__: config })
  }, { photoCount, tier: options.tier })
  await page.route(apiPattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body }))
  await page.route('**/manorama.xyz*', (route) => route.fulfill({ status: 200, body: 'ok' }))
  await page.goto(`${nativeUrl}/ads-fixture.html`)
  await enterGallery(page)
  return { body, page, popups }
}

/** Drags the strip so the plate lands dead-center on the stage. Pointer
 *  deltas round per event, so one drag lands within a few px of the target —
 *  corrective passes close the rest. Each pass ends with a slow tail so the
 *  release settles instead of gliding. plateIsCentered wants < 2px. */
const centerPlate = async (page: Page) => {
  const stage = page.locator('.viewer-stage')
  const plate = page.locator('[data-ad-frame]')
  await expect(plate).toBeVisible()

  for (let pass = 0; pass < 8; pass += 1) {
    const centers = await page.evaluate(() => {
      const stageRect = document.querySelector('.viewer-stage')!.getBoundingClientRect()
      const plateRect = document.querySelector('[data-ad-frame]')!.getBoundingClientRect()
      return {
        stage: stageRect.left + stageRect.width / 2,
        plate: plateRect.left + plateRect.width / 2,
      }
    })
    const residual = centers.plate - centers.stage
    if (Math.abs(residual) < 1) return

    const stageBox = (await stage.boundingBox())!
    const startX = stageBox.x + stageBox.width * 0.8
    const startY = stageBox.y + stageBox.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    const steps = Math.min(6, Math.max(2, Math.round(Math.abs(residual) / 60)))
    for (let step = 1; step <= steps; step += 1) {
      await page.mouse.move(startX - (residual * step) / steps, startY)
    }
    await page.waitForTimeout(150)
    await page.mouse.move(startX - residual + 0.5, startY)
    await page.mouse.move(startX - residual, startY)
    await page.mouse.up()
    await page.waitForTimeout(120)
  }
  throw new Error('Plate never reached stage center')
}

const plateCta = (page: Page) => page.locator('[data-ad-frame] [data-ad-mount] a')

test.describe('native ad plate rules', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('places exactly one plate at the midpoint of a 24-photo gallery', async ({ page }) => {
    await openApp(page, 24)

    await expect(page.locator('[data-ad-frame]')).toHaveCount(1)
    // floor(24 / 2) = 12: the plate sits after the twelfth photograph, never
    // first or last.
    await expect(page.locator('[data-index="12"] + [data-ad-frame]')).toHaveCount(1)
    await expect(page.locator('[data-ad-frame] + [data-index="13"]')).toHaveCount(1)
  })

  test('suppresses the plate entirely in a 5-photo gallery', async ({ page }) => {
    await openApp(page, 5)

    await expect(page.locator('[data-track]')).toBeVisible()
    await expect(page.locator('[data-ad-frame]')).toHaveCount(0)
    await expect(page.locator('[data-track] [data-index]')).toHaveCount(5)
  })

  test('keeps the position readout and item count photograph-only', async ({ page }) => {
    await openApp(page, 24)

    await expect(page.locator('[data-track] [data-index]')).toHaveCount(24)
    const seq = page.locator('.stage-seq')
    await expect(seq).toHaveAttribute('aria-label', /of 24/)
    await expect(page.locator('.stage-seq-tally')).toContainText('of 24')

    // With the plate centered the counter still speaks photographs.
    await centerPlate(page)
    await expect(seq).toHaveAttribute('aria-label', /of 24/)
    await expect(page.locator('.stage-seq-tally')).toContainText('of 24')
  })

  test('keeps the CTA inert through drag, momentum and off-center rest', async ({ page }) => {
    const opened = await openApp(page, 24)
    const cta = plateCta(page)
    await expect(cta).toHaveCount(1)

    // Initial rest: the plate is nowhere near center — inert and unfocusable.
    await expect(cta).toHaveAttribute('tabindex', '-1')
    await cta.dispatchEvent('click')
    expect(await openedUrls(opened)).toEqual([])

    // Mid-drag with the pointer held: synthesize the click the plate would
    // receive — the handler must refuse it while the strip is dragging.
    const stage = page.locator('.viewer-stage')
    const stageBox = (await stage.boundingBox())!
    await page.mouse.move(stageBox.x + stageBox.width * 0.8, stageBox.y + stageBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(stageBox.x + stageBox.width * 0.4, stageBox.y + stageBox.height / 2, { steps: 4 })
    await cta.dispatchEvent('click')
    await cta.dispatchEvent('keydown', { key: 'Enter' })
    expect(await openedUrls(opened)).toEqual([])

    // Release the drag as a flick so momentum carries the strip — clicks and
    // keys during the glide are still refused.
    await page.mouse.up()
    await cta.dispatchEvent('click')
    await cta.dispatchEvent('keydown', { key: 'Enter' })
    expect(await openedUrls(opened)).toEqual([])

    // Settle somewhere off-center, plate still inside the viewport. The strip
    // is calm but the plate is not centered: a real pointer tap is refused
    // and the CTA stays out of the tab order.
    const centers = await page.evaluate(() => {
      const stageRect = document.querySelector('.viewer-stage')!.getBoundingClientRect()
      const plateRect = document.querySelector('[data-ad-frame]')!.getBoundingClientRect()
      return { stage: stageRect.left + stageRect.width / 2, plate: plateRect.left + plateRect.width / 2 }
    })
    const targetOffset = 260 // px left of center — visible, but not centred
    const residual = centers.plate - (centers.stage - targetOffset)
    await page.mouse.move(stageBox.x + stageBox.width * 0.8, stageBox.y + stageBox.height / 2)
    await page.mouse.down()
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse.move(stageBox.x + stageBox.width * 0.8 - (residual * step) / 4, stageBox.y + stageBox.height / 2)
    }
    await page.waitForTimeout(150)
    await page.mouse.move(stageBox.x + stageBox.width * 0.8 - residual + 0.5, stageBox.y + stageBox.height / 2)
    await page.mouse.up()
    await page.waitForTimeout(300)
    await expect(cta).toBeVisible()
    await expect(cta).toHaveAttribute('tabindex', '-1')
    await cta.click()
    expect(await openedUrls(opened)).toEqual([])
  })

  test('activates the CTA only when the plate is centered and settled', async ({ page }) => {
    const opened = await openApp(page, 24)
    const cta = plateCta(page)

    await centerPlate(page)
    // The actionability re-measure runs on rAF after the transform commits.
    await expect(cta).toHaveAttribute('tabindex', '0', { timeout: 5000 })

    // The pointer path replays anchor.href — the DOM-normalized URL carries a
    // trailing slash that the raw attribute does not. Both are the house CTA.
    const houseCta = /^https:\/\/manorama\.xyz\/?$/
    await cta.click()
    expect((await openedUrls(opened)).every((url) => houseCta.test(url))).toBe(true)
    expect(await openedUrls(opened)).toHaveLength(1)

    // Keyboard activation is a real target=_blank popup, not window.open.
    const popupPromise = page.waitForEvent('popup')
    await cta.focus()
    await page.keyboard.press('Enter')
    const popup = await popupPromise
    expect(houseCta.test(popup.url())).toBe(true)
    expect(await openedUrls(opened)).toHaveLength(2)
  })

  test('renders no plate for a pro entitlement', async ({ page }) => {
    await openFixture(page, { photoCount: 24, tier: 'pro' })

    await expect(page.locator('[data-track]')).toBeVisible()
    await expect(page.locator('[data-ad-frame]')).toHaveCount(0)
    await expect(page.locator('[data-track] [data-index]')).toHaveCount(24)
  })

  test('leaves the stored manifest bytes unchanged after real viewing', async ({ page }) => {
    const { body } = await openFixture(page, { photoCount: 24, tier: 'free' })

    const atOpen = await page.evaluate(
      () => (window as unknown as { __MANORAMA_AD_FIXTURE_STATE__: { imagesJsonAtOpen: string } }).__MANORAMA_AD_FIXTURE_STATE__.imagesJsonAtOpen,
    )

    // View through the plate: drag it to center, activate, keep moving.
    await centerPlate(page)
    const cta = plateCta(page)
    await expect(cta).toHaveAttribute('tabindex', '0', { timeout: 5000 })
    await cta.click()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(400)

    // The same in-page manifest object must serialize byte-identically —
    // listWithPlate is runtime-only, never written back.
    const after = await page.evaluate(
      () => JSON.stringify((window as unknown as { __MANORAMA_AD_FIXTURE_STATE__: { manifest: { images: unknown } } }).__MANORAMA_AD_FIXTURE_STATE__.manifest.images),
    )
    expect(after).toBe(atOpen)

    // And the served record itself is unchanged on a second read.
    const refetched = await page.evaluate(async () => (await fetch('/api/gallery/fixture/ads-fixture')).text())
    expect(refetched).toBe(body)
  })
})
