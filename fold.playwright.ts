/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'
import type { GalleryImage } from './app/lib/imagesource'

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

const foldImage = (index: number, overrides: Partial<GalleryImage> = {}): GalleryImage => ({
  ...manifest.manifest.images[0],
  id: `fold-${index}`,
  filename: `fold-${index}.svg`,
  src: svg(`photograph ${index + 1}`),
  alt: `Fold photograph ${index + 1}`,
  ...overrides,
})

const installIOSFold = async (page: Page) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __MANORAMA_IOS_FOLD__: {
        horizontalSizeClass: 'regular',
        verticalSizeClass: 'regular',
        hinge: { axis: 'vertical', start: 700, size: 40 },
      },
    })
  })
}

const openFoldFixture = async (
  page: Page,
  images: GalleryImage[] = Array.from({ length: 6 }, (_, index) => foldImage(index)),
) => {
  await installIOSFold(page)
  await page.route(apiPattern, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ...manifest, manifest: { ...manifest.manifest, images } }),
  }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=fold-fixture`)
  await expect(page.locator('[data-curtain]')).toBeVisible()
  await page.locator('[data-curtain]').click()
  await expect(page.locator('[data-diptych-stage]')).toBeVisible()
}

const seqLabel = (photo: number) => `Photograph ${photo} of 6 — open selector`

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
    // Each frame must fill exactly its injected segment — a misplaced or
    // overlapping pane fails here even though the count and order pass.
    const first = await page.locator('[data-diptych-frame="1"]').boundingBox()
    const second = await page.locator('[data-diptych-frame="2"]').boundingBox()
    expect(first).toMatchObject({ x: 0, y: 0, width: 680, height: 900 })
    expect(second).toMatchObject({ x: 760, y: 0, width: 680, height: 900 })
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

  test('steps accumulate from the pending fold destination within one task', async ({ page }) => {
    await openFoldFixture(page)
    const seq = page.locator('.stage-seq')
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    await expect(seq).toHaveAttribute('aria-label', seqLabel(3))
    await expect(page.locator('[data-diptych-frame="1"]')).toHaveAttribute('data-image-id', 'fold-2')
    await expect(page.locator('[data-diptych-frame="2"]')).toHaveAttribute('data-image-id', 'fold-3')
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    })
    await expect(seq).toHaveAttribute('aria-label', seqLabel(2))
    await page.evaluate(() => {
      const stage = document.querySelector('[data-stage]')
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    })
    await expect(seq).toHaveAttribute('aria-label', seqLabel(4))
  })

  for (const { deltaMode, deltaY } of [
    { deltaMode: 0, deltaY: 12 },
    { deltaMode: 1, deltaY: 1 },
    { deltaMode: 2, deltaY: 1 },
  ]) {
    test(`normalises wheel deltaMode ${deltaMode} before the fold step threshold`, async ({ page }) => {
      await openFoldFixture(page)
      const seq = page.locator('.stage-seq')
      await page.evaluate(([mode, delta]) => {
        document.querySelector('[data-stage]')?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: delta, deltaMode: mode, bubbles: true, cancelable: true }))
      }, [deltaMode, deltaY])
      await expect(seq).toHaveAttribute('aria-label', seqLabel(2))
      await page.evaluate(([mode, delta]) => {
        document.querySelector('[data-stage]')?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -delta, deltaMode: mode, bubbles: true, cancelable: true }))
      }, [deltaMode, deltaY])
      await expect(seq).toHaveAttribute('aria-label', seqLabel(1))
    })
  }

  test('ignores a canceled fold gesture and steps once on a completed drag', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await openFoldFixture(page)
    const seq = page.locator('.stage-seq')
    await page.evaluate(() => {
      document.querySelector('[data-stage]')?.addEventListener('pointerdown', (event) => {
        ;(window as unknown as { __foldPointerId?: number }).__foldPointerId = (event as PointerEvent).pointerId
      })
    })
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(400, 400)
    const pointerId = await page.evaluate(
      () => (window as unknown as { __foldPointerId?: number }).__foldPointerId,
    )
    expect(typeof pointerId).toBe('number')
    await page.evaluate((id: number) => {
      document.querySelector('[data-stage]')?.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerId: id, pointerType: 'mouse', clientX: 400, clientY: 400 }))
    }, pointerId as number)
    await page.mouse.up()
    await expect(seq).toHaveAttribute('aria-label', seqLabel(1))
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(400, 400)
    await page.mouse.up()
    await expect(seq).toHaveAttribute('aria-label', seqLabel(2))
    expect(pageErrors).toEqual([])
  })

  for (const withVariant of [true, false]) {
    test(`shows the ${withVariant ? '256px variant' : 'placeholder'} while a HEIC source decodes, then swaps to the decoded blob`, async ({ page }) => {
      let releaseSource: () => void = () => undefined
      const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve })
      const preview = svg('heic preview')
      const placeholder = svg('heic placeholder')
      const images: GalleryImage[] = [
        foldImage(0, {
          filename: 'fold-source.heic',
          src: '/fold-source.heic',
          placeholder,
          ...(withVariant ? { variants: [{ width: 256, src: preview, format: 'jpeg' }] } : {}),
        }),
        ...Array.from({ length: 5 }, (_, index) => foldImage(index + 1)),
      ]
      await page.route('**/fold-source.heic', async (route) => {
        await sourceGate
        await route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">decoded heic</text></svg>',
        })
      })
      await openFoldFixture(page, images)
      const first = page.locator('[data-diptych-frame="1"] img')
      await expect(first).toHaveAttribute('src', withVariant ? preview : placeholder)
      releaseSource()
      await expect(first).toHaveAttribute('src', /^blob:/)
      await expect.poll(() => first.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    })
  }

  test('keeps the raw wheel threshold in single mode on a one-segment shell', async ({ page }) => {
    const images = Array.from({ length: 6 }, (_, index) => foldImage(index))
    await page.route(apiPattern, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...manifest,
        manifest: { ...manifest.manifest, images },
        settings: { ...manifest.settings, defaultMode: 'single' },
      }),
    }))
    await page.goto(`${nativeUrl}/?owner=fixture&slug=fold-fixture`)
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await page.locator('[data-curtain]').click()
    const seq = page.locator('.stage-seq')
    await expect(seq).toHaveAttribute('aria-label', seqLabel(1))
    await expect(page.locator('[data-diptych-stage]')).toHaveCount(0)
    await page.evaluate(() => {
      document.querySelector('[data-stage]')?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 1, deltaMode: 1, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(300)
    await expect(seq).toHaveAttribute('aria-label', seqLabel(1))
    await page.evaluate(() => {
      document.querySelector('[data-stage]')?.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 9, deltaMode: 1, bubbles: true, cancelable: true }))
    })
    await expect(seq).toHaveAttribute('aria-label', seqLabel(2))
  })
})
