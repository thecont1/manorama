/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'
const SHAPES = ['desktop', 'phone', 'tablet'] as const

const MATRIX = [
  { name: 'phone', width: 375, height: 812, initial: 'phone' },
  { name: 'tablet', width: 768, height: 1024, initial: 'tablet' },
  { name: 'laptop', width: 1440, height: 900, initial: 'desktop' },
  { name: 'wide', width: 2560, height: 1440, initial: 'desktop' },
]

const open = async (page: Page, width = 1440, height = 900) => {
  await page.setViewportSize({ width, height })
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
  await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-fitted', 'true')
  await expect(page.locator('[data-demo-controls]')).toBeVisible()
}

const transform = (page: Page) =>
  page.locator('[data-demo-strip]').evaluate((el) => (el as HTMLElement).style.transform)

const offset = async (page: Page) => {
  const value = await transform(page)
  return Number(/translate3d\((-?[\d.]+)px/.exec(value)?.[1] ?? 0)
}

const visiblePhotoIds = (page: Page) => page.locator('[data-demo-screen]').evaluate((viewport) => {
  const view = viewport.getBoundingClientRect()
  return [...viewport.querySelectorAll<HTMLElement>('[data-photo-id]')]
    .filter((item) => !item.hidden)
    .filter((item) => {
      const box = item.getBoundingClientRect()
      return box.right > view.left + 1 && box.left < view.right - 1
    })
    .map((item) => item.dataset.photoId || '')
})

const centredPhotoId = (page: Page) => page.locator('[data-demo-screen]').evaluate((viewport) => {
  const view = viewport.getBoundingClientRect()
  const centre = view.left + view.width / 2
  const item = [...viewport.querySelectorAll<HTMLElement>('[data-photo-id]')].find((candidate) => {
    const box = candidate.getBoundingClientRect()
    return !candidate.hidden && box.left <= centre && box.right > centre
  })
  return item?.dataset.photoId || ''
})

const pause = async (page: Page) => {
  const button = page.locator('[data-demo-pause]')
  if ((await button.textContent()) === 'Pause') await button.click()
  await expect(button).toHaveText('Resume')
}

test.describe('the mounted homepage photo demo', () => {
  for (const viewport of MATRIX) {
    test(`every device and control fits at ${viewport.width}px`, async ({ page }) => {
      await open(page, viewport.width, viewport.height)
      const root = page.locator('[data-demo-stage]')
      await expect(root).toHaveAttribute('data-demo-preset', viewport.initial)
      await expect(page.locator('.home-signin-title')).toHaveCount(0)

      for (const shape of SHAPES) {
        const button = page.locator(`[data-shape="${shape}"]`)
        await button.click()
        await expect(root).toHaveAttribute('data-demo-preset', shape)
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await page.waitForTimeout(500)
        const boxes = await page.evaluate(() => {
          const stage = document.querySelector('[data-demo-viewport]')!.getBoundingClientRect()
          const device = document.querySelector('[data-demo-device]')!.getBoundingClientRect()
          const controls = document.querySelector('[data-demo-controls]')!.getBoundingClientRect()
          return {
            stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
            device: { left: device.left, right: device.right, top: device.top, bottom: device.bottom },
            controlsTop: controls.top,
          }
        })
        expect(boxes.device.left).toBeGreaterThanOrEqual(boxes.stage.left - 1)
        expect(boxes.device.right).toBeLessThanOrEqual(boxes.stage.right + 1)
        expect(boxes.device.top).toBeGreaterThanOrEqual(boxes.stage.top - 1)
        expect(boxes.device.bottom).toBeLessThanOrEqual(boxes.stage.bottom + 1)
        expect((boxes.device.left + boxes.device.right) / 2).toBeCloseTo((boxes.stage.left + boxes.stage.right) / 2, 0)
        expect(boxes.controlsTop).toBeGreaterThanOrEqual(boxes.stage.bottom - 1)
        const hit = await button.evaluate((el) => {
          const box = el.getBoundingClientRect()
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === el
        })
        expect(hit).toBe(true)
      }

      await page.locator('[data-demo-pause]').click()
      await expect(page.locator('[data-demo-pause]')).toHaveText('Resume')
      await page.locator('[data-demo-pause]').click()
      await expect(page.locator('[data-demo-pause]')).toHaveText('Pause')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }

  test('every shape contains the same flush, honest Manorama strip', async ({ page }) => {
    await open(page)
    await pause(page)

    for (const shape of SHAPES) {
      await page.locator(`[data-shape="${shape}"]`).click()
      await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', shape)
      await page.waitForTimeout(500)
      const geometry = await page.locator('[data-demo-screen]').evaluate((viewport) => {
        const view = viewport.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        return {
          background: getComputedStyle(viewport).backgroundColor,
          viewportHeight: view.height,
          laptopBases: viewport.parentElement!.querySelectorAll('.home-demo-laptop-base').length,
          items: [...viewport.querySelectorAll<HTMLElement>('[data-photo-id]')].map((item) => {
            const image = item.querySelector('img')!
            const box = image.getBoundingClientRect()
            const slot = item.getBoundingClientRect()
            return {
              slotLeft: slot.left,
              slotRight: slot.right,
              slotWidth: slot.width,
              slotHeight: slot.height,
              margin: getComputedStyle(item).margin,
              width: box.width,
              height: box.height,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              sourceRatio: Number(image.getAttribute('width')) / Number(image.getAttribute('height')),
              objectFit: getComputedStyle(image).objectFit,
              dpr,
            }
          }),
        }
      })

      expect(geometry.background).toBe('rgb(10, 10, 10)')
      expect(geometry.laptopBases).toBe(shape === 'desktop' ? 1 : 0)
      for (const [index, item] of geometry.items.entries()) {
        expect(item.margin).toBe('0px')
        expect(item.slotWidth).toBeCloseTo(item.width, 0)
        expect(item.slotHeight).toBeCloseTo(geometry.viewportHeight, 0)
        expect(item.height).toBeLessThanOrEqual(geometry.viewportHeight + 1)
        expect(Math.abs(item.width / item.height - item.sourceRatio)).toBeLessThan(0.002)
        expect(item.objectFit).not.toBe('cover')
        if (index > 0) expect(item.slotLeft).toBeCloseTo(geometry.items[index - 1]!.slotRight, 0)
        if (item.naturalWidth > 0) {
          expect(item.width * item.dpr, `${shape} image ${index} width`).toBeLessThanOrEqual(item.naturalWidth + 1)
          expect(item.height * item.dpr, `${shape} image ${index} height`).toBeLessThanOrEqual(item.naturalHeight + 1)
        }
      }
    }
  })

  test('the opening curtain and temporary chrome reproduce the viewer anatomy', async ({ page }) => {
    await open(page)
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-phase', 'curtain')
    const curtain = page.locator('[data-demo-curtain]')
    await expect(curtain).toBeVisible()
    await expect(curtain.locator('.curtain-title')).toHaveText('italia, amore mio')
    await expect(curtain.locator('.curtain-caption')).toHaveText('family trip to Italy in October 2018')
    await expect(curtain.locator('.curtain-count')).toHaveText('15 photographs')
    await expect(curtain.locator('.curtain-mark')).toBeVisible()
    expect(await curtain.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur(28px)')
    await expect(page.locator('[data-demo-chrome-top]')).toContainText('Library')
    await expect(page.locator('[data-demo-position]')).toHaveText('1 of 15')
    await expect(page.locator('[data-demo-chrome-bottom]')).toContainText('Settings')
    await expect(page.locator('[data-demo-chrome-bottom]')).toContainText('Info')
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-chrome', 'hidden')
  })

  test('shape changes preserve the photograph while paused and during travel', async ({ page }) => {
    await open(page)
    await pause(page)

    for (const shape of ['phone', 'tablet', 'desktop'] as const) {
      const anchor = await centredPhotoId(page)
      await page.locator(`[data-shape="${shape}"]`).click()
      await expect.poll(() => visiblePhotoIds(page)).toContain(anchor)
    }

    await page.locator('[data-demo-pause]').click()
    const movingTransform = await transform(page)
    await expect.poll(() => transform(page)).not.toBe(movingTransform)
    const movingAnchor = await centredPhotoId(page)
    await page.locator('[data-shape="phone"]').click()
    await expect.poll(() => visiblePhotoIds(page)).toContain(movingAnchor)

    for (const shape of ['tablet', 'desktop', 'phone'] as const) {
      await page.locator(`[data-shape="${shape}"]`).click()
    }
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', 'phone')
    await expect(page.locator('[data-demo-strip]')).toHaveCount(1)
  })

  test('the count advances, chrome recedes, and the end card returns before a slow reverse', async ({ page }) => {
    test.setTimeout(100_000)
    await open(page)
    const root = page.locator('[data-demo-stage]')
    await expect(page.locator('[data-demo-position]')).not.toHaveText('1 of 15', { timeout: 15_000 })
    await expect(root).toHaveAttribute('data-demo-chrome', 'hidden', { timeout: 8_000 })
    await expect(root).toHaveAttribute('data-demo-phase', 'end', { timeout: 50_000 })
    await expect(page.locator('[data-demo-position]')).toHaveText('15 of 15')
    await expect(root).toHaveAttribute('data-demo-chrome', 'visible')
    await expect(page.locator('[data-demo-endcard]')).toContainText('The End.')
    const end = await page.evaluate(() => {
      const screen = document.querySelector('[data-demo-screen]')!.getBoundingClientRect()
      const card = document.querySelector('[data-demo-endcard]')!.getBoundingClientRect()
      return { screenRight: screen.right, cardRight: card.right }
    })
    expect(end.cardRight).toBeLessThanOrEqual(end.screenRight + 1)
    const endOffset = await offset(page)

    await expect(root).toHaveAttribute('data-demo-phase', 'travel', { timeout: 5_000 })
    await expect.poll(() => offset(page), { timeout: 8_000 }).toBeGreaterThan(endOffset + 100)
    await expect(root).toHaveAttribute('data-demo-phase', 'curtain', { timeout: 50_000 })
    await expect(page.locator('[data-demo-curtain]')).toBeVisible()
    expect(await offset(page)).toBe(0)
    await expect(root).toHaveAttribute('data-demo-phase', 'travel', { timeout: 5_000 })
  })

  test('pause survives scrolling, and automatic playback stops off screen', async ({ page }) => {
    await open(page)
    const initial = await transform(page)
    await expect.poll(() => transform(page)).not.toBe(initial)
    await pause(page)
    const frozen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(frozen)

    await page.locator('.home-footer').scrollIntoViewIfNeeded()
    await page.locator('[data-demo-stage]').scrollIntoViewIfNeeded()
    expect(await transform(page)).toBe(frozen)
    await expect(page.locator('[data-demo-pause]')).toHaveText('Resume')
    await page.locator('[data-demo-pause]').click()
    await expect.poll(() => transform(page)).not.toBe(frozen)

    await page.locator('.home-footer').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const offscreen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(offscreen)
    await page.locator('[data-demo-stage]').scrollIntoViewIfNeeded()
    await expect.poll(() => transform(page)).not.toBe(offscreen)
  })

  test('the pictorial viewer is inert and page scrolling works over it', async ({ page }) => {
    await open(page)
    await pause(page)
    const frozen = await transform(page)
    const url = page.url()
    const stage = page.locator('[data-demo-viewport]')
    const screen = page.locator('[data-demo-screen]')
    await expect(stage).toHaveAttribute('role', 'img')
    await expect(stage).toHaveAttribute('aria-label', 'A self-running Manorama gallery of Italy photographs inside a device frame, with an opening curtain, temporary controls, and an end card.')
    await expect(screen).toHaveAttribute('aria-hidden', 'true')
    await expect(screen).toHaveAttribute('inert', '')
    await expect(screen.locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(0)
    await expect(page.locator('.home-demo button')).toHaveCount(4)
    expect(await stage.evaluate((el) => getComputedStyle(el).cursor)).toBe('default')
    const box = await stage.boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 500)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    expect(await transform(page)).toBe(frozen)

    await stage.scrollIntoViewIfNeeded()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    expect(await transform(page)).toBe(frozen)

    const dragged = await stage.boundingBox()
    await page.mouse.move(dragged!.x + dragged!.width * 0.7, dragged!.y + dragged!.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragged!.x + dragged!.width * 0.3, dragged!.y + dragged!.height / 2, { steps: 6 })
    await page.mouse.up()
    expect(await transform(page)).toBe(frozen)

    await page.mouse.click(dragged!.x + dragged!.width / 2, dragged!.y + dragged!.height / 2)
    expect(page.url()).toBe(url)
  })

  test('reduced motion is a still strip with visible controls', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    const button = page.locator('[data-demo-pause]')
    await expect(button).toBeDisabled()
    await expect(button).toHaveText('Paused')
    await expect(page.locator('[data-demo-curtain]')).toBeHidden()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-chrome', 'visible')
    const frozen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(frozen)

    await page.locator('[data-shape="tablet"]').click()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', 'tablet')
    expect(await transform(page)).toBe(frozen)

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(button).toBeEnabled()
    await expect(button).toHaveText('Pause')
    await expect.poll(() => transform(page)).not.toBe(frozen)
  })

  test('the demo makes only same-origin requests', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await open(page)
    await page.waitForTimeout(1500)
    const origin = new URL(BASE).origin
    expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([])
  })
})

test.describe('the demo static and failure states', () => {
  test('the first photograph and provider menu work without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport)
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'false')
      await expect(page.locator('[data-demo-controls]')).toBeHidden()
      await expect(page.locator('.home-demo-static')).toBeVisible()
      const first = page.locator('.home-demo-static img')
      await expect(first).toBeVisible()
      await expect.poll(() => first.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await expect(page.locator('h1')).toBeVisible()
      await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
      await page.locator('.home-signin-header > summary').click()
      await expect(page.locator('.home-signin-list a')).toHaveCount(3)
      await expect(page.locator('.home-signin-list a').first()).toBeVisible()
    }
    await context.close()
  })

  test('blocking island enhancement leaves the static photograph and native disclosures', async ({ page }) => {
    await page.route('**/app/client.ts*', (route) => route.abort())
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'false')
    await expect(page.locator('[data-demo-controls]')).toBeHidden()
    await expect(page.locator('.home-demo-static img')).toBeVisible()
    await page.locator('.home-signin-header > summary').click()
    await expect(page.locator('.home-signin-list a').first()).toBeVisible()
    await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
  })

  test('blocking every demo image hides the controls and broken photographs', async ({ page }) => {
    await page.route('**/home-demo/**', (route) => route.abort())
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
    await expect(page.locator('[data-demo-controls]')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.home-demo-item:visible')).toHaveCount(0)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
    await page.locator('.home-signin-header > summary').click()
    await expect(page.locator('.home-signin-list a').first()).toBeVisible()
  })
})
