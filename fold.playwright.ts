import { expect, test } from '@playwright/test'

const nativeUrl = process.env.NATIVE_GALLERY_URL
const apiPattern = '**/api/gallery/**'
const svg = (label: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}>`

const manifest = {
  manifest: {
    slug: 'fold-fixture',
    title: 'Fold fixture',
    caption: 'A deterministic fold acceptance gallery.',
    date: '2026-09-24',
    images: [0, 1].map((index) => ({
      id: `fold-${index}`,
      filename: `fold-${index}.svg`,
      src: svg(`photograph ${index + 1}`),
      width: 640,
      height: 900,
      alt: `Fold photograph ${index + 1}`,
      c2pa: false,
      placeholder: svg(`placeholder ${index + 1}`),
    })),
  },
  settings: {
    title: 'Fold fixture',
    caption: 'A deterministic fold acceptance gallery.',
    date: '2026-09-24',
    curtainKicker: 'A single album',
    curtainPrompt: 'Tap, click, or press Enter to enter',
    defaultMode: 'strip',
    defaultShowCaptions: false,
    defaultShowArrows: false,
    imageCaptions: {},
    imageAlts: {},
  },
}

const describeIfConfigured = nativeUrl ? test.describe : test.describe.skip

describeIfConfigured('native fold runtime', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await page.route(apiPattern, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    }))
  })

  test('keeps the ordinary strip on a one-segment viewport', async ({ page }) => {
    await page.goto(`${nativeUrl}/?owner=fixture&slug=fold-fixture`)
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await page.locator('[data-curtain]').click()
    await expect(page.locator('[data-curtain]')).toBeHidden()
    await expect(page.locator('[data-track]')).toHaveCount(1)
    await expect(page.locator('[data-diptych-stage]')).toHaveCount(0)
    await expect(page.locator('[data-track] [data-index]')).toHaveCount(2)
  })

  test('renders two physical panes and advances the active pane pair', async ({ page }) => {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window)
      window.matchMedia = ((query: string) => {
        if (query !== '(horizontal-viewport-segments: 2)') return nativeMatchMedia(query)
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        } as MediaQueryList
      }) as typeof window.matchMedia
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style')
        style.textContent = `:root {
          --manorama-segment-left-0: 0px;
          --manorama-segment-top-0: 0px;
          --manorama-segment-width-0: 680px;
          --manorama-segment-height-0: 900px;
          --manorama-segment-left-1: 760px;
          --manorama-segment-top-1: 0px;
          --manorama-segment-width-1: 680px;
          --manorama-segment-height-1: 900px;
        }`
        document.head.appendChild(style)
      })
    })
    await page.goto(`${nativeUrl}/?owner=fixture&slug=fold-fixture`)
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await page.locator('[data-curtain]').click()
    await expect(page.locator('[data-diptych-stage]')).toBeVisible()
    await expect(page.locator('[data-diptych-frame]')).toHaveCount(2)
    await expect(page.locator('[data-diptych-frame="1"]')).toHaveAttribute('aria-current', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diptych-frame="2"]')).toHaveAttribute('aria-current', 'true')
  })

  test('aligns panes to physical segment origins despite safe-area insets', async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window, {
        __MANORAMA_IOS_FOLD__: {
          horizontalSizeClass: 'regular',
          verticalSizeClass: 'regular',
          hinge: { axis: 'vertical', start: 700, size: 40 },
        },
      })
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style')
        style.textContent = `:root {
          --native-safe-top: 24px;
          --native-safe-right: 16px;
          --native-safe-bottom: 24px;
          --native-safe-left: 16px;
        }`
        document.head.appendChild(style)
      })
    })
    await page.goto(`${nativeUrl}/?owner=fixture&slug=fold-fixture`)
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await page.locator('[data-curtain]').click()
    await expect(page.locator('[data-diptych-stage]')).toBeVisible()

    // The hinge splits a 1440px screen into [0,700] and [740,1440] panes.
    // Safe-area insets belong to the control layer: they must not push the
    // photograph canvas off the physical pane origins.
    const first = await page.locator('[data-diptych-frame="1"]').boundingBox()
    const second = await page.locator('[data-diptych-frame="2"]').boundingBox()
    expect(first).toMatchObject({ x: 0, y: 0, width: 700, height: 900 })
    expect(second).toMatchObject({ x: 740, y: 0, width: 700, height: 900 })
  })
})
